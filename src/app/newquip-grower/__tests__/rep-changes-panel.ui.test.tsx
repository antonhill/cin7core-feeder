// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { RepChangesPanel, repChangesSummary } from "../[id]/ReturnNotice";
import { compareRepRevisions } from "@/newquip/quote/rep-revision-changes";
import type { IndicativeSnapshot } from "@/newquip/pricing/indicative-snapshot";

type CS = IndicativeSnapshot["customerSafe"]; type L = CS["lines"][number];
const fmt = (c: number) => `R ${(c / 100).toFixed(2)}`;
const L = (k: string, label: string, q: number, u: number): L => ({ itemKey: k, label, status: "priced", sku: "X", quantity: q, unitPriceExVat: u, revenueCents: Math.round(q * u * 100), pricedBy: null });
const S = (lines: L[], charges: CS["charges"] = []): CS => { const sub = lines.reduce((a, l) => a + (l.revenueCents ?? 0), 0) + charges.reduce((a, c) => a + (c.amountCents ?? 0), 0); return { quoteRef: "Q", revision: 1, quoteType: "project", completeness: "complete" as CS["completeness"], awaiting: [], lines, charges, subtotalCents: sub, taxCents: sub * 0.15, totalCents: sub * 1.15, taxRule: "", taxRateBps: 1500, taxInclusive: false }; };
const run = (a: CS | null, b: CS | null) => compareRepRevisions({ previous: a, previousCapturedAt: "2026-11-26T10:00:00Z", current: b, currentRevision: 2, currentDraftHash: "h" });

afterEach(cleanup);
describe("RepChangesPanel", () => {
  const a = S([L("a", "Feeder", 10, 100), L("b", "Drinker", 4, 50)], [{ key: "delivery", label: "Delivery", amountCents: 100000, status: "entered" }]);
  const b = S([L("a", "Feeder", 12, 100), L("c", "Heater", 1, 500)], [{ key: "delivery", label: "Delivery", amountCents: 120000, status: "entered" }]);
  it("summarises in the banner, labels Added/Removed/Changed, old and new values, charges, and the reason", () => {
    render(<RepChangesPanel changes={run(a, b)} fmt={fmt} reason="Quantity corrected after site visit" />);
    expect(screen.getByTestId("rep-changes-summary").textContent).toMatch(/1 added, 1 removed, 1 changed, 1 charge changed/);
    expect(screen.getByTestId("view-changes").textContent).toBe("View Changes");
    expect(within(screen.getByTestId("change-line-c")).getByText("Added")).toBeTruthy();
    expect(within(screen.getByTestId("change-line-b")).getByText("Removed")).toBeTruthy();
    const ch = screen.getByTestId("change-line-a");
    expect(ch.textContent).toMatch(/Changed/); expect(ch.textContent).toMatch(/Qty 10/); expect(ch.textContent).toMatch(/Qty 12/);
    expect(screen.getByTestId("change-charge-delivery").textContent).toMatch(/R 1000\.00 → R 1200\.00/);
    expect(screen.getByTestId("rep-changes-reason").textContent).toMatch(/Quantity corrected after site visit/);
    expect(screen.getByTestId("rep-changes-totals").textContent).toMatch(/Difference/);
  });
  it("changed items come first and unchanged lines are folded", () => {
    const same = S([L("a", "Feeder", 10, 100), L("z", "Panel", 1, 10)]);
    render(<RepChangesPanel changes={run(same, S([L("a", "Feeder", 11, 100), L("z", "Panel", 1, 10)]))} fmt={fmt} />);
    const un = screen.getByTestId("rep-changes-unchanged");
    expect(un.tagName).toBe("DETAILS"); expect((un as HTMLDetailsElement).open).toBe(false); expect(un.textContent).toMatch(/1 unchanged line/);
    expect(within(screen.getByTestId("rep-changes-lines")).getByTestId("change-line-a")).toBeTruthy();
  });
  it("says so plainly when nothing changed", () => {
    render(<RepChangesPanel changes={run(a, S(a.lines, a.charges))} fmt={fmt} />);
    expect(screen.getByTestId("rep-changes-summary").textContent).toBe("No customer-facing quotation changes detected");
    expect(screen.getByTestId("rep-changes-none").textContent).toBe("No customer-facing quotation changes detected");
  });
  it("older revision: no itemised view, states why, never an empty comparison", () => {
    render(<RepChangesPanel changes={run(null, b)} fmt={fmt} />);
    expect(screen.getByTestId("rep-changes-unavailable").textContent).toMatch(/not available for this revision/);
    expect(screen.queryByTestId("view-changes")).toBeNull();
  });
  it("renders nothing without a comparison", () => { const { container } = render(<RepChangesPanel changes={undefined} fmt={fmt} />); expect(container.textContent).toBe(""); });
  it("summary with totals only", () => expect(repChangesSummary(run(null, b), fmt)).toBe("Itemised changes are not available for this revision."));
});
