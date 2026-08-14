import "server-only";
import { createHash } from "node:crypto";
import type { createServiceRoleClient } from "@/supabase/server";

type Db = ReturnType<typeof createServiceRoleClient>;

// Dedupe window: comfortably longer than any double-click / retry / concurrent-
// invocation window, but far shorter than a legitimate re-order cycle, so a
// recurring purchase of the same lines later still creates a fresh PO.
export const PO_CLAIM_TTL_SECONDS = 15 * 60;

export interface PoLineForKey {
  productSku: string;
  quantity: number;
}

/**
 * Deterministic idempotency key for one PO group — a hash of the supplier,
 * location, and the sorted (sku, quantity) line-set. Two submits of the same
 * selection produce the same key (so they dedupe); a different supplier,
 * location, sku or quantity produces a different key (so it's allowed).
 */
export function poIdempotencyKey(supplierId: string, locationId: string, lines: PoLineForKey[]): string {
  const canonical = JSON.stringify({
    supplierId,
    locationId,
    lines: lines
      .map((l) => [l.productSku, l.quantity] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1])),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface PoClaimResult {
  /** true → the caller OWNS the claim and must create the PO (then settle/release). */
  claimed: boolean;
  /** When claimed=false, the state of the live claim that blocked us. */
  existingStatus: "pending" | "completed" | null;
  cin7PurchaseId: string | null;
  orderNumber: string | null;
}

/**
 * Try to claim the right to create a PO for this key (migration 0055's
 * `po_creation_claim`). On ANY guard error — DB unreachable, or the migration
 * not applied yet — this FAILS OPEN (returns claimed=true), so PO creation
 * still works exactly as it did before this guard existed. Duplicates are only
 * possible during a guard outage, i.e. the same exposure as today; the guard
 * must never block a core money feature on its own availability.
 */
export async function claimPoCreation(db: Db, orgId: string, instanceId: string, key: string): Promise<PoClaimResult> {
  const { data, error } = await db.rpc("po_creation_claim", {
    p_org: orgId,
    p_instance: instanceId,
    p_key: key,
    p_ttl_seconds: PO_CLAIM_TTL_SECONDS,
  });
  if (error) {
    console.error("po_creation_claim failed; proceeding without the idempotency guard:", error.message);
    return { claimed: true, existingStatus: null, cin7PurchaseId: null, orderNumber: null };
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { claimed?: boolean; existing_status?: string; cin7_purchase_id?: string | null; order_number?: string | null }
    | undefined;
  if (!row) return { claimed: true, existingStatus: null, cin7PurchaseId: null, orderNumber: null };
  return {
    claimed: Boolean(row.claimed),
    existingStatus: (row.existing_status as "pending" | "completed" | null) ?? null,
    cin7PurchaseId: row.cin7_purchase_id ?? null,
    orderNumber: row.order_number ?? null,
  };
}

/** Mark a claim completed with the created PO's identity (best-effort). */
export async function settlePoCreation(
  db: Db,
  orgId: string,
  instanceId: string,
  key: string,
  cin7PurchaseId: string,
  orderNumber: string | null
): Promise<void> {
  const { error } = await db
    .from("po_creation_claims")
    .update({ status: "completed", cin7_purchase_id: cin7PurchaseId, order_number: orderNumber, updated_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .eq("idempotency_key", key);
  if (error) console.error("settlePoCreation failed:", error.message);
}

/** Release a claim after a FAILED create so an immediate retry isn't blocked for the whole TTL (best-effort). */
export async function releasePoCreation(db: Db, orgId: string, instanceId: string, key: string): Promise<void> {
  const { error } = await db
    .from("po_creation_claims")
    .delete()
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .eq("idempotency_key", key)
    .eq("status", "pending");
  if (error) console.error("releasePoCreation failed:", error.message);
}
