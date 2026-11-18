// @vitest-environment jsdom
// ONE pricing-status summary: amber (never red) for provisional / incomplete pricing, the headline states a subtotal or a provisional estimate, the detail is expandable, and nothing internal is shown.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PricingStatusSummary } from "../[id]/PricingStatusSummary";
import type { BudgetPricingView } from "@/newquip/grower/budget-pricing";

afterEach(cleanup);
const base = (o: Partial<BudgetPricingView> = {}): BudgetPricingView => ({
  lines: [
    { itemKey: "feeder", label: "CCM feeder", quantity: 216, state: "priced", amountExVat: 2373230.88, note: null },
    { itemKey: "cup_drinker", label: "Grower cup drinker", quantity: 648, state: "provisional", amountExVat: 431082, note: "Provisional: the exact drinker product and its parts are still to be confirmed, so this price may change." },
    { itemKey: "pvc_door", label: "PVC SST door (incl. frame)", quantity: 24, state: "unpriced", amountExVat: null, note: "Product not yet confirmed" },
  ],
  counts: { priced: 1, provisional: 1, unpriced: 1 }, subtotalExVat: 2804312.88, provisionalValueExVat: 431082, unpricedItems: ["PVC SST door (incl. frame) × 24"], estimatedTotalExVat: null, estimatedTotalIncVat: null, totalBasis: null, incomplete: true, ...o,
});

describe("PricingStatusSummary", () => {
  it("incomplete: a priced SUBTOTAL, no total, amber (not red), with the detail behind an expandable control", () => {
    render(<PricingStatusSummary view={base()} />);
    const box = screen.getByTestId("pricing-status");
    expect(box.getAttribute("data-state")).toBe("incomplete");
    expect(box.className).toMatch(/amber/); expect(box.className).not.toMatch(/red/);
    expect(screen.getByTestId("pricing-status-headline").textContent).toMatch(/Priced subtotal .* A total is not available: 1 item has no price yet/);
    expect(box.querySelector("details")).not.toBeNull();
    expect(screen.getByTestId("provisional-lines").textContent).toContain("Grower cup drinker");
    expect(screen.getByTestId("unpriced-lines").textContent).toContain("PVC SST door");
  });
  it("complete with provisional lines: a PROVISIONAL ESTIMATE incl. VAT, still amber", () => {
    render(<PricingStatusSummary view={base({ lines: base().lines.filter((l) => l.state !== "unpriced"), counts: { priced: 1, provisional: 1, unpriced: 0 }, unpricedItems: [], estimatedTotalExVat: 2804312.88, estimatedTotalIncVat: 3224959.81, totalBasis: "provisional", incomplete: false })} />);
    expect(screen.getByTestId("pricing-status").getAttribute("data-state")).toBe("provisional");
    expect(screen.getByTestId("pricing-status-headline").textContent).toMatch(/Provisional estimate .* 1 line is provisional and most likely to change/);
  });
  it("fully priced: green, says the Estimator still verifies", () => {
    render(<PricingStatusSummary view={base({ lines: [base().lines[0]], counts: { priced: 1, provisional: 0, unpriced: 0 }, unpricedItems: [], estimatedTotalExVat: 2373230.88, estimatedTotalIncVat: 2729215.51, totalBasis: "budget", incomplete: false })} />);
    expect(screen.getByTestId("pricing-status").className).toMatch(/emerald/);
    expect(screen.getByTestId("pricing-status-headline").textContent).toMatch(/Estimator still verifies/);
  });
  it("incomplete for a reason OTHER than an unpriced line (e.g. a missing override reason): a subtotal, 'under review', never a total or R0.00 inc VAT", () => {
    render(<PricingStatusSummary view={base({ lines: base().lines.filter((l) => l.state !== "unpriced"), counts: { priced: 1, provisional: 1, unpriced: 0 }, unpricedItems: [], incomplete: true })} />);
    const h = screen.getByTestId("pricing-status-headline").textContent ?? "";
    expect(h).toMatch(/Priced subtotal .* still under review/);
    expect(h).not.toMatch(/Estimated total|Provisional estimate|inc VAT/);
    expect(screen.getByTestId("pricing-status").className).toMatch(/amber/);
  });
  it("shows nothing for a missing view and never shows an internal term", () => {
    const { container } = render(<PricingStatusSummary view={undefined} />); expect(container.textContent).toBe("");
    cleanup(); render(<PricingStatusSummary view={base()} />);
    expect(document.body.textContent).not.toMatch(/supplier|freight|markup|margin|NB3542|HNQ|FERAX/i);
  });
});
