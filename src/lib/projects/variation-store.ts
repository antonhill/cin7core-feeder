import "server-only";
// Projects — Variation persistence. LOCAL ONLY: no Cin7, no fetch (pinned by no-cin7-write.test.ts). Every query is org-scoped.
import type { createServiceRoleClient } from "@/supabase/server";
import { defaultVariationSchedule } from "./variation-schedule";
import { assertVariationTransition, nextVariationCode, type VariationRow, type VariationStatus } from "./variations";

type Db = ReturnType<typeof createServiceRoleClient>;

function fail(message: string): never {
  throw new Error(message);
}

export async function listVariations(db: Db, orgId: string, projectId: string): Promise<VariationRow[]> {
  const r = await db.from("project_variations").select("*").eq("org_id", orgId).eq("project_id", projectId);
  if (r.error) fail(`list variations: ${r.error.message}`);
  return (r.data ?? []) as VariationRow[];
}

async function projectIsActive(db: Db, orgId: string, projectId: string): Promise<void> {
  const p = await db.from("projects").select("id, status").eq("org_id", orgId).eq("id", projectId).maybeSingle();
  if (p.error) fail(p.error.message);
  if (!p.data) fail("Project not found.");
  if ((p.data as { status: string }).status !== "ACTIVE") fail("Variations can only be raised against an ACTIVE project.");
}

export function validateAmount(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) fail("A variation amount must be a positive whole number of cents (ex VAT).");
}

export function validateEstimatedCost(c: number | null | undefined): void {
  if (c === null || c === undefined) return;
  if (!Number.isInteger(c) || c < 0) fail("An estimated cost must be a whole, non-negative number of cents (or left blank when unknown).");
}

/** Sets or clears a DRAFT variation's INTERNAL estimated cost. Approved/rejected variations are frozen (the database refuses too). */
export async function setVariationEstimatedCost(db: Db, orgId: string, projectId: string, variationId: string, cents: number | null): Promise<void> {
  validateEstimatedCost(cents);
  const r = await db.from("project_variations").update({ estimated_cost_cents: cents }).eq("org_id", orgId).eq("project_id", projectId).eq("id", variationId).eq("status", "DRAFT").select("id");
  if (r.error) fail(r.error.message);
  if (!r.data || r.data.length === 0) fail("Only a DRAFT variation's estimated cost can be changed.");
}

/** Raises a DRAFT variation with its estimator price. Never touches the contract value. */
export async function raiseVariation(
  db: Db, orgId: string, email: string,
  input: { projectId: string; title: string; description: string; amountCents: number; estimatedCostCents?: number | null },
): Promise<{ variationId: string; code: string }> {
  if (!input.title.trim()) fail("A variation needs a title.");
  validateAmount(input.amountCents);
  validateEstimatedCost(input.estimatedCostCents);
  await projectIsActive(db, orgId, input.projectId);
  const existing = await listVariations(db, orgId, input.projectId);
  const code = nextVariationCode(existing.map((v) => v.code));
  const ins = await db.from("project_variations").insert({
    org_id: orgId, project_id: input.projectId, code, title: input.title.trim(), description: input.description.trim() || null,
    amount_cents: input.amountCents, ...(input.estimatedCostCents != null ? { estimated_cost_cents: input.estimatedCostCents } : {}), status: "DRAFT", raised_by_email: email, priced_by_email: email,
  }).select("id").single();
  if (ins.error || !ins.data) fail(`raise variation: ${ins.error?.message ?? "no row"}`);
  const variationId = (ins.data as { id: string }).id;
  // Every new variation starts with the default billing schedule: one 100% milestone (editable while DRAFT; frozen on approval).
  const sch = await db.from("project_variation_stages").insert(defaultVariationSchedule().map((s, i) => ({ org_id: orgId, variation_id: variationId, sort_order: i + 1, name: s.name, bps: s.bps }))).select("id");
  if (sch.error && !/does not exist|schema cache/i.test(sch.error.message)) fail(`default variation schedule: ${sch.error.message}`); // deploy-order safety (0105 not applied)
  return { variationId, code };
}

/** Re-prices a DRAFT only. Approved/rejected variations are frozen (the database refuses too). */
export async function repriceVariation(db: Db, orgId: string, email: string, projectId: string, variationId: string, amountCents: number): Promise<void> {
  validateAmount(amountCents);
  const r = await db.from("project_variations").update({ amount_cents: amountCents, priced_by_email: email })
    .eq("org_id", orgId).eq("project_id", projectId).eq("id", variationId).eq("status", "DRAFT").select("id");
  if (r.error) fail(r.error.message);
  if (!r.data || r.data.length === 0) fail("Only a DRAFT variation can be re-priced.");
}

async function decide(db: Db, orgId: string, email: string, projectId: string, variationId: string, to: Extract<VariationStatus, "APPROVED" | "REJECTED">, reason: string): Promise<void> {
  if (to === "REJECTED" && !reason.trim()) fail("A reason is required to reject a variation.");
  const cur = await db.from("project_variations").select("id, status").eq("org_id", orgId).eq("project_id", projectId).eq("id", variationId).maybeSingle();
  if (cur.error) fail(cur.error.message);
  if (!cur.data) fail("Variation not found.");
  assertVariationTransition((cur.data as { status: VariationStatus }).status, to);
  if (to === "APPROVED") await projectIsActive(db, orgId, projectId);
  const r = await db.from("project_variations").update({ status: to, decided_by_email: email, decided_at: new Date().toISOString(), decision_reason: reason.trim() || null })
    .eq("org_id", orgId).eq("project_id", projectId).eq("id", variationId).eq("status", "DRAFT").select("id");
  if (r.error) fail(r.error.message);
  if (!r.data || r.data.length === 0) fail("The variation was already decided.");
}

export const approveVariation = (db: Db, orgId: string, email: string, projectId: string, variationId: string, reason = "") => decide(db, orgId, email, projectId, variationId, "APPROVED", reason);
export const rejectVariation = (db: Db, orgId: string, email: string, projectId: string, variationId: string, reason: string) => decide(db, orgId, email, projectId, variationId, "REJECTED", reason);
