import "server-only";
import { createHash } from "node:crypto";
import type { createServiceRoleClient } from "@/supabase/server";

type Db = ReturnType<typeof createServiceRoleClient>;

// Dedupe window: comfortably longer than any double-click / retry / concurrent-
// invocation window, but far shorter than a legitimate later replenish of the
// same lines, so a genuine repeat run still creates a fresh transfer.
export const STOCK_TRANSFER_CLAIM_TTL_SECONDS = 15 * 60;

export interface StockTransferLineForKey {
  productSku: string;
  transferQuantity: number;
}

/**
 * Deterministic idempotency key for one destination group — a hash of the
 * from/to location and the sorted (sku, quantity) line-set. Two submits of
 * the same selection produce the same key (so they dedupe); a different
 * source, destination, sku or quantity produces a different key (so it's
 * allowed). Batch/expiry resolution is deliberately excluded — it's a
 * deterministic function of current stock looked up fresh on each call, not
 * part of the user's actual selection identity.
 */
export function stockTransferIdempotencyKey(fromLocation: string, toLocation: string, lines: StockTransferLineForKey[]): string {
  const canonical = JSON.stringify({
    fromLocation,
    toLocation,
    lines: lines
      .map((l) => [l.productSku, l.transferQuantity] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1])),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface StockTransferClaimResult {
  /** true → the caller OWNS the claim and must create the transfer (then settle/release). */
  claimed: boolean;
  /** When claimed=false, the state of the live claim that blocked us. */
  existingStatus: "pending" | "completed" | null;
  cin7TransferId: string | null;
  transferNumber: string | null;
}

/**
 * Try to claim the right to create a Stock Transfer for this key (migration
 * 0056's `stock_transfer_creation_claim`). On ANY guard error — DB
 * unreachable, or the migration not applied yet — this FAILS OPEN (returns
 * claimed=true), so transfer creation still works exactly as it did before
 * this guard existed. Duplicates are only possible during a guard outage,
 * i.e. the same exposure as today; the guard must never block stock movement
 * on its own availability.
 */
export async function claimStockTransferCreation(db: Db, orgId: string, instanceId: string, key: string): Promise<StockTransferClaimResult> {
  const { data, error } = await db.rpc("stock_transfer_creation_claim", {
    p_org: orgId,
    p_instance: instanceId,
    p_key: key,
    p_ttl_seconds: STOCK_TRANSFER_CLAIM_TTL_SECONDS,
  });
  if (error) {
    console.error("stock_transfer_creation_claim failed; proceeding without the idempotency guard:", error.message);
    return { claimed: true, existingStatus: null, cin7TransferId: null, transferNumber: null };
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { claimed?: boolean; existing_status?: string; cin7_transfer_id?: string | null; transfer_number?: string | null }
    | undefined;
  if (!row) return { claimed: true, existingStatus: null, cin7TransferId: null, transferNumber: null };
  return {
    claimed: Boolean(row.claimed),
    existingStatus: (row.existing_status as "pending" | "completed" | null) ?? null,
    cin7TransferId: row.cin7_transfer_id ?? null,
    transferNumber: row.transfer_number ?? null,
  };
}

/** Mark a claim completed with the created transfer's identity (best-effort). */
export async function settleStockTransferCreation(
  db: Db,
  orgId: string,
  instanceId: string,
  key: string,
  cin7TransferId: string,
  transferNumber: string | null
): Promise<void> {
  const { error } = await db
    .from("stock_transfer_creation_claims")
    .update({ status: "completed", cin7_transfer_id: cin7TransferId, transfer_number: transferNumber, updated_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .eq("idempotency_key", key);
  if (error) console.error("settleStockTransferCreation failed:", error.message);
}

/** Release a claim after a FAILED create so an immediate retry isn't blocked for the whole TTL (best-effort). */
export async function releaseStockTransferCreation(db: Db, orgId: string, instanceId: string, key: string): Promise<void> {
  const { error } = await db
    .from("stock_transfer_creation_claims")
    .delete()
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .eq("idempotency_key", key)
    .eq("status", "pending");
  if (error) console.error("releaseStockTransferCreation failed:", error.message);
}
