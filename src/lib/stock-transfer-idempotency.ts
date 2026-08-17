import "server-only";
import { createHash } from "node:crypto";
import type { createServiceRoleClient } from "@/supabase/server";
import type { Cin7Credentials } from "@/cin7/types";
import { fetchAllStockTransfersList } from "@/cin7/stock-transfers";

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
  existingStatus: "pending" | "completed" | "ambiguous" | "guard_unavailable" | null;
  cin7TransferId: string | null;
  transferNumber: string | null;
}

/**
 * Try to claim the right to create a Stock Transfer for this key (migration
 * 0056's `stock_transfer_creation_claim`). Security re-audit round 3, P1-5
 * (Anton-approved 2026-08-17): FAILS CLOSED on any guard error — DB
 * unreachable, or the migration not applied — returning claimed=false with
 * existingStatus="guard_unavailable" rather than proceeding as if the claim
 * were won. See po-idempotency.ts's claimPoCreation for the symmetric change
 * and docs/security-reaudit-report-2026-08-17.md's round 3 P1-5 section for
 * the decision table this was approved against. (Previously failed open.)
 */
export async function claimStockTransferCreation(db: Db, orgId: string, instanceId: string, key: string): Promise<StockTransferClaimResult> {
  const { data, error } = await db.rpc("stock_transfer_creation_claim", {
    p_org: orgId,
    p_instance: instanceId,
    p_key: key,
    p_ttl_seconds: STOCK_TRANSFER_CLAIM_TTL_SECONDS,
  });
  if (error) {
    console.error("stock_transfer_creation_claim failed; blocking transfer creation (fail-closed):", error.message);
    return { claimed: false, existingStatus: "guard_unavailable", cin7TransferId: null, transferNumber: null };
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { claimed?: boolean; existing_status?: string; cin7_transfer_id?: string | null; transfer_number?: string | null }
    | undefined;
  if (!row) return { claimed: false, existingStatus: "guard_unavailable", cin7TransferId: null, transferNumber: null };
  return {
    claimed: Boolean(row.claimed),
    existingStatus: (row.existing_status as "pending" | "completed" | "ambiguous" | null) ?? null,
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

/** Release a claim after a DEFINITE (non-ambiguous) create failure, so an immediate retry isn't blocked for the whole TTL (best-effort). */
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

/**
 * Security re-audit P0-2: mark a claim `ambiguous` after a create call whose
 * network outcome is unknown (Cin7ApiError.ambiguous — see
 * cin7/http.ts's nonIdempotentCreate). Unlike releaseStockTransferCreation,
 * this does NOT delete the claim — an immediate retry could otherwise create
 * a genuine duplicate transfer if the original request actually reached
 * Cin7. The claim stays live (blocking a blind retry) until it's resolved by
 * findLikelyCreatedStockTransfer, or expires after STOCK_TRANSFER_CLAIM_TTL_SECONDS.
 */
export async function markStockTransferCreationAmbiguous(db: Db, orgId: string, instanceId: string, key: string): Promise<void> {
  const { error } = await db
    .from("stock_transfer_creation_claims")
    .update({ status: "ambiguous", updated_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .eq("idempotency_key", key)
    .eq("status", "pending");
  if (error) console.error("markStockTransferCreationAmbiguous failed:", error.message);
}

/**
 * Security re-audit P0-2: Cin7's create response carries no client-supplied
 * reference to reconcile against, so this is a best-effort heuristic lookup —
 * the newest DRAFT transfer on this exact from/to location pair, modified
 * since the ambiguous attempt started. `sinceIso` should be bounded to at
 * most STOCK_TRANSFER_CLAIM_TTL_SECONDS ago (an ambiguous claim can never be
 * older than that — see stock_transfer_creation_claim's TTL-expiry reclaim in
 * migration 0056). Not a guarantee: a second, unrelated DRAFT transfer
 * between the same two locations created in the same short window would also
 * match — acceptable for a rare, already-degraded (network failure) path,
 * and strictly safer than the alternative of blindly retrying and risking a
 * real duplicate. fetchAllStockTransfersList has no server-side time filter,
 * so this fetches the full list and filters client-side — fine for a rare
 * failure-recovery path, not the hot path.
 */
export async function findLikelyCreatedStockTransfer(
  creds: Cin7Credentials,
  fromLocation: string,
  toLocation: string,
  sinceIso: string
): Promise<{ cin7TransferId: string; transferNumber: string | null } | null> {
  const entries = await fetchAllStockTransfersList(creds);
  const candidates = entries
    .filter(
      (e) =>
        e.FromLocation === fromLocation &&
        e.ToLocation === toLocation &&
        e.Status === "DRAFT" &&
        (e.LastModifiedOn ?? "") >= sinceIso
    )
    .sort((a, b) => (b.LastModifiedOn ?? "").localeCompare(a.LastModifiedOn ?? ""));
  const match = candidates[0];
  return match ? { cin7TransferId: match.TaskID, transferNumber: match.Number ?? null } : null;
}
