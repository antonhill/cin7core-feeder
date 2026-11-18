import "server-only";
// NewQuip Reports: READ-ONLY, organisation-scoped loaders (service-role client passed in by an authorised caller; every query filters org_id explicitly and orders on a unique key so
// paging is deterministic). The OPERATIONAL loader selects explicit non-commercial columns, so a Sales Rep's report can never carry a draft, baseline, cost or margin. The COSTING loader
// is the only place that reads `draft` / `accepted_baseline`, and it refuses to run unless the caller's cost entitlement was established.
import type { createServiceRoleClient } from "@/supabase/server";
import { fetchAllRows } from "@/supabase/fetch-all-rows";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { evaluationContext } from "@/lib/newquip-quotes/context";
import { quoteScopeView } from "@/lib/newquip-quotes/scope-preview";
import { libraryOf, listActiveMappings } from "@/lib/projects/package-mapping-store";
import type { AcceptedBaseline } from "@/newquip/quote/baseline";
import type { QuoteDraft } from "@/newquip/grower/draft";
import type { ReportApproval, ReportData, ReportDocument, ReportProject, ReportQuote, ReportResponse, ReportReview, ReportSend } from "./ops";
import { costingRowOf, type CostingRow, type CostingSource } from "./costing-model";

type Db = ReturnType<typeof createServiceRoleClient>;
const missing = (m: string | undefined) => /does not exist|schema cache|could not find the table|column .* does not exist/i.test(m ?? "");

const QUOTE_COLS = "id, quote_ref, revision, customer_name, site_name, state, draft_hash, estimator_signoff_hash, estimator_signoff_by_email, estimator_signoff_at, customer_confirmed_cents, customer_confirmed_at, handoff_by_email, approved_by_email, approved_at, contract_cents, project_id, requires_customer_acceptance, created_by_email, created_at";

async function rows<T>(label: string, q: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, tolerant = false): Promise<T[]> {
  try { return await fetchAllRows<T>(label, q as never); } catch (e) { if (tolerant && missing(e instanceof Error ? e.message : "")) return []; throw e; }
}

export async function loadOperationalData(db: Db, orgId: string): Promise<ReportData> {
  const [quotes, approvals, documents, sends, responses, reviews, evidence, projects] = await Promise.all([
    rows<ReportQuote>("quotations", (f, t) => db.from("newquip_quotes").select(QUOTE_COLS).eq("org_id", orgId).order("id").range(f, t)),
    rows<ReportApproval>("approvals", (f, t) => db.from("approval_requests").select("id, doc_id, revision, status, assigned_to_email, submitted_at, decided_at, decided_by_email").eq("org_id", orgId).eq("doc_type", "QUOTE").order("id").range(f, t)),
    rows<ReportDocument>("documents", (f, t) => db.from("newquip_quote_documents").select("id, quote_id, revision, version, created_at, issued_by_email").eq("org_id", orgId).order("id").range(f, t), true),
    rows<ReportSend>("sends", (f, t) => db.from("newquip_quote_sends").select("id, quote_id, document_id, status, sent_by_email, created_at, attempted_at").eq("org_id", orgId).order("id").range(f, t), true),
    rows<ReportResponse>("responses", (f, t) => db.from("newquip_quote_responses").select("id, quote_id, document_id, response, recorded_by_email, created_at, origin, contact_source").eq("org_id", orgId).order("id").range(f, t), true),
    rows<ReportReview>("reviews", (f, t) => db.from("newquip_response_reviews").select("id, quote_id, response_id, decision, reviewed_by_email, created_at").eq("org_id", orgId).order("id").range(f, t), true),
    rows<{ id: string; response_id: string }>("evidence", (f, t) => db.from("newquip_response_evidence").select("id, response_id").eq("org_id", orgId).order("id").range(f, t), true),
    rows<ReportProject>("projects", (f, t) => db.from("projects").select("id, project_reference, name, customer_name, status, original_contract_cents, created_at, parent_project_id, billing_scope").eq("org_id", orgId).order("id").range(f, t), true),
  ]);
  const ev = new Map<string, number>(); for (const e of evidence) ev.set(e.response_id, (ev.get(e.response_id) ?? 0) + 1);
  return { quotes, approvals, documents, sends, responses, reviews, evidence: ev, projects };
}

/** Hard ceiling on quotations costed per request: each costing re-evaluates the engine. Beyond it the report says so instead of silently truncating. */
export const COSTING_CAP = 300;

/** COMMERCIAL. `entitled` must be the caller's own, already-established cost entitlement (Actor.canSeeCost); anything else is refused here as a second line of defence. */
export async function loadCostingRows(db: Db, orgId: string, entitled: { canSeeCost: boolean }, ids: readonly string[]): Promise<{ rows: CostingRow[]; truncated: boolean }> {
  if (entitled.canSeeCost !== true) throw new Error("Costing and margin reporting is restricted to Estimators and Managers.");
  const take = ids.slice(0, COSTING_CAP);
  const sources: CostingSource[] = [];
  for (let i = 0; i < take.length; i += 100) {
    const chunk = take.slice(i, i + 100);
    const r = await db.from("newquip_quotes").select("id, quote_ref, revision, customer_name, state, draft, accepted_baseline, created_at").eq("org_id", orgId).in("id", chunk).order("id");
    if (r.error) throw new Error(`load costing: ${r.error.message}`);
    sources.push(...((r.data ?? []) as unknown as CostingSource[]));
  }
  const lib = await listActiveMappings(db, orgId).catch(() => null);
  const library = lib ? libraryOf(lib) : null;
  const now = new Date().toISOString();
  const out = sources.map((s) => {
    let unmapped: number | null = null;
    try { unmapped = quoteScopeView({ finalBaseline: s.accepted_baseline as unknown as AcceptedBaseline | null, evaluation: evaluateDraft(s.draft as QuoteDraft, evaluationContext(true)), library, now }).unresolvedCount; } catch { unmapped = null; }
    return costingRowOf(s, unmapped);
  });
  return { rows: out.sort((a, b) => (a.quoteRef < b.quoteRef ? -1 : a.quoteRef > b.quoteRef ? 1 : a.id < b.id ? -1 : 1)), truncated: ids.length > COSTING_CAP };
}
