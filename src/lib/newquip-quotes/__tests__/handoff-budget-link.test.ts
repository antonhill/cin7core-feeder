import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { budgetSnapshotLinkFor } from "../handoff-budget-link";
import type { BudgetPricingView } from "@/newquip/grower/budget-pricing";

const dbWith = (result: { data?: unknown[]; error?: unknown } | "throw") => {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "filter", "order"]) chain[m] = () => chain;
  chain.limit = () => (result === "throw" ? Promise.reject(new Error("boom")) : Promise.resolve({ data: result.data ?? [], error: result.error ?? null }));
  return { from: () => chain } as never;
};
const view = (o: Partial<BudgetPricingView> = {}): BudgetPricingView => ({
  lines: [
    { itemKey: "feeder", label: "CCM feeder", quantity: 216, state: "priced", amountExVat: 100, note: null },
    { itemKey: "cup_drinker", label: "Grower cup drinker", quantity: 648, state: "provisional", amountExVat: 50, note: "x" },
  ],
  counts: { priced: 1, provisional: 1, unpriced: 0 }, subtotalExVat: 150, provisionalValueExVat: 50, unpricedItems: [], estimatedTotalExVat: 150, estimatedTotalIncVat: 172.5, totalBasis: "provisional", incomplete: false, ...o,
});

describe("budgetSnapshotLinkFor", () => {
  it("links the latest accepted Budget send: snapshot reference, provisional and unpriced lines", async () => {
    const detail = { draftRef: "6842501d27a8", internalSnapshot: { path: "org/budget-snapshots/q/x.json", sha256: "abc" }, knownSubtotalExVat: 11129349.36, unpricedItems: ["PVC SST door × 24"], snapshot: { model: { provisional: { items: ["Grower cup drinker × 648"] } } } };
    const l = await budgetSnapshotLinkFor(dbWith({ data: [{ detail, created_at: "2026-11-18T10:07:35Z" }] }), "o", "q", view());
    expect(l.linked).toBe(true);
    expect(l.budgetDraftRef).toBe("6842501d27a8");
    expect(l.budgetSnapshot).toEqual({ path: "org/budget-snapshots/q/x.json", sha256: "abc" });
    expect(l.budgetProvisionalItems).toEqual(["Grower cup drinker × 648"]);
    expect(l.budgetUnpricedItems).toEqual(["PVC SST door × 24"]);
    expect(l.atAcknowledgement?.provisionalLines).toEqual([{ label: "Grower cup drinker", amountExVat: 50 }]);
  });
  it("no Budget sent: not linked, with a reason, still records the state at acknowledgement", async () => {
    const l = await budgetSnapshotLinkFor(dbWith({ data: [] }), "o", "q", view());
    expect(l.linked).toBe(false); expect(l.reason).toMatch(/No Budget Quotation/); expect(l.atAcknowledgement?.budgetSubtotalExVat).toBe(150);
  });
  it("a failed lookup (error or throw) never throws and never blocks the hand-off", async () => {
    expect((await budgetSnapshotLinkFor(dbWith({ error: { message: "x" } }), "o", "q", undefined)).linked).toBe(false);
    expect((await budgetSnapshotLinkFor(dbWith("throw"), "o", "q", undefined)).reason).toMatch(/could not be looked up/);
  });
  it("carries no cost, rate, freight or markup field", async () => {
    const l = await budgetSnapshotLinkFor(dbWith({ data: [{ detail: { draftRef: "r" }, created_at: "t" }] }), "o", "q", view());
    expect(JSON.stringify(l)).not.toMatch(/cost|freight|markup|margin|rate/i);
  });
});
