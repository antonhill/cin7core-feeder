import "server-only";
import { createHash } from "node:crypto";
import type { createServiceRoleClient } from "@/supabase/server";

type Db = ReturnType<typeof createServiceRoleClient>;

// Same rationale as po-idempotency.ts's PO_CLAIM_TTL_SECONDS: longer than any
// double-click / retry / concurrent window, far shorter than a legitimate
// repeat transfer of the same lines later.
export const TRANSFER_CLAIM_TTL_SECONDS = 15 * 60;

export interface TransferLineForKey {
  productSku: string;
  quantity: number;
}

/**
 * Deterministic idempotency key for one transfer group — a hash of the source
 * and destination locations and the sorted (sku, quantity) line-set. Two
 * submits of the same transfer produce the same key.
 */
export function transferIdempotencyKey(
  fromLocation: string,
  toLocation: string,
  lines: TransferLineForKey[]
): string {
  const canonical = JSON.stringify({
    fromLocation,
    toLocation,
    lines: lines
      .map((l) => [l.productSku, l.quantity] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1])),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface TransferClaimResult {
  /** true → the caller OWNS the claim and must create the transfer (then settle/release). */
  claimed: boolean;
  existingStatus: "pending" | "completed" | null;
  cin7TaskId: string | null;
  transferNumber: string | null;
}

/**
 * Try to claim the right to create a stock transfer for this key (migration
 * 0056's `transfer_creation_claim`). FAILS OPEN (claimed=true) on any guard
 * error — DB down or migration not applied — so transfer creation still works
 * exactly as before; duplicates are only possible during a guard outage, same
 * exposure as today.
 */
export async function claimTransferCreation(db: Db, orgId: string, instanceId: string, key: string): Promise<TransferClaimResult> {
  const { data, error } = await db.rpc("transfer_creation_claim", {
    p_org: orgId,
    p_instance: instanceId,
    p_key: key,
    p_ttl_seconds: TRANSFER_CLAIM_TTL_SECONDS,
  });
  if (error) {
    console.error("transfer_creation_claim failed; proceeding without the idempotency guard:", error.message);
    return { claimed: true, existingStatus: null, cin7TaskId: null, transferNumber: null };
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { claimed?: boolean; existing_status?: string; cin7_task_id?: string | null; transfer_number?: string | null }
    | undefined;
  if (!row) return { claimed: true, existingStatus: null, cin7TaskId: null, transferNumber: null };
  return {
    claimed: Boolean(row.claimed),
    existingStatus: (row.existing_status as "pending" | "completed" | null) ?? null,
    cin7TaskId: row.cin7_task_id ?? null,
    transferNumber: row.transfer_number ?? null,
  };
}

/** Mark a claim completed with the created transfer's identity (best-effort). */
export async function settleTransferCreation(
  db: Db,
  orgId: string,
  instanceId: string,
  key: string,
  cin7TaskId: string,
  transferNumber: string | null
): Promise<void> {
  const { error } = await db
    .from("transfer_creation_claims")
    .update({ status: "completed", cin7_task_id: cin7TaskId, transfer_number: transferNumber, updated_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .eq("idempotency_key", key);
  if (error) console.error("settleTransferCreation failed:", error.message);
}

/** Release a claim after a FAILED create so an immediate retry isn't blocked for the whole TTL (best-effort). */
export async function releaseTransferCreation(db: Db, orgId: string, instanceId: string, key: string): Promise<void> {
  const { error } = await db
    .from("transfer_creation_claims")
    .delete()
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .eq("idempotency_key", key)
    .eq("status", "pending");
  if (error) console.error("releaseTransferCreation failed:", error.message);
}
