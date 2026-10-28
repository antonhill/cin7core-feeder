import "server-only";
// Projects - variation BILLING persistence. LOCAL ONLY: no Cin7, no fetch (pinned by no-cin7-write.test.ts). Every query is org-scoped.
//
// An APPROVED variation is billed through its own BILLING PROJECT (a child of the BASE project, migration 0105). That project reuses the
// unmodified claim engine, progress, approvals and Cin7 posting machinery, and carries exactly one VARIATION Cin7 Sale. Consolidated
// reporting is a read over the parent and its billing projects. Nothing here creates or changes a Cin7 document.
import type { createServiceRoleClient } from "@/supabase/server";
import { checkSchedule } from "./claim-engine";
import { loadProjectView } from "./project-store";
import type { ProjectView } from "./project-view";
import { scheduleToStages, validateVariationSchedule, type ScheduleStageInput } from "./variation-schedule";

type Db = ReturnType<typeof createServiceRoleClient>;
const fail = (m: string): never => { throw new Error(m); };

export interface VariationStageRow { id: string; variation_id: string; sort_order: number; name: string; bps: number }

export async function listVariationStages(db: Db, orgId: string, variationId: string): Promise<VariationStageRow[]> {
  const r = await db.from("project_variation_stages").select("*").eq("org_id", orgId).eq("variation_id", variationId);
  if (r.error) {
    if (/does not exist|schema cache/i.test(r.error.message)) return []; // deploy-order safety (migration 0105 not applied yet)
    fail(`load variation schedule: ${r.error.message}`);
  }
  return ((r.data ?? []) as VariationStageRow[]).sort((a, b) => a.sort_order - b.sort_order);
}

async function loadVariation(db: Db, orgId: string, projectId: string, variationId: string) {
  const v = await db.from("project_variations").select("id, code, title, amount_cents, status, project_id").eq("org_id", orgId).eq("project_id", projectId).eq("id", variationId).maybeSingle();
  if (v.error) fail(v.error.message);
  if (!v.data) fail("Variation not found in this project.");
  return v.data as { id: string; code: string; title: string; amount_cents: number; status: string; project_id: string };
}

/** Writes a variation's billing schedule while it is DRAFT (default: one 100% stage). Replaces any earlier draft schedule. */
export async function saveDraftSchedule(db: Db, orgId: string, projectId: string, variationId: string, stages: readonly ScheduleStageInput[]): Promise<void> {
  const check = validateVariationSchedule(stages);
  if (!check.ok) fail(check.error);
  const v = await loadVariation(db, orgId, projectId, variationId);
  if (v.status !== "DRAFT") fail(`A ${v.status} variation's schedule is frozen. Use a controlled amendment.`);
  const del = await db.from("project_variation_stages").delete().eq("org_id", orgId).eq("variation_id", variationId);
  if (del.error) fail(`replace schedule: ${del.error.message}`);
  const ins = await db.from("project_variation_stages").insert(stages.map((s, i) => ({ org_id: orgId, variation_id: variationId, sort_order: i + 1, name: s.name.trim(), bps: s.bps }))).select("id");
  if (ins.error) fail(`save schedule: ${ins.error.message}`);
}

/**
 * The CONTROLLED amendment of an APPROVED variation's schedule (also how a variation approved before schedules existed, such as V001,
 * first receives one - always an explicit manager action, never automatic). The database function audits it, rebalances the billing
 * project's stages in the same transaction, and refuses once the billing project has any claim or progress.
 */
export async function amendVariationSchedule(
  db: Db, gates: { isManager: boolean }, email: string,
  input: { orgId: string; projectId: string; variationId: string; stages: readonly ScheduleStageInput[]; reason: string },
): Promise<void> {
  if (!gates.isManager) fail("Only a manager (org owner/admin) can amend a variation's billing schedule.");
  if (!input.reason.trim()) fail("A reason is required to amend a billing schedule.");
  const check = validateVariationSchedule(input.stages);
  if (!check.ok) fail(check.error);
  const v = await loadVariation(db, input.orgId, input.projectId, input.variationId);
  if (v.status !== "APPROVED") fail("Only an APPROVED variation's schedule is amended; a DRAFT is simply edited.");
  const r = await db.rpc("amend_variation_schedule", {
    p_org: input.orgId, p_variation: input.variationId, p_stages: input.stages.map((s) => ({ name: s.name.trim(), bps: s.bps })), p_reason: input.reason.trim(), p_email: email,
  });
  if (r.error) fail(r.error.message);
}

/**
 * Creates the BILLING PROJECT for ONE approved variation: its own stages (the schedule's percentages split into cents, summing exactly to
 * the approved amount), the parent's customer/tax/instance, then ACTIVE. Idempotent by the database's one-per-variation unique index:
 * a second call returns the existing project rather than creating another. Never touches the variation or the parent.
 */
export async function createVariationBillingProject(
  db: Db, gates: { isManager: boolean }, email: string,
  input: { orgId: string; projectId: string; variationId: string },
): Promise<{ billingProjectId: string; created: boolean }> {
  if (!gates.isManager) fail("Only a manager (org owner/admin) can start variation billing.");
  const v = await loadVariation(db, input.orgId, input.projectId, input.variationId);
  if (v.status !== "APPROVED") fail(`Only an APPROVED variation can be billed (this one is ${v.status}).`);
  const existing = await db.from("projects").select("id").eq("org_id", input.orgId).eq("variation_id", input.variationId).maybeSingle();
  if (existing.error) fail(existing.error.message);
  if (existing.data) return { billingProjectId: (existing.data as { id: string }).id, created: false };

  const parentQ = await db.from("projects").select("*").eq("org_id", input.orgId).eq("id", input.projectId).maybeSingle();
  if (parentQ.error) fail(parentQ.error.message);
  const parent = parentQ.data as Record<string, unknown> | null;
  if (!parent) fail("Project not found.");
  const p = parent as Record<string, unknown>;
  if (p.status !== "ACTIVE") fail("The project must be ACTIVE to bill a variation.");
  if (p.billing_scope && p.billing_scope !== "BASE") fail("A variation billing project cannot itself carry variations.");

  const schedule = await listVariationStages(db, input.orgId, input.variationId);
  if (schedule.length === 0) fail("This variation has no billing schedule yet. A manager must set one (controlled amendment) before billing can start.");
  const stages = scheduleToStages(v.amount_cents, schedule.map((s) => ({ name: s.name, bps: s.bps })));
  checkSchedule(v.amount_cents, stages.map((s, i) => ({ id: String(i), name: s.name, valueCents: s.valueCents })));

  const ins = await db.from("projects").insert({
    org_id: input.orgId, instance_id: p.instance_id, project_reference: `${p.project_reference as string}-${v.code}`, name: `${p.name as string} - ${v.code} ${v.title}`,
    cin7_customer_id: p.cin7_customer_id, customer_name: p.customer_name, originating_quote_ref: p.originating_quote_ref, originating_quote_id: p.originating_quote_id,
    original_contract_cents: v.amount_cents, currency: p.currency, tax_rule: p.tax_rule, tax_rate_bps: p.tax_rate_bps, tax_inclusive: p.tax_inclusive,
    salesperson: p.salesperson, project_manager: p.project_manager, status: "DRAFT",
    billing_scope: "VARIATION", parent_project_id: input.projectId, variation_id: input.variationId,
    baseline_snapshot: { kind: "VARIATION_BILLING", variationId: v.id, variationCode: v.code, parentProjectId: input.projectId, schedule: stages },
    created_by_email: email,
  }).select("id").single();
  if (ins.error || !ins.data) fail(`create variation billing project: ${ins.error?.message ?? "no row"}`);
  const billingProjectId = (ins.data as { id: string }).id;
  const st = await db.from("project_stages").insert(stages.map((s, i) => ({ org_id: input.orgId, project_id: billingProjectId, sort_order: i + 1, name: s.name, description: null, value_cents: s.valueCents }))).select("id");
  if (st.error) fail(`create variation stages: ${st.error.message}`);
  const act = await db.from("projects").update({ status: "ACTIVE" }).eq("org_id", input.orgId).eq("id", billingProjectId);
  if (act.error) fail(`activate variation billing project: ${act.error.message}`);
  return { billingProjectId, created: true };
}

// ── consolidation (READ-ONLY) ───────────────────────────────────────────────

export interface ScopeSummary {
  scope: "BASE" | "VARIATION";
  projectId: string;
  projectReference: string;
  variationCode: string | null;
  contractCents: number;
  earnedCents: number;
  committedCents: number;
  claimableCents: number;
  remainingCents: number;
}
export interface ConsolidatedProject {
  base: ProjectView;
  scopes: ScopeSummary[];
  /** Approved variations that have no billing project yet (not yet billable). */
  unbilledApprovedVariations: Array<{ id: string; code: string; amountCents: number }>;
  totals: { contractCents: number; earnedCents: number; committedCents: number; claimableCents: number; remainingCents: number };
}

/**
 * BASE project plus its variation billing projects, summed. `contractCents` for the whole project is the BASE original contract plus the
 * variations that HAVE a billing project; an approved variation with no billing project is listed separately, never silently included
 * in billable figures and never lost from the revised contract shown on the BASE view.
 */
export async function loadConsolidatedProject(db: Db, orgId: string, projectId: string): Promise<ConsolidatedProject | null> {
  const base = await loadProjectView(db, orgId, projectId);
  if (!base) return null;
  if ((base.project as { billing_scope?: string }).billing_scope === "VARIATION") fail("Load the BASE project; this is a variation billing project.");
  const kids = await db.from("projects").select("id").eq("org_id", orgId).eq("parent_project_id", projectId);
  if (kids.error) {
    if (!/does not exist|schema cache|column/i.test(kids.error.message)) fail(`load variation billing projects: ${kids.error.message}`);
  }
  const childIds = ((kids.data ?? []) as Array<{ id: string }>).map((k) => k.id);
  const children: ProjectView[] = [];
  for (const id of childIds) { const v = await loadProjectView(db, orgId, id); if (v) children.push(v); }

  const summary = (view: ProjectView, scope: "BASE" | "VARIATION", code: string | null): ScopeSummary => ({
    scope, projectId: view.project.id, projectReference: view.project.project_reference, variationCode: code,
    contractCents: view.commercial.originalContractCents,
    earnedCents: view.commercial.earnedCents, committedCents: view.commercial.committedCents,
    claimableCents: view.commercial.claimableCents, remainingCents: view.commercial.remainingCents,
  });
  const byVar = new Map(base.variations.map((v) => [v.id, v]));
  const scopes: ScopeSummary[] = [
    summary(base, "BASE", null),
    ...children.map((c) => summary(c, "VARIATION", byVar.get((c.project as { variation_id?: string }).variation_id ?? "")?.code ?? null)),
  ];
  const billed = new Set(children.map((c) => (c.project as { variation_id?: string }).variation_id));
  const unbilledApprovedVariations = base.variations.filter((v) => v.status === "APPROVED" && !billed.has(v.id)).map((v) => ({ id: v.id, code: v.code, amountCents: v.amount_cents }));
  const sum = (f: (s: ScopeSummary) => number) => scopes.reduce((n, s) => n + f(s), 0);
  return {
    base, scopes, unbilledApprovedVariations,
    totals: { contractCents: sum((s) => s.contractCents), earnedCents: sum((s) => s.earnedCents), committedCents: sum((s) => s.committedCents), claimableCents: sum((s) => s.claimableCents), remainingCents: sum((s) => s.remainingCents) },
  };
}
