import "server-only";
// Disposable P0 project: catalogue search (LOCAL cache, no Cin7 call) and creation (Toolbox rows only). Creating the project writes nothing to
// Cin7. The chosen SKUs and quantities are re-verified LIVE (read-only) against the connected Cin7 instance before anything is stored.
import type { createServiceRoleClient } from "@/supabase/server";
import { createProjectFromBaseline } from "./project-store";
import { buildP0Baseline, P0_DISPOSABLE_PREFIX, type P0ProjectInput } from "./p0-project";
import type { P0Port } from "./p0-checklist";

type Db = ReturnType<typeof createServiceRoleClient>;
function fail(message: string): never { throw new Error(message); }

export interface StockedProduct { sku: string; name: string; available: number; onHand: number; syncedAt: string }

/** Existing Cin7 products with free stock at `location`, from the synced local cache (org-scoped). Filtered by SKU/name text. A starting point only. */
export async function searchStockedProducts(db: Db, orgId: string, location: string, query: string, limit = 25): Promise<StockedProduct[]> {
  const loc = location.trim();
  if (!loc) fail("Enter the Cin7 location (for example MSTR).");
  const r = await db.from("product_availability").select("product_sku, product_name, location, on_hand, available, synced_at").eq("org_id", orgId).eq("location", loc);
  if (r.error) fail(`search products: ${r.error.message}`);
  const q = query.trim().toLowerCase();
  const rows = (r.data ?? []) as Array<{ product_sku: string; product_name: string | null; on_hand: number | string | null; available: number | string | null; synced_at: string }>;
  const bySku = new Map<string, StockedProduct>();
  for (const x of rows) {
    const available = Number(x.available);
    if (!x.product_sku || !Number.isFinite(available) || available <= 0) continue; // unknown or zero stock is never offered
    if (q && !(x.product_sku.toLowerCase().includes(q) || (x.product_name ?? "").toLowerCase().includes(q))) continue;
    const prev = bySku.get(x.product_sku);
    bySku.set(x.product_sku, { sku: x.product_sku, name: x.product_name ?? "", available: (prev?.available ?? 0) + available, onHand: (prev?.onHand ?? 0) + (Number(x.on_hand) || 0), syncedAt: x.synced_at });
  }
  return [...bySku.values()].sort((a, b) => b.available - a.available).slice(0, limit);
}

export interface CreateP0Input extends P0ProjectInput { location: string }

/**
 * Creates the disposable P0 project. Manager only. Re-verifies, read-only and live, that every chosen SKU exists in Cin7 by exact match and has
 * enough free stock at the location; refuses (storing nothing) if not. The reference is `P0-<yyyymmdd>-<n>`; the (org, reference) unique
 * constraint means a double click cannot create two projects with the same reference.
 */
export async function createP0Project(
  db: Db, port: Pick<P0Port, "resolveProducts" | "stockAt">, gates: { isManager: boolean }, email: string, denylist: readonly string[],
  input: CreateP0Input & { orgId: string; now?: Date },
): Promise<{ projectId: string; reference: string }> {
  if (!gates.isManager) fail("Only a manager (org owner/admin) can prepare a P0 project.");
  const loc = input.location.trim();
  if (!loc) fail("Enter the Cin7 location (for example MSTR).");
  const day = (input.now ?? new Date()).toISOString().slice(0, 10).replace(/-/g, "");
  const existing = await db.from("projects").select("project_reference").eq("org_id", input.orgId);
  if (existing.error) fail(existing.error.message);
  const n = ((existing.data ?? []) as Array<{ project_reference: string }>).filter((p) => p.project_reference.startsWith(`P0-${day}-`)).length + 1;
  const reference = `P0-${day}-${n}`;
  const plan = buildP0Baseline(reference, input, denylist);
  if (!plan.ok) fail(plan.error);

  const skus = input.products.map((p) => p.sku);
  const res = await port.resolveProducts(skus);
  if (res.missing.length) fail(`These SKUs do not exist in Cin7: ${res.missing.join(", ")}. Nothing was created.`);
  for (const p of input.products) {
    const rows = (await port.stockAt(p.sku)).filter((r) => r.location === loc);
    const avail = rows.length === 0 ? null : rows.reduce<number | null>((a, r) => (a === null || r.available === null ? null : a + r.available), 0);
    if (rows.length === 0) fail(`${p.sku} has no stock row at "${loc}" in Cin7. Nothing was created.`);
    if (avail === null) fail(`The free stock of ${p.sku} at "${loc}" is unreadable. Nothing was created.`);
    if (avail < p.quantity) fail(`${p.sku}: ${avail} available at "${loc}" in Cin7, ${p.quantity} needed. Nothing was created.`);
  }
  const projectId = await createProjectFromBaseline(db, input.orgId, email, plan.baseline, { reference, name: `P0 DISPOSABLE ${reference} - ${plan.baseline.customer.name}` });
  return { projectId, reference };
}

export { P0_DISPOSABLE_PREFIX };
