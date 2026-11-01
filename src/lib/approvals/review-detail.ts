import "server-only";
// The review workspace content for a submission: the supporting commercial details a manager needs, per document type. Read-only; internal cost
// and margin appear only because every approver is a manager (org owner/admin) and the caller passes `showInternal`. Optional sections that
// cannot be loaded say so ("unavailable") instead of being omitted silently.
import type { createServiceRoleClient } from "@/supabase/server";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { evaluationContext } from "@/lib/newquip-quotes/context";
import { loadQuote } from "@/lib/newquip-quotes/quote-store";
import { quoteScopeView } from "@/lib/newquip-quotes/scope-preview";
import { libraryOf, listActiveMappings } from "@/lib/projects/package-mapping-store";
import { buildMarginSheet } from "@/newquip/quote/margin";
import { commercialLinesOf } from "@/newquip/quote/baseline";
import { NEWQUIP_STANDARD_SCHEDULE, splitContractBySchedule } from "@/newquip/quote/billing-schedule";
import { loadProjectView } from "@/lib/projects/project-store";
import { listVariationStages } from "@/lib/projects/variation-billing-store";
import { marginFigures } from "@/lib/projects/margin-figures";
import { scopeFromSnapshot, effectiveScope } from "@/lib/projects/product-scope";
import type { ApprovalRequestRow } from "./types";

type Db = ReturnType<typeof createServiceRoleClient>;
export interface ReviewSection { title: string; rows: Array<[string, string]>; items?: string[]; warning?: string }
export interface ReviewDetail { sections: ReviewSection[] }
const rand = (c: number | null | undefined) => (c == null ? "unknown" : `R ${(c / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct = (n: number | null) => (n == null ? "unknown" : `${n.toFixed(2)}%`);
const tolerate = async <T,>(f: () => Promise<T>): Promise<T | null> => { try { return await f(); } catch { return null; } };

export async function buildReviewDetail(db: Db, orgId: string, req: ApprovalRequestRow, showInternal: boolean): Promise<ReviewDetail> {
  if (req.doc_type === "QUOTE") return quoteDetail(db, orgId, req, showInternal);
  if (req.doc_type === "CLAIM") return claimDetail(db, orgId, req);
  return variationDetail(db, orgId, req, showInternal);
}

async function quoteDetail(db: Db, orgId: string, req: ApprovalRequestRow, showInternal: boolean): Promise<ReviewDetail> {
  const q = await loadQuote(db, orgId, req.doc_id);
  if (!q) return { sections: [{ title: "Quote", rows: [["Status", "The quote could not be loaded."]] }] };
  const ev = evaluateDraft(q.draft, evaluationContext(true));
  const budget = ev.budget;
  const sections: ReviewSection[] = [{ title: "Customer and site", rows: [["Customer", q.customer_name], ["Site", q.site_name], ["Quote revision", String(q.revision)], ["Customer confirmed (ex VAT)", rand(q.customer_confirmed_cents)], ["Estimator sign-off", q.estimator_signoff_by_email ?? "-"]] }];
  if (budget) {
    sections.push({ title: "Proposed solution and commercial value", rows: [["Selling value (ex VAT)", rand(Math.round(budget.totals.subtotalExTax * 100))], ["VAT", rand(Math.round(budget.totals.taxTotal * 100))], ["Total (inc VAT)", rand(Math.round(budget.totals.totalIncTax * 100))]],
      items: commercialLinesOf(budget).map((l) => `${l.label} x ${l.quantity} - ${rand(l.revenueCents)}`) });
    if (showInternal) {
      const m = await tolerate(async () => buildMarginSheet(evaluateDraft(q.draft, evaluationContext(false)).budget!, q.draft.estimator.costOverrides ?? {}).project);
      sections.push(m ? { title: "Estimated cost and margin (internal)", rows: [["Estimated cost", m.incomplete ? `${rand(m.costCents)} (incomplete: ${m.missingCostLines.length} line(s) without a cost)` : rand(m.costCents)], ["Gross profit", rand(m.gpCents)], ["Margin", pct(m.marginPct)]] }
        : { title: "Estimated cost and margin (internal)", rows: [["Status", "unavailable"]] });
    }
    const lib = await tolerate(() => listActiveMappings(db, orgId));
    const scope = quoteScopeView({ finalBaseline: q.accepted_baseline, evaluation: ev, library: lib ? libraryOf(lib) : null, now: new Date().toISOString() });
    sections.push({ title: "Physical product mapping", rows: [["Products on the Sales Order", String(scope.saleLines.length)], ["Packages without a mapping", String(scope.unresolvedCount)]],
      items: scope.items.filter((i) => i.state === "UNRESOLVED").map((i) => `${i.description}: ${i.reason ?? "no mapping"}`),
      warning: scope.unresolvedCount > 0 ? "Unresolved mappings do not stop commercial approval, but the Cin7 Sale cannot be created until each is mapped or excluded." : undefined });
    const contract = q.customer_confirmed_cents ?? Math.round(budget.totals.subtotalExTax * 100);
    sections.push({ title: "Commercial payment schedule", rows: [["Basis", "Chosen when the project is created; the default is NewQuip 40/55/5"]], items: splitContractBySchedule(contract, NEWQUIP_STANDARD_SCHEDULE).map((s) => `${s.name}: ${rand(s.valueCents)}`) });
  } else sections.push({ title: "Proposed solution", rows: [["Status", "The quote could not be priced."]] });
  return { sections };
}

async function claimDetail(db: Db, orgId: string, req: ApprovalRequestRow): Promise<ReviewDetail> {
  const c = await db.from("project_claims").select("*").eq("org_id", orgId).eq("id", req.doc_id).maybeSingle();
  const claim = c.data as { project_id: string; claim_number: string; status: string; subtotal_cents: number; tax_cents: number; total_cents: number; tax_rate_bps: number } | null;
  if (!claim) return { sections: [{ title: "Claim", rows: [["Status", "The claim could not be loaded."]] }] };
  const view = await tolerate(() => loadProjectView(db, orgId, claim.project_id));
  const lines = await tolerate(async () => { const r = await db.from("project_claim_lines").select("stage_id, stage_name, stage_value_cents, approved_bps, current_claim_cents, tax_cents").eq("org_id", orgId).eq("claim_id", req.doc_id); return (r.data ?? []) as Array<{ stage_id: string; stage_name: string; stage_value_cents: number; approved_bps: number; current_claim_cents: number }>; });
  // Which lines are partial (separate, tolerant read: a database without migration 0120 has no such column and must still show the claim).
  const partialStages = new Set(((await tolerate(async () => { const r = await db.from("project_claim_lines").select("stage_id, partial").eq("org_id", orgId).eq("claim_id", req.doc_id); return r.error ? [] : (r.data as Array<{ stage_id: string; partial: boolean }>); })) ?? []).filter((x) => x.partial).map((x) => x.stage_id));
  const sale = await tolerate(async () => { const r = await db.from("project_cin7_sale_links").select("cin7_sale_number, link_status").eq("org_id", orgId).eq("project_id", claim.project_id).maybeSingle(); return r.data as { cin7_sale_number: string | null; link_status: string } | null; });
  const ev = await tolerate(async () => { const ids = (lines ?? []).map((l) => l.stage_id); if (!ids.length) return []; const r = await db.from("project_milestone_confirmations").select("stage_id, note, evidence_ref, confirmed_at, confirmed_by_email").eq("org_id", orgId).in("stage_id", ids); return (r.data ?? []) as Array<{ stage_id: string; note: string; evidence_ref: string | null; confirmed_at: string; confirmed_by_email: string }>; });
  const others = view?.claims.filter((x) => x.id !== req.doc_id) ?? [];
  const approvedTotal = others.filter((x) => ["APPROVED", "CIN7_PENDING", "CIN7_CREATED", "RECONCILED", "FAILED_UNCERTAIN"].includes(x.status)).reduce((n, x) => n + x.subtotal_cents, 0);
  const invoiced = others.filter((x) => ["CIN7_CREATED", "RECONCILED"].includes(x.status)).reduce((n, x) => n + x.subtotal_cents, 0);
  const sections: ReviewSection[] = [
    { title: "Claim", rows: [["Claim", claim.claim_number], ["Applies to", req.project_id && view?.project.billing_scope === "VARIATION" ? "Variation billing" : "Base contract"], ["Claim amount (ex VAT)", rand(claim.subtotal_cents)], ["VAT", rand(claim.tax_cents)], ["Total (inc VAT)", rand(claim.total_cents)]] },
    { title: "Project position", rows: view ? [["Contract value (revised)", rand(view.commercial.revisedContractCents)], ["Previously approved claims (ex VAT)", rand(approvedTotal)], ["Already invoiced in Cin7 (ex VAT)", rand(invoiced)], ["Claimable balance now", rand(view.commercial.claimableCents)], ["Remaining contract value", rand(view.commercial.remainingCents)]] : [["Status", "unavailable"]],
      items: others.map((x) => `${x.claim_number} - ${x.status} - ${rand(x.subtotal_cents)}`) },
    { title: "Billing stages in this claim", rows: [], items: (lines ?? []).map((l) => `${l.stage_name}: ${(l.approved_bps / 100).toFixed(2)}% approved of ${rand(l.stage_value_cents)} - this claim ${rand(l.current_claim_cents)}${partialStages.has(l.stage_id) ? " (PARTIAL: less than the claimable maximum; the rest stays claimable later)" : ""}`) },
    { title: "Cin7 Sale", rows: [["Linked Sale", sale ? `${sale.cin7_sale_number ?? "linked"} (${sale.link_status})` : "none yet"], ["Note", "Approving a claim authorises the commercial claim only. Posting it to Cin7 is a separate action."]] },
    { title: "Milestone evidence (informational)", rows: [], items: (ev ?? []).length ? (ev ?? []).map((e) => `${e.note}${e.evidence_ref ? ` (${e.evidence_ref})` : ""} - ${e.confirmed_by_email}`) : ["No milestone confirmation recorded. This is not a requirement for approval."] },
  ];
  return { sections };
}

async function variationDetail(db: Db, orgId: string, req: ApprovalRequestRow, showInternal: boolean): Promise<ReviewDetail> {
  const v = await db.from("project_variations").select("*").eq("org_id", orgId).eq("id", req.doc_id).maybeSingle();
  const row = v.data as { project_id: string; code: string; title: string; description: string | null; amount_cents: number; estimated_cost_cents?: number | null; status: string } | null;
  if (!row) return { sections: [{ title: "Variation", rows: [["Status", "The variation could not be loaded."]] }] };
  const view = await tolerate(() => loadProjectView(db, orgId, row.project_id));
  const stages = await tolerate(() => listVariationStages(db, orgId, req.doc_id));
  const billing = await tolerate(async () => { const r = await db.from("projects").select("id, baseline_snapshot").eq("org_id", orgId).eq("variation_id", req.doc_id).maybeSingle(); return r.data as { id: string; baseline_snapshot: unknown } | null; });
  const sale = billing ? await tolerate(async () => { const r = await db.from("project_cin7_sale_links").select("cin7_sale_number, link_status").eq("org_id", orgId).eq("project_id", billing.id).maybeSingle(); return r.data as { cin7_sale_number: string | null; link_status: string } | null; }) : null;
  const cost = row.estimated_cost_cents ?? null;
  const m = marginFigures(row.amount_cents, cost);
  const scope = billing ? effectiveScope(scopeFromSnapshot(billing.baseline_snapshot)) : null;
  const sections: ReviewSection[] = [
    { title: "Variation", rows: [["Reference", req.doc_ref], ["Title", row.title], ["Description", row.description ?? "-"], ["Commercial value adjustment (ex VAT)", rand(row.amount_cents)]] },
    { title: "Original project", rows: view ? [["Project", view.project.project_reference], ["Original contract", rand(view.commercial.originalContractCents)], ["Approved variations so far", rand(view.commercial.approvedVariationsCents)], ["Revised contract if approved", rand(view.commercial.revisedContractCents + row.amount_cents)]] : [["Status", "unavailable"]] },
    { title: "Variation payment schedule", rows: [], items: (stages ?? []).map((s) => `${s.name}: ${(s.bps / 100).toFixed(2)}% = ${rand(Math.round((row.amount_cents * s.bps) / 10_000))}`) },
    { title: "Physical scope changes", rows: [["Products", scope ? String(scope.lines.length) : "set when the variation's billing starts"]], items: scope?.lines.map((l) => `${l.sku} x ${l.quantity}`) },
    { title: "Variation Cin7 Sale", rows: [["Status", sale ? `${sale.cin7_sale_number ?? "linked"} (${sale.link_status})` : billing ? "billing project exists; no Sale yet" : "not started (billing begins after approval)"]] },
  ];
  if (showInternal) sections.splice(2, 0, { title: "Estimated cost and margin impact (internal)", rows: [["Estimated cost", rand(cost)], ["Gross profit", rand(m.gpCents)], ["Margin", pct(m.marginPct)]], warning: cost == null ? "No cost estimate: the margin is unknown, not zero." : undefined });
  return { sections };
}
