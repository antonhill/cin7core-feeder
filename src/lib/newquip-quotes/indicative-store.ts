import "server-only";
// NewQuip indicative price snapshots - persistence (NQ-008A). LOCAL ONLY: nothing here reaches Cin7. The table (migration 0123) is append-only and holds the
// confidential calculation basis, so it has no member read policy: it is read and written only here, through the service role, by Server Actions that have already
// authorised the caller. Every query is scoped by org_id.
import type { createServiceRoleClient } from "@/supabase/server";
import type { IndicativeSnapshot, IndicativeSnapshotIndex } from "@/newquip/pricing/indicative-snapshot";

type Db = ReturnType<typeof createServiceRoleClient>;

export interface StoredIndicativeSnapshot {
  id: string;
  quote_id: string;
  seq: number;
  revision: number;
  draft_hash: string;
  ruleset_id: string;
  ruleset_version: string;
  price_source_id: string;
  price_source_fingerprint: string;
  total_ex_vat_cents: number;
  completeness: "complete" | "provisional" | "not_priced";
  snapshot: IndicativeSnapshot;
  snapshot_hash: string;
  captured_by_email: string;
  created_at: string;
}

/** True when migration 0123 is not applied yet (no table / function): the handoff then proceeds as it always did, and the comparison says no snapshot exists. */
export const notAvailable = (m: string | undefined): boolean => /does not exist|schema cache|could not find the (table|function)|PGRST20[24]/i.test(m ?? "");
export const isHandoffConflict = (m: string | undefined): boolean => /handoff_conflict/i.test(m ?? "");

export type CaptureResult = { captured: true; id: string } | { captured: false; reason: "migration_not_applied" };

/**
 * ONE transaction (migration 0123): lock the quotation, check it is still the REP_DRAFT with this draft hash, store the snapshot, move to ESTIMATOR_REVIEW.
 * Throws on a conflict (the caller shows its usual "changed while sending" message) and on any other database error. Returns `captured: false` ONLY when the migration
 * is not applied, in which case NOTHING was written and the caller performs the legacy handoff.
 */
export async function handoffWithSnapshot(
  db: Db, orgId: string, quoteId: string,
  i: { draftHash: string; confirmedCents: number; confirmedBy: string; handoffBy: string; snapshot: IndicativeSnapshot; snapshotHash: string; index: IndicativeSnapshotIndex },
): Promise<CaptureResult> {
  const r = await db.rpc("newquip_handoff_with_snapshot", {
    p_org: orgId, p_quote: quoteId, p_draft_hash: i.draftHash,
    p_confirmed_cents: i.confirmedCents, p_confirmed_by: i.confirmedBy, p_handoff_by: i.handoffBy,
    p_snapshot: i.snapshot, p_snapshot_hash: i.snapshotHash, p_total_cents: i.index.totalExVatCents, p_completeness: i.index.completeness,
    p_ruleset_id: i.index.rulesetId, p_ruleset_version: i.index.rulesetVersion, p_price_source_id: i.index.priceSourceId, p_price_source_fingerprint: i.index.priceSourceFingerprint,
    p_captured_by: i.handoffBy,
  });
  if (r.error) {
    if (isHandoffConflict(r.error.message)) throw new Error("The quote changed while sending; refresh and try again.");
    if (notAvailable(r.error.message)) return { captured: false, reason: "migration_not_applied" };
    throw new Error(r.error.message);
  }
  return { captured: true, id: r.data as string };
}

/** The snapshot of the quotation's LATEST handoff, or null (none captured, or migration 0123 not applied). */
export async function latestIndicativeSnapshot(db: Db, orgId: string, quoteId: string): Promise<StoredIndicativeSnapshot | null> {
  const r = await db.from("newquip_indicative_price_snapshots").select("*").eq("org_id", orgId).eq("quote_id", quoteId).order("seq", { ascending: false }).limit(1);
  if (r.error) { if (notAvailable(r.error.message)) return null; throw new Error(r.error.message); }
  return ((r.data ?? []) as StoredIndicativeSnapshot[])[0] ?? null;
}

/** Every handoff snapshot of the quotation, oldest first (empty when none, or when migration 0123 is not applied). */
export async function allIndicativeSnapshots(db: Db, orgId: string, quoteId: string): Promise<StoredIndicativeSnapshot[]> {
  const r = await db.from("newquip_indicative_price_snapshots").select("*").eq("org_id", orgId).eq("quote_id", quoteId).order("seq", { ascending: true });
  if (r.error) { if (notAvailable(r.error.message)) return []; throw new Error(r.error.message); }
  return (r.data ?? []) as StoredIndicativeSnapshot[];
}
