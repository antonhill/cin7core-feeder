import "server-only";
import { createHash } from "node:crypto";
import type { createServiceRoleClient } from "@/supabase/server";
import type { Cin7Credentials } from "@/cin7/types";
import { fetchAllPurchasesList } from "@/cin7/purchases";

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
  existingStatus: "pending" | "completed" | "ambiguous" | "guard_unavailable" | null;
  cin7PurchaseId: string | null;
  orderNumber: string | null;
}

/**
 * Try to claim the right to create a PO for this key (migration 0055's
 * `po_creation_claim`). Security re-audit round 3, P1-5 (Anton-approved
 * 2026-08-17): FAILS CLOSED on any guard error — DB unreachable, or the
 * migration not applied — returning claimed=false with
 * existingStatus="guard_unavailable" rather than proceeding as if the claim
 * were won. This is the one lock family (alongside stock-transfer claims and
 * sync_locks) where a guard outage could otherwise let a race create a real
 * duplicate Purchase Order in Cin7; blocking one retryable button-click is
 * judged a better tradeoff than that risk. (Previously failed open — see
 * docs/security-reaudit-report-2026-08-17.md's round 3 P1-5 section for the
 * full decision table this was approved against.)
 */
export async function claimPoCreation(db: Db, orgId: string, instanceId: string, key: string): Promise<PoClaimResult> {
  const { data, error } = await db.rpc("po_creation_claim", {
    p_org: orgId,
    p_instance: instanceId,
    p_key: key,
    p_ttl_seconds: PO_CLAIM_TTL_SECONDS,
  });
  if (error) {
    console.error("po_creation_claim failed; blocking PO creation (fail-closed):", error.message);
    return { claimed: false, existingStatus: "guard_unavailable", cin7PurchaseId: null, orderNumber: null };
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { claimed?: boolean; existing_status?: string; cin7_purchase_id?: string | null; order_number?: string | null }
    | undefined;
  if (!row) return { claimed: false, existingStatus: "guard_unavailable", cin7PurchaseId: null, orderNumber: null };
  return {
    claimed: Boolean(row.claimed),
    existingStatus: (row.existing_status as "pending" | "completed" | "ambiguous" | null) ?? null,
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

/** Release a claim after a DEFINITE (non-ambiguous) create failure, so an immediate retry isn't blocked for the whole TTL (best-effort). */
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

/**
 * Security re-audit P0-2: mark a claim `ambiguous` after a create call whose
 * network outcome is unknown (Cin7ApiError.ambiguous — see
 * cin7/http.ts's nonIdempotentCreate). Unlike releasePoCreation, this does
 * NOT delete the claim — an immediate retry could otherwise create a genuine
 * duplicate PO if the original request actually reached Cin7. The claim
 * stays live (blocking a blind retry) until it's resolved by
 * findLikelyCreatedPurchaseOrder, or expires after PO_CLAIM_TTL_SECONDS.
 */
export async function markPoCreationAmbiguous(db: Db, orgId: string, instanceId: string, key: string): Promise<void> {
  const { error } = await db
    .from("po_creation_claims")
    .update({ status: "ambiguous", updated_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .eq("idempotency_key", key)
    .eq("status", "pending");
  if (error) console.error("markPoCreationAmbiguous failed:", error.message);
}

/**
 * Security re-audit P0-2: Cin7's create response carries no client-supplied
 * reference to reconcile against, so this is a best-effort heuristic lookup —
 * the newest DRAFT PO for this supplier updated since the ambiguous attempt
 * started. `sinceIso` should be bounded to at most PO_CLAIM_TTL_SECONDS ago
 * (an ambiguous claim can never be older than that — see po_creation_claim's
 * TTL-expiry reclaim in migration 0055), so this can't match a much older,
 * unrelated DRAFT PO for the same supplier. Not a guarantee: a second,
 * unrelated DRAFT PO for the same supplier created in the same short window
 * would also match — acceptable for a rare, already-degraded (network
 * failure) path, and strictly safer than the alternative of blindly retrying
 * and risking a real duplicate.
 */
export async function findLikelyCreatedPurchaseOrder(
  creds: Cin7Credentials,
  supplierId: string,
  sinceIso: string
): Promise<{ cin7PurchaseId: string; orderNumber: string | null } | null> {
  const entries = await fetchAllPurchasesList(creds, sinceIso);
  const candidates = entries
    .filter((e) => e.SupplierID === supplierId && e.Status === "DRAFT")
    .sort((a, b) => (b.OrderDate ?? "").localeCompare(a.OrderDate ?? ""));
  const match = candidates[0];
  return match ? { cin7PurchaseId: match.ID, orderNumber: match.OrderNumber ?? null } : null;
}
