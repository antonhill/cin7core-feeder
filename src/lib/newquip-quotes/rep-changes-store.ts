import "server-only";
// Reads the Rep's "what changed since you last confirmed" comparison. Read-only: no write, no migration, no Cin7, no fetch. It reads ONLY the quotation's own handoff snapshots (org + quote scoped) and
// evaluates the current draft with cost WITHHELD; the comparison module's whitelisted output is all that leaves (see rep-revision-changes.ts).
import type { createServiceRoleClient } from "@/supabase/server";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { customerSafeSectionOf } from "@/newquip/pricing/indicative-snapshot";
import { compareRepRevisions, previousHandoffOf, type RepRevisionChanges } from "@/newquip/quote/rep-revision-changes";
import type { QuoteRecord } from "./quote-store";
import { allIndicativeSnapshots } from "./indicative-store";
import { evaluationContext } from "./context";

type Db = ReturnType<typeof createServiceRoleClient>;

/**
 * Non-null only for a quotation that is back with the Rep as a later revision (REP_DRAFT, revision >= 2): the only time there is a "previous revision" the Rep confirmed. Never throws: a read
 * problem yields null and the banner simply shows the return reason as before.
 */
export async function repChangesOf(db: Db, orgId: string, quote: Pick<QuoteRecord, "id" | "org_id" | "state" | "revision" | "draft" | "draft_hash" | "quote_ref">): Promise<RepRevisionChanges | null> {
  if (quote.state !== "REP_DRAFT" || quote.revision < 2 || quote.org_id !== orgId) return null;
  try {
    const snaps = await allIndicativeSnapshots(db, orgId, quote.id);
    const { snapshot, gap } = previousHandoffOf(snaps, quote.revision);
    // The SAME evaluation the handoff used (evaluationContext(true) = cost withheld): the Rep's own view, so "now" and "then" differ only by real changes.
    const budget = evaluateDraft(quote.draft, evaluationContext(true)).budget;
    const current = budget ? customerSafeSectionOf({ quoteRef: quote.quote_ref, revision: quote.revision, quoteType: quote.draft.quoteType, rep: budget }) : null;
    const r = compareRepRevisions({ previous: gap ? null : snapshot?.snapshot.customerSafe ?? null, previousCapturedAt: snapshot?.created_at ?? null, current, currentRevision: quote.revision, currentDraftHash: quote.draft_hash });
    return gap && r.unavailableReason === "NO_SNAPSHOT" ? { ...r, unavailableReason: "REVISION_GAP" } : r;
  } catch (e) {
    console.error(`[newquip] rep revision comparison unavailable: ${e instanceof Error ? e.message.slice(0, 200) : "unknown"}`);
    return null;
  }
}
