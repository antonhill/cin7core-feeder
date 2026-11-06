// Synthetic fixtures for the Executive Overview tests. SHAPED like the demo project (a fully billed original project with a draft-invoice history and
// a billed commercial-only variation) but containing no customer data. Built through the REAL buildProjectView so claim and commitment arithmetic is
// the production arithmetic, not a copy of it.
import { buildProjectView, type ClaimRow, type ProjectRow, type ProjectView, type ProgressEventRow, type StageRow } from "../project-view";
import type { ClaimPostingRow } from "../claim-cin7-status";
import type { OverviewInput, OverviewScopeInput, PhysicalSectionInput } from "../overview-model";
import type { PhysicalRow } from "../physical-status";
import type { VariationRow } from "../variations";

export const R = (rands: number): number => Math.round(rands * 100);

export function project(over: Partial<ProjectRow> & { id: string; project_reference: string; original_contract_cents: number }): ProjectRow {
  return {
    org_id: "org", name: "Test Farm", customer_name: "Synthetic Customer", originating_quote_ref: "NQ-Q-TEST", currency: "ZAR", tax_rule: "Standard Rate Sales", tax_rate_bps: 1500,
    salesperson: null, project_manager: null, start_date: null, target_completion_date: null, status: "ACTIVE", billing_scope: "BASE", parent_project_id: null, variation_id: null, ...over,
  };
}
export const stage = (id: string, order: number, name: string, valueCents: number): StageRow => ({ id, sort_order: order, name, description: null, value_cents: valueCents });
export const progress = (stageId: string, reportedBps: number, approvedBps: number): ProgressEventRow => ({
  id: `ev-${stageId}`, stage_id: stageId, reported_bps: reportedBps, approved_bps: approvedBps, previous_reported_bps: null, previous_approved_bps: null, comment: null, recorded_by_email: "m@x", created_at: "2026-11-01T10:00:00Z",
});
/** Claim at ex-VAT `subtotal`, with 15% VAT added so a test that mixes up the two columns gets a different number. */
export function claim(id: string, seq: number, status: string, subtotalCents: number): ClaimRow {
  const tax = Math.round(subtotalCents * 0.15);
  return { id, claim_seq: seq, claim_number: `C${String(seq).padStart(2, "0")}`, claim_date: "2026-11-01", status, subtotal_cents: subtotalCents, tax_cents: tax, total_cents: subtotalCents + tax };
}
export const posting = (claimId: string, state: string, invoice: string | null, cin7: string | null, reconciled: boolean, err: string | null = null): ClaimPostingRow => ({
  claim_id: claimId, posting_state: state, cin7_invoice_number: invoice, cin7_status: cin7, reconciled_at: reconciled ? "2026-11-01T12:00:00Z" : null, last_error_message: err,
});

export interface ScopeSpec {
  project: ProjectRow;
  stages: StageRow[];
  events?: ProgressEventRow[];
  claims?: ClaimRow[];
  /** claim id -> stage id -> cents (defaults to the whole claim on the first stage) */
  lines?: Array<{ claim_id: string; stage_id: string; current_claim_cents: number }>;
  postings?: ClaimPostingRow[];
  variations?: VariationRow[];
  approvals?: Array<{ claimId: string; requestId: string; stage: string | null; stageRole: string | null; assignedToEmail: string | null }>;
}
export function view(spec: ScopeSpec): ProjectView {
  const claims = spec.claims ?? [];
  return buildProjectView({
    project: spec.project, stages: spec.stages, events: spec.events ?? [], claims,
    claimLines: spec.lines ?? claims.map((c) => ({ claim_id: c.id, stage_id: spec.stages[0].id, current_claim_cents: c.subtotal_cents })),
    allocations: [], links: [], postings: spec.postings ?? [], approvals: spec.approvals ?? [], variations: spec.variations ?? [],
  });
}
export function scope(spec: ScopeSpec & { label?: string; saleNumber?: string | null; blockers?: string[]; variationCode?: string | null }): OverviewScopeInput {
  return {
    projectId: spec.project.id, scope: spec.project.billing_scope === "VARIATION" ? "VARIATION" : "BASE", label: spec.label ?? (spec.project.billing_scope === "VARIATION" ? "V001 variation" : "Original contract"),
    variationCode: spec.variationCode ?? null, saleNumber: spec.saleNumber === undefined ? "SO-1" : spec.saleNumber, view: view(spec), scopeBlockers: spec.blockers ?? [],
  };
}
export const approvedVariation = (amountCents: number, cost: number | null = null): VariationRow => ({
  id: "var-1", code: "V001", title: "Extra", description: null, amount_cents: amountCents, estimated_cost_cents: cost, status: "APPROVED", raised_by_email: "a@x", priced_by_email: null, decided_by_email: "m@x", decided_at: "2026-11-01T09:00:00Z", decision_reason: null, created_at: "2026-11-01T08:00:00Z",
});
export const physRow = (sku: string, over: Partial<PhysicalRow> = {}): PhysicalRow => ({
  sku, name: `Product ${sku}`, quoted: 10, ordered: 10, invoiced: 0, shipped: 4, remaining: 6, remainingToInvoice: 10, remainingToDeliver: 6, onHand: 20, allocatedAllOrders: 15, available: 5, shortfall: 1,
  assemblyInProgress: null, assemblyCompleted: null, hasAssemblyRecords: false, ...over,
});
export const physSection = (rows: PhysicalRow[], over: Partial<PhysicalSectionInput> = {}): PhysicalSectionInput => ({ label: "Original contract", scope: "BASE", linked: true, saleNumber: "SO-1", rows, exceptions: [], scopeBlockers: [], ...over });

/**
 * The demo-shaped project. Original contract R10,072,000 in three stages, FULLY billed by four approved claims (three reconciled DRAFT invoices and
 * one created-but-unreconciled), plus a cancelled claim that must be ignored; and a R500,000 commercial-only variation, billed and reconciled.
 * Cost rows are NOT set here (the estimates input carries them).
 */
export function demoInput(over: Partial<OverviewInput> = {}): OverviewInput {
  const base = project({ id: "p-base", project_reference: "PRJ-T-0001", original_contract_cents: R(10_072_000) });
  const stages = [stage("s-dep", 1, "Deposit", R(4_028_800)), stage("s-del", 2, "Delivery", R(5_539_600)), stage("s-ins", 3, "Installation", R(503_600))];
  const claims = [claim("c1", 1, "APPROVED", R(4_028_800)), claim("c2", 2, "CANCELLED_BEFORE_WRITE", R(5_262_620)), claim("c3", 3, "APPROVED", R(5_262_620)), claim("c4", 4, "APPROVED", R(276_980)), claim("c5", 5, "APPROVED", R(503_600))];
  const lines = [
    { claim_id: "c1", stage_id: "s-dep", current_claim_cents: R(4_028_800) }, { claim_id: "c2", stage_id: "s-del", current_claim_cents: R(5_262_620) },
    { claim_id: "c3", stage_id: "s-del", current_claim_cents: R(5_262_620) }, { claim_id: "c4", stage_id: "s-del", current_claim_cents: R(276_980) }, { claim_id: "c5", stage_id: "s-ins", current_claim_cents: R(503_600) },
  ];
  const events = stages.map((s) => progress(s.id, 10_000, 10_000));
  const postings = [posting("c1", "RECONCILED", "INV-1", "DRAFT", true), posting("c3", "RECONCILED", "INV-3", "DRAFT", true), posting("c4", "RECONCILED", "INV-4", "DRAFT", true), posting("c5", "CREATED", "INV-5", "DRAFT", false)];
  const varProject = project({ id: "p-var", project_reference: "PRJ-T-0001-V001", original_contract_cents: R(500_000), billing_scope: "VARIATION", parent_project_id: "p-base", variation_id: "var-1" });
  const varStages = [stage("v-s1", 1, "Variation", R(500_000))];
  return {
    scopes: [
      scope({ project: base, stages, events, claims, lines, postings, variations: [approvedVariation(R(500_000))], saleNumber: "SO-27" }),
      scope({ project: varProject, stages: varStages, events: [progress("v-s1", 10_000, 10_000)], claims: [claim("vc1", 1, "APPROVED", R(500_000))], postings: [posting("vc1", "RECONCILED", "INV-V1", "DRAFT", true)], saleNumber: "SO-28", variationCode: "V001" }),
    ],
    unbilledApprovedVariations: [], deliveries: { total: 2, dispatched: 1, inProgress: 1, cancelled: 0, latestActivityAt: "2026-11-01T15:30:00Z" },
    physical: { state: "not_loaded" }, estimates: null, viewer: { isAdmin: true }, ...over,
  };
}
