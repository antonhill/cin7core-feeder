import "server-only";
import type { createServiceRoleClient } from "@/supabase/server";

type Db = ReturnType<typeof createServiceRoleClient>;

// Dedupe window: longer than any double-click / retry / concurrent-invocation window. A quote is a
// stable, frozen-once-submitted entity, so the idempotency key is just the quote id — re-submitting
// the same quote must never create a second Cin7 sale.
export const QUOTE_CLAIM_TTL_SECONDS = 15 * 60;

export interface QuoteClaimResult {
  /** true → the caller OWNS the claim and must create the sale (then settle / release / mark-ambiguous). */
  claimed: boolean;
  existingStatus: "pending" | "completed" | "ambiguous" | "guard_unavailable" | null;
  cin7SaleId: string | null;
  quoteNumber: string | null;
}

/**
 * Try to claim the right to create the Cin7 sale for this quote (migration 0084's
 * `quote_creation_claim`). FAILS CLOSED on any guard error — DB unreachable, migration not applied —
 * returning claimed=false / "guard_unavailable" rather than proceeding as if won, exactly like
 * claimPoCreation: a guard outage must never let a race create a real duplicate Sale in Cin7.
 */
export async function claimQuoteCreation(db: Db, orgId: string, instanceId: string, key: string): Promise<QuoteClaimResult> {
  const { data, error } = await db.rpc("quote_creation_claim", {
    p_org: orgId,
    p_instance: instanceId,
    p_key: key,
    p_ttl_seconds: QUOTE_CLAIM_TTL_SECONDS,
  });
  if (error) {
    console.error("quote_creation_claim failed; blocking submit (fail-closed):", error.message);
    return { claimed: false, existingStatus: "guard_unavailable", cin7SaleId: null, quoteNumber: null };
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { claimed?: boolean; existing_status?: string; cin7_sale_id?: string | null; quote_number?: string | null }
    | undefined;
  if (!row) return { claimed: false, existingStatus: "guard_unavailable", cin7SaleId: null, quoteNumber: null };
  return {
    claimed: Boolean(row.claimed),
    existingStatus: (row.existing_status as "pending" | "completed" | "ambiguous" | null) ?? null,
    cin7SaleId: row.cin7_sale_id ?? null,
    quoteNumber: row.quote_number ?? null,
  };
}

/**
 * Mark a claim completed with the created sale's identity (best-effort). Returns whether the write
 * persisted — a caller MUST fall back to {@link markQuoteCreationAmbiguous} on a `false` return, so a
 * confirmed-created sale whose settle write failed is left forcing reconciliation, never a silent
 * `pending` that a later TTL reclaim could turn into a duplicate (same rule as settlePoCreation).
 */
export async function settleQuoteCreation(
  db: Db,
  orgId: string,
  instanceId: string,
  key: string,
  cin7SaleId: string,
  quoteNumber: string | null,
): Promise<boolean> {
  const { error } = await db
    .from("quote_creation_claims")
    .update({ status: "completed", cin7_sale_id: cin7SaleId, quote_number: quoteNumber, updated_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .eq("idempotency_key", key);
  if (error) {
    console.error("settleQuoteCreation failed:", error.message);
    return false;
  }
  return true;
}

/** Release a claim after a DEFINITE (non-ambiguous) failure BEFORE any sale was created, so an immediate retry isn't blocked (best-effort). */
export async function releaseQuoteCreation(db: Db, orgId: string, instanceId: string, key: string): Promise<void> {
  const { error } = await db
    .from("quote_creation_claims")
    .delete()
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .eq("idempotency_key", key)
    .eq("status", "pending");
  if (error) console.error("releaseQuoteCreation failed:", error.message);
}

/**
 * Delete a claim UNCONDITIONALLY — used only after an ambiguous claim has been reconciled and found
 * NOT to have created a sale (findSaleByExternalId returned null), so a fresh submit can proceed.
 * Safe precisely because reconciliation has just proven no Cin7 sale exists for this quote.
 */
export async function discardQuoteClaim(db: Db, orgId: string, instanceId: string, key: string): Promise<void> {
  const { error } = await db
    .from("quote_creation_claims")
    .delete()
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .eq("idempotency_key", key);
  if (error) console.error("discardQuoteClaim failed:", error.message);
}

/**
 * Mark a claim `ambiguous` after a create whose network outcome is unknown (Cin7ApiError.ambiguous).
 * Does NOT delete the claim — an immediate retry could create a genuine duplicate if the original
 * request actually reached Cin7. The claim stays (never age-reclaimed, migration 0080) until the
 * caller's reconciliation branch resolves it via the ExternalID.
 */
export async function markQuoteCreationAmbiguous(db: Db, orgId: string, instanceId: string, key: string): Promise<void> {
  const { error } = await db
    .from("quote_creation_claims")
    .update({ status: "ambiguous", updated_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .eq("idempotency_key", key)
    .eq("status", "pending");
  if (error) console.error("markQuoteCreationAmbiguous failed:", error.message);
}
