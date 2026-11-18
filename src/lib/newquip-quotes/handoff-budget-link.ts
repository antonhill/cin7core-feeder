// Links the Rep's pre-approval acknowledgement to the Budget Quotation snapshot the customer was actually sent (read-only; it writes nothing and changes no baseline, amount or approval rule).
// The audit detail of the hand-off gets: the Budget's draft reference, send time and private snapshot reference (path + hash only), what was provisional and unpriced in THAT Budget, and what is
// provisional / unpriced at the moment of acknowledgement. Rep-safe labels and selling amounts only: no cost, rate, freight or markup. A failed lookup never blocks the hand-off.
import type { createServiceRoleClient } from "@/supabase/server";
import type { BudgetPricingView } from "@/newquip/grower/budget-pricing";
import { BUDGET_SEND_ACTION } from "./budget-quotation";

type Db = ReturnType<typeof createServiceRoleClient>;

export interface HandoffBudgetLink {
  linked: boolean;
  /** Why there is no link (no Budget Quotation was sent, or the lookup failed). */
  reason?: string;
  budgetSentAt?: string | null;
  budgetDraftRef?: string | null;
  budgetSnapshot?: { path: string; sha256: string } | null;
  budgetKnownSubtotalExVat?: number | null;
  budgetProvisionalItems?: string[];
  budgetUnpricedItems?: string[];
  /** The state of the pricing at the moment the Rep acknowledged: what the hand-off figure does and does not include. */
  atAcknowledgement?: { provisionalLines: Array<{ label: string; amountExVat: number | null }>; unpricedLines: string[]; budgetSubtotalExVat: number | null };
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export async function budgetSnapshotLinkFor(db: Db, orgId: string, quoteId: string, current: BudgetPricingView | undefined): Promise<HandoffBudgetLink> {
  const atAcknowledgement = current ? {
    provisionalLines: current.lines.filter((l) => l.state === "provisional").map((l) => ({ label: l.label, amountExVat: l.amountExVat })),
    unpricedLines: current.unpricedItems,
    budgetSubtotalExVat: current.subtotalExVat,
  } : undefined;
  try {
    const { data, error } = await db.from("activity_log").select("detail, created_at").eq("org_id", orgId).eq("action", BUDGET_SEND_ACTION)
      .eq("detail->>quoteId", quoteId).eq("detail->>status", "ACCEPTED").order("created_at", { ascending: false }).limit(1);
    if (error) return { linked: false, reason: "The Budget Quotation record could not be looked up.", atAcknowledgement };
    const row = (data ?? [])[0] as { detail?: Record<string, unknown>; created_at?: string } | undefined;
    if (!row?.detail) return { linked: false, reason: "No Budget Quotation was sent for this quotation.", atAcknowledgement };
    const d = row.detail;
    const internal = d.internalSnapshot as { path?: unknown; sha256?: unknown } | undefined;
    const model = (d.snapshot as { model?: { provisional?: { items?: unknown } } } | undefined)?.model;
    return {
      linked: true,
      budgetSentAt: row.created_at ?? null,
      budgetDraftRef: typeof d.draftRef === "string" ? d.draftRef : null,
      budgetSnapshot: internal && typeof internal.path === "string" && typeof internal.sha256 === "string" ? { path: internal.path, sha256: internal.sha256 } : null,
      budgetKnownSubtotalExVat: typeof d.knownSubtotalExVat === "number" ? d.knownSubtotalExVat : null,
      budgetProvisionalItems: strs(model?.provisional?.items),
      budgetUnpricedItems: strs(d.unpricedItems),
      atAcknowledgement,
    };
  } catch {
    return { linked: false, reason: "The Budget Quotation record could not be looked up.", atAcknowledgement };
  }
}
