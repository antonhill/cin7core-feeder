import "server-only";
// Persistence for the approved product scope register (see product-scope.ts). The register lives in the project's baseline snapshot, so it is
// inherited with the project, travels with it, and is frozen by the database's baseline guard once a claim is approved. The only change ever
// made to it is a controlled, audited RESOLUTION of an unmapped item, and only before any claim or Cin7 Sale exists.
import type { createServiceRoleClient } from "@/supabase/server";
import { applyResolution, effectiveScope, scopeFromSnapshot, type EffectiveScope, type ResolveLineInput, type ScopeItem } from "./product-scope";
import type { P0Port } from "./p0-checklist";

type Db = ReturnType<typeof createServiceRoleClient>;
function fail(message: string): never { throw new Error(message); }

export async function loadProjectScope(db: Db, orgId: string, projectId: string): Promise<{ items: ScopeItem[]; effective: EffectiveScope }> {
  const p = await db.from("projects").select("baseline_snapshot").eq("org_id", orgId).eq("id", projectId).maybeSingle();
  if (p.error) fail(p.error.message);
  if (!p.data) fail("Project not found.");
  const items = scopeFromSnapshot((p.data as { baseline_snapshot?: unknown }).baseline_snapshot);
  return { items, effective: effectiveScope(items) };
}

export interface ResolveScopeInput { orgId: string; projectId: string; itemId: string; kind: "MAP" | "MAP_LINES" | "EXCLUDE"; sku?: string; quantity?: number; lines?: ResolveLineInput[]; reason: string; now?: Date }

/** Manager only. Maps an unmapped item to a real Cin7 SKU (verified live, read-only) or excludes it from the Sales Order, each with a reason. */
export async function resolveScopeItem(db: Db, port: Pick<P0Port, "resolveProducts">, gates: { isManager: boolean }, email: string, input: ResolveScopeInput): Promise<ScopeItem[]> {
  if (!gates.isManager) fail("Only a manager (org owner/admin) can resolve a product scope item.");
  const p = await db.from("projects").select("id, status, baseline_snapshot").eq("org_id", input.orgId).eq("id", input.projectId).maybeSingle();
  if (p.error) fail(p.error.message);
  if (!p.data) fail("Project not found.");
  const proj = p.data as { status: string; baseline_snapshot: Record<string, unknown> | null };
  if (proj.status !== "ACTIVE") fail("Only an ACTIVE project's scope can be resolved.");
  const claims = await db.from("project_claims").select("id").eq("org_id", input.orgId).eq("project_id", input.projectId);
  if (claims.error) fail(claims.error.message);
  if ((claims.data ?? []).length > 0) fail("This project already has a claim; its scope is frozen. Use an approved variation for additions.");
  const link = await db.from("project_cin7_sale_links").select("id").eq("org_id", input.orgId).eq("project_id", input.projectId).maybeSingle();
  if (link.error) fail(link.error.message);
  if (link.data) fail("This project's Cin7 Sale already exists; its scope is frozen.");
  const cr = await db.from("project_cin7_sale_creations").select("id").eq("org_id", input.orgId).eq("project_id", input.projectId).maybeSingle();
  if (cr.error && !/does not exist|schema cache/i.test(cr.error.message)) fail(cr.error.message);
  if (cr.data) fail("A Cin7 Sale creation exists for this project; its scope is frozen.");
  const snap = proj.baseline_snapshot ?? {};
  if (!Array.isArray((snap as { physicalScope?: unknown }).physicalScope)) fail("This project has no recorded product scope to resolve.");
  const items = (snap as { physicalScope: ScopeItem[] }).physicalScope;
  if (input.kind === "MAP") {
    const sku = (input.sku ?? "").trim();
    if (!sku) fail("Enter the Cin7 SKU to map this item to.");
    const res = await port.resolveProducts([sku]);
    if (res.missing.length) fail(`SKU ${sku} does not exist in Cin7 (exact match). Nothing was changed.`);
  }
  if (input.kind === "MAP_LINES") {
    // every SKU must exist in Cin7 (exact match, read-only) before anything is recorded
    const skus = (input.lines ?? []).map((l) => (l.sku ?? "").trim()).filter(Boolean);
    if (skus.length) {
      const res = await port.resolveProducts(skus);
      if (res.missing.length) fail(`SKU ${res.missing.join(", ")} does not exist in Cin7 (exact match). Nothing was changed.`);
    }
  }
  const r = applyResolution(items, { itemId: input.itemId, kind: input.kind, sku: input.sku, quantity: input.quantity, lines: input.lines, reason: input.reason, by: email, at: (input.now ?? new Date()).toISOString() });
  if (!r.ok) fail(r.error);
  const up = await db.from("projects").update({ baseline_snapshot: { ...snap, physicalScope: r.items } }).eq("org_id", input.orgId).eq("id", input.projectId).select("id");
  if (up.error) fail(`save scope resolution: ${up.error.message}`);
  if (!up.data?.length) fail("The project changed while saving; try again.");
  return r.items;
}
