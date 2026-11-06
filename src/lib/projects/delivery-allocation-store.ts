import "server-only";
// Persistence for planned deliveries and their SKU allocations, and commercial milestone confirmations. Writes ONLY local Toolbox tables
// (never Cin7): an allocation is a plan, not a stock reservation or a shipment. Every change is audited with its reason.
import type { createServiceRoleClient } from "@/supabase/server";
import { effectiveScope, scopeFromSnapshot } from "./product-scope";
import {
  allocatedUninvoiced, buildQuantityPositions, sumInvoicedAgainstDeliveries, validateAllocationChange,
  type AllocationRow, type DeliveryRef, type PositionInput, type QuantityPosition, type ScopeQty,
} from "./delivery-allocation";

type Db = ReturnType<typeof createServiceRoleClient>;
function fail(message: string): never { throw new Error(message); }

export interface DeliveryRow extends DeliveryRef { project_id: string; planned_date: string | null; created_by_email: string; created_at: string }
interface AllocRow { delivery_id: string; sku: string; quantity: number | string }

/** Cin7 facts the register can use; each is optional and absent means "no Sale / not read" - never zero. */
export type CinFacts = Pick<PositionInput, "ordered" | "invoiced" | "shipped">;

async function projectScope(db: Db, orgId: string, projectId: string): Promise<{ scope: ScopeQty[]; status: string }> {
  const p = await db.from("projects").select("baseline_snapshot, status").eq("org_id", orgId).eq("id", projectId).maybeSingle();
  if (p.error) fail(p.error.message);
  if (!p.data) fail("Project not found.");
  const row = p.data as { baseline_snapshot?: unknown; status: string };
  const eff = effectiveScope(scopeFromSnapshot(row.baseline_snapshot));
  return { scope: eff.lines.map((l) => ({ sku: l.sku, description: l.description, quantity: l.quantity })), status: row.status };
}

async function loadAll(db: Db, orgId: string, projectId: string) {
  const d = await db.from("project_deliveries").select("*").eq("org_id", orgId).eq("project_id", projectId).order("created_at", { ascending: true });
  if (d.error) fail(`load deliveries: ${d.error.message}`);
  const a = await db.from("project_delivery_allocations").select("delivery_id, sku, quantity").eq("org_id", orgId).eq("project_id", projectId);
  if (a.error) fail(`load allocations: ${a.error.message}`);
  const po = await db.from("project_claim_cin7_postings").select("posting_state, physical_lines").eq("org_id", orgId).eq("project_id", projectId);
  if (po.error) fail(`load postings: ${po.error.message}`);
  const deliveries = (d.data ?? []) as DeliveryRow[];
  const allocations: AllocationRow[] = ((a.data ?? []) as AllocRow[]).map((x) => ({ deliveryId: x.delivery_id, sku: x.sku, quantity: Number(x.quantity) }));
  const invoicedAgainstDelivery = sumInvoicedAgainstDeliveries((po.data ?? []) as Array<{ posting_state: string; physical_lines?: Array<{ sku: string; quantity: number; deliveryId?: string }> | null }>);
  return { deliveries, allocations, invoicedAgainstDelivery };
}

export interface DeliveryRegister { deliveries: DeliveryRow[]; allocations: AllocationRow[]; positions: QuantityPosition[]; invoicedAgainstDelivery: Record<string, number>; scopeBlockers: string[] }

export async function loadDeliveryRegister(db: Db, orgId: string, projectId: string, cin7?: CinFacts): Promise<DeliveryRegister> {
  const { scope } = await projectScope(db, orgId, projectId);
  const all = await loadAll(db, orgId, projectId);
  const positions = buildQuantityPositions({ scope, ...cin7, deliveries: all.deliveries, allocations: all.allocations, invoicedAgainstDelivery: all.invoicedAgainstDelivery });
  return { ...all, positions, scopeBlockers: [] };
}

async function audit(db: Db, row: { orgId: string; projectId: string; deliveryId: string; sku?: string; action: string; from?: number | null; to?: number | null; reason?: string; actor: string }) {
  const r = await db.from("project_delivery_events").insert({
    org_id: row.orgId, project_id: row.projectId, delivery_id: row.deliveryId, sku: row.sku ?? null, action: row.action,
    from_quantity: row.from ?? null, to_quantity: row.to ?? null, reason: row.reason ?? null, actor_email: row.actor,
  });
  if (r.error) fail(`audit: ${r.error.message}`);
}

export async function createDelivery(db: Db, input: { orgId: string; projectId: string; actor: string; label: string; plannedDate?: string | null }): Promise<DeliveryRow> {
  const label = input.label.trim();
  if (!label) fail("A delivery needs a label.");
  const { status } = await projectScope(db, input.orgId, input.projectId);
  if (status !== "ACTIVE") fail("Deliveries can only be planned on an ACTIVE project.");
  const ins = await db.from("project_deliveries").insert({ org_id: input.orgId, project_id: input.projectId, label, planned_date: input.plannedDate ?? null, status: "PLANNED", created_by_email: input.actor }).select("*").single();
  if (ins.error || !ins.data) fail(/duplicate|unique/i.test(ins.error?.message ?? "") ? `A delivery named "${label}" already exists on this project.` : `create delivery: ${ins.error?.message ?? "no row"}`);
  const row = ins.data as DeliveryRow;
  await audit(db, { orgId: input.orgId, projectId: input.projectId, deliveryId: row.id, action: "DELIVERY_CREATED", reason: label, actor: input.actor });
  return row;
}

/** Sets (or, with quantity 0, removes) the quantity of one SKU on one delivery. Revalidated server-side against the scope / Sale and what is invoiced. */
export async function setAllocation(db: Db, input: { orgId: string; projectId: string; actor: string; deliveryId: string; sku: string; quantity: number; reason: string; cin7?: CinFacts }): Promise<void> {
  const { scope, status } = await projectScope(db, input.orgId, input.projectId);
  if (status !== "ACTIVE") fail("Allocations can only be changed on an ACTIVE project.");
  const all = await loadAll(db, input.orgId, input.projectId);
  const bad = validateAllocationChange({ deliveryId: input.deliveryId, sku: input.sku, quantity: input.quantity, reason: input.reason }, { scope, ordered: input.cin7?.ordered, ...all });
  if (bad) fail(bad);
  const existing = all.allocations.find((a) => a.deliveryId === input.deliveryId && a.sku === input.sku);
  const from = existing?.quantity ?? 0;
  if (from === input.quantity) return;
  if (input.quantity === 0) {
    const del = await db.from("project_delivery_allocations").delete().eq("org_id", input.orgId).eq("delivery_id", input.deliveryId).eq("sku", input.sku);
    if (del.error) fail(`remove allocation: ${del.error.message}`);
  } else if (existing) {
    const up = await db.from("project_delivery_allocations").update({ quantity: input.quantity, updated_by_email: input.actor }).eq("org_id", input.orgId).eq("delivery_id", input.deliveryId).eq("sku", input.sku);
    if (up.error) fail(`update allocation: ${up.error.message}`);
  } else {
    const ins = await db.from("project_delivery_allocations").insert({ org_id: input.orgId, project_id: input.projectId, delivery_id: input.deliveryId, sku: input.sku, quantity: input.quantity, updated_by_email: input.actor });
    if (ins.error) fail(`add allocation: ${ins.error.message}`);
  }
  await audit(db, { orgId: input.orgId, projectId: input.projectId, deliveryId: input.deliveryId, sku: input.sku, action: input.quantity === 0 ? "ALLOCATION_REMOVED" : "ALLOCATION_SET", from, to: input.quantity, reason: input.reason.trim(), actor: input.actor });
}

const NEXT: Record<string, string[]> = { PLANNED: ["LOADING", "DISPATCHED", "CANCELLED"], LOADING: ["DISPATCHED", "CANCELLED", "PLANNED"], DISPATCHED: [], CANCELLED: [] };

export async function setDeliveryStatus(db: Db, input: { orgId: string; projectId: string; actor: string; deliveryId: string; status: "PLANNED" | "LOADING" | "DISPATCHED" | "CANCELLED"; reason: string }): Promise<void> {
  if (!input.reason.trim()) fail("A reason is required.");
  const all = await loadAll(db, input.orgId, input.projectId);
  const d = all.deliveries.find((x) => x.id === input.deliveryId);
  if (!d) fail("Delivery not found in this project.");
  if (!NEXT[d.status].includes(input.status)) fail(`A ${d.status} delivery cannot become ${input.status}.`);
  if (input.status === "CANCELLED" && all.allocations.some((a) => a.deliveryId === d.id && (all.invoicedAgainstDelivery[`${d.id}|${a.sku}`] ?? 0) > 0)) fail("This delivery already has invoiced products and cannot be cancelled.");
  if (input.status === "CANCELLED") {
    const del = await db.from("project_delivery_allocations").delete().eq("org_id", input.orgId).eq("delivery_id", d.id);
    if (del.error) fail(`release allocations: ${del.error.message}`);
  }
  const up = await db.from("project_deliveries").update({ status: input.status, updated_at: new Date().toISOString() }).eq("org_id", input.orgId).eq("project_id", input.projectId).eq("id", d.id);
  if (up.error) fail(`delivery status: ${up.error.message}`);
  await audit(db, { orgId: input.orgId, projectId: input.projectId, deliveryId: d.id, action: input.status === "CANCELLED" ? "DELIVERY_CANCELLED" : "DELIVERY_STATUS", reason: `${d.status} -> ${input.status}: ${input.reason.trim()}`, actor: input.actor });
}

/** Allocated-but-uninvoiced quantities for ONE delivery (the invoice proposal's allocation-rule input). */
export async function loadDeliveryEligibility(db: Db, orgId: string, projectId: string, deliveryId: string): Promise<{ allocated: Record<string, number>; label: string }> {
  const all = await loadAll(db, orgId, projectId);
  const d = all.deliveries.find((x) => x.id === deliveryId);
  if (!d) fail("Delivery not found in this project.");
  if (d.status === "CANCELLED") fail("This delivery is cancelled.");
  return { allocated: allocatedUninvoiced(deliveryId, all.allocations, all.invoicedAgainstDelivery), label: d.label };
}

// ── commercial milestone confirmation ──────────────────────────────────────

export interface MilestoneConfirmation { id: string; stage_id: string; confirmed_by_email: string; note: string; evidence_ref: string | null; confirmed_at: string }

/** A manager records that a commercial milestone has been met, with the supporting evidence. Independent of physical progress. */
export async function confirmMilestone(db: Db, input: { orgId: string; projectId: string; stageId: string; actor: string; note: string; evidenceRef?: string | null }): Promise<MilestoneConfirmation> {
  if (!input.note.trim()) fail("Describe what was confirmed (and the evidence) for this milestone.");
  const st = await db.from("project_stages").select("id").eq("org_id", input.orgId).eq("project_id", input.projectId).eq("id", input.stageId).maybeSingle();
  if (st.error) fail(st.error.message);
  if (!st.data) fail("Stage not found in this project.");
  const ins = await db.from("project_milestone_confirmations").insert({ org_id: input.orgId, project_id: input.projectId, stage_id: input.stageId, confirmed_by_email: input.actor, note: input.note.trim(), evidence_ref: input.evidenceRef?.trim() || null }).select("*").single();
  if (ins.error || !ins.data) fail(`confirm milestone: ${ins.error?.message ?? "no row"}`);
  return ins.data as MilestoneConfirmation;
}

export async function listMilestoneConfirmations(db: Db, orgId: string, projectId: string): Promise<MilestoneConfirmation[]> {
  const r = await db.from("project_milestone_confirmations").select("*").eq("org_id", orgId).eq("project_id", projectId).order("confirmed_at", { ascending: true });
  if (r.error) fail(r.error.message);
  return (r.data ?? []) as MilestoneConfirmation[];
}
