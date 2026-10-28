import "server-only";
// Persistence for direct non-stock project costs and the INDICATIVE product cost. INTERNAL: callers must have established the viewer is an org
// owner/admin. Writes only the local cost ledger; never Cin7.
import type { createServiceRoleClient } from "@/supabase/server";
import { fetchAllRows } from "@/supabase/fetch-all-rows";
import { effectiveScope, scopeFromSnapshot } from "./product-scope";
import { totalCosts, validateNewCost, type CostEntry, type CostTotals, type NewCostInput } from "./project-costs";

type Db = ReturnType<typeof createServiceRoleClient>;
function fail(message: string): never { throw new Error(message); }
const missingTable = (m: string) => /does not exist|schema cache|relation/i.test(m);

export async function listCostEntries(db: Db, orgId: string, projectId: string): Promise<CostEntry[] | null> {
  const r = await db.from("project_cost_entries").select("*").eq("org_id", orgId).eq("project_id", projectId).order("created_at", { ascending: true });
  if (r.error) { if (missingTable(r.error.message)) return null; fail(r.error.message); }
  return (r.data ?? []) as CostEntry[];
}

/** Totals for the profitability report; null (unknown, not zero) when the ledger is unavailable. */
export async function loadNonStockTotals(db: Db, orgId: string, projectId: string): Promise<{ incurredCents: number; committedCents: number } | null> {
  const e = await listCostEntries(db, orgId, projectId);
  if (e === null) return null;
  const t = totalCosts(e);
  return { incurredCents: t.incurredCents, committedCents: t.committedCents };
}

export async function loadCostLedger(db: Db, orgId: string, projectId: string): Promise<{ entries: CostEntry[]; totals: CostTotals } | null> {
  const e = await listCostEntries(db, orgId, projectId);
  return e === null ? null : { entries: e, totals: totalCosts(e) };
}

async function assertActive(db: Db, orgId: string, projectId: string) {
  const p = await db.from("projects").select("status").eq("org_id", orgId).eq("id", projectId).maybeSingle();
  if (p.error) fail(p.error.message);
  if (!p.data) fail("Project not found.");
  if ((p.data as { status: string }).status !== "ACTIVE") fail("Costs can only be recorded on an ACTIVE project.");
}

export async function addCostEntry(db: Db, input: { orgId: string; projectId: string; actor: string; cost: NewCostInput; now?: Date }): Promise<CostEntry> {
  await assertActive(db, input.orgId, input.projectId);
  const v = validateNewCost(input.cost, (input.now ?? new Date()).toISOString().slice(0, 10));
  if (!v.ok) fail(v.error);
  const ins = await db.from("project_cost_entries").insert({ org_id: input.orgId, project_id: input.projectId, recorded_by_email: input.actor, ...v.row }).select("*").single();
  if (ins.error || !ins.data) fail(`record cost: ${ins.error?.message ?? "no row"}`);
  return ins.data as CostEntry;
}

export async function markCostIncurred(db: Db, input: { orgId: string; projectId: string; entryId: string; incurredOn?: string; now?: Date }): Promise<void> {
  const today = (input.now ?? new Date()).toISOString().slice(0, 10);
  const on = input.incurredOn || today;
  if (on > today) fail("An incurred cost cannot be dated in the future.");
  const up = await db.from("project_cost_entries").update({ state: "INCURRED", incurred_on: on }).eq("org_id", input.orgId).eq("project_id", input.projectId).eq("id", input.entryId).eq("state", "COMMITTED").is("voided_at", null).select("id");
  if (up.error) fail(up.error.message);
  if (!up.data?.length) fail("Only an open COMMITTED cost can be marked incurred.");
}

export async function voidCostEntry(db: Db, input: { orgId: string; projectId: string; entryId: string; actor: string; reason: string; now?: Date }): Promise<void> {
  if (!input.reason.trim()) fail("A reason is required to void a cost.");
  const up = await db.from("project_cost_entries").update({ voided_at: (input.now ?? new Date()).toISOString(), voided_by_email: input.actor, void_reason: input.reason.trim() }).eq("org_id", input.orgId).eq("project_id", input.projectId).eq("id", input.entryId).is("voided_at", null).select("id");
  if (up.error) fail(up.error.message);
  if (!up.data?.length) fail("That cost was not found or is already void.");
}

/** Cin7 product AverageCost x the scope's quantities (cents). Null if any SKU has no known (positive) average cost - never a silent zero. */
export async function indicativeScopeCost(db: Db, orgId: string, projectId: string): Promise<number | null> {
  const p = await db.from("projects").select("baseline_snapshot").eq("org_id", orgId).eq("id", projectId).maybeSingle();
  if (p.error || !p.data) return null;
  const lines = effectiveScope(scopeFromSnapshot((p.data as { baseline_snapshot?: unknown }).baseline_snapshot)).lines;
  if (lines.length === 0) return 0;
  const rows = await fetchAllRows<{ sku: string; average_cost: number | string | null }>("indicative cost", (from, to) =>
    db.from("products").select("sku, average_cost").eq("org_id", orgId).in("sku", lines.map((l) => l.sku)).order("sku").range(from, to));
  const cost = new Map(rows.map((r) => [r.sku, Number(r.average_cost)]));
  let total = 0;
  for (const l of lines) {
    const c = cost.get(l.sku);
    if (c === undefined || !Number.isFinite(c) || c <= 0) return null;
    total += l.quantity * c;
  }
  return Math.round(total * 100);
}
