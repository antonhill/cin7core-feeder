// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readyWarnings, type AutoSkuFact, type AutoView, type ReadyLine } from "@/newquip/quote/estimator-workspace";
import { AutoSummary, PricingExceptions, ReadyForVerification } from "../[id]/AutoPricingSections";

afterEach(cleanup);
const auto = (o: Partial<AutoView> = {}): AutoView => ({
  active: true, autoPriced: 12, needConfirmation: 2, canPrice: true, retryable: 2,
  ready: [{ id: "concrete_slat", label: "Concrete slats", quantity: 10, unit: 287.5, revenue: 2875, totalCost: 2300, warnings: [], freightNotes: [], skus: [{ sku: "NQ1161", supplier: "Fixture Supplier", currency: "EUR", cost: "EUR 10.00", costDate: "2026-06-16", fx: "EUR 20.0000 as of 2026-11-16", freight: "× 1.15", landed: "R 230,00", selling: "R 287,50", provenance: "Auto from Cin7: 10.00 EUR", costNote: "Auto from Cin7: 10.00 EUR", freightNote: null, fxNote: null, quantity: 10 }] }],
  exceptions: [
    { sku: "SYSH-2750-3", usedBy: ["Bulk tank"], reason: "Not read from Cin7 in this run (out of time): it will be retried.", action: "Use Price from Cin7 to read it again.", taskId: "bulk_tank", retryable: true },
    { sku: "QCA00003", usedBy: ["Cup drinker package"], reason: "The USD exchange rate is not set in the commercial settings.", action: "Ask a Manager to enter the exchange rate.", taskId: "cup_drinker", retryable: false },
  ],
  ...o,
});

const FREIGHT = "Freight: Commercial settings v8: TEST-ONLY freight assumption, not approved policy.";
const COST = (i: number) => `Auto from Cin7: ${i}.00 USD last supplied 2026-05-01, +0% age escalation over 200 days (commercial settings v8). Needs verification.`;
const comp = (i: number, o: Partial<AutoSkuFact> = {}): AutoSkuFact => ({ sku: `COOL${String(i).padStart(3, "0")}`, supplier: `Supplier ${i}`, currency: "USD", cost: `USD ${i}.00`, costDate: "2026-05-01", fx: "USD 18.0000 as of 2026-11-20", freight: "× 1.10", landed: `R ${i},00`, selling: `R ${i + 5},00`, provenance: `${COST(i)} ${FREIGHT}`, costNote: COST(i), freightNote: FREIGHT, fxNote: "Exchange rate: Fixture feed.", quantity: i, ...o });
const cooling = (n: number, o: Partial<ReadyLine> = {}): ReadyLine => {
  const skus = Array.from({ length: n }, (_, i) => comp(i + 1));
  return { id: "cooling", label: "Sumpless pad cooling (20 m)", quantity: 12, unit: 146790.42, revenue: 1761485.04, totalCost: 1200000, skus, ...readyWarnings(skus), ...o };
};

describe("Ready for verification: compact lines (Estimator)", () => {
  it("a 45-component cooling package is ONE compact summary: description, quantity, total cost, selling price, status, component count", () => {
    render(<ReadyForVerification auto={auto({ ready: [cooling(45)] })} />);
    const sum = screen.getByTestId("ready-summary-cooling").textContent!;
    for (const t of ["Quantity", "12", "Total cost", "Selling price", "45 component supplier records"]) expect(sum).toContain(t);
    expect(screen.getByTestId("ready-status-cooling").textContent).toContain("awaiting Manager verification");
    expect(screen.getByText("Sumpless pad cooling (20 m)")).toBeTruthy();
    expect((screen.getByTestId("ready-details-cooling") as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByTestId("ready-details-cooling").querySelector("summary")!.textContent).toBe("View cost details · 45 records");
  });
  it("the TEST-ONLY freight warning is shown ONCE for the package (visible while collapsed), and the freight sentence is stated once in the details, not 45 times", () => {
    render(<ReadyForVerification auto={auto({ ready: [cooling(45)] })} />);
    const warns = screen.getByTestId("ready-warnings-cooling");
    expect(warns.textContent).toMatch(/TEST-ONLY assumption, not an approved policy/);
    expect(warns.querySelectorAll("li").length).toBe(1);
    const all = screen.getByTestId("auto-ready").textContent!;
    expect(all.split("TEST-ONLY freight assumption").length - 1).toBe(1);
    expect(screen.getByTestId("ready-freight-cooling").textContent).toMatch(/^All 45 components: Freight: Commercial settings v8/);
    expect(screen.getByTestId("auto-ready-critical").textContent).toContain("1 line carries a warning");
  });
  it("nothing is lost: every component's SKU, supplier, cost, date, FX, freight, landed and selling figures and its own cost note remain in the details", () => {
    render(<ReadyForVerification auto={auto({ ready: [cooling(45)] })} />);
    for (let i = 1; i <= 45; i++) {
      const row = screen.getByTestId(`ready-sku-COOL${String(i).padStart(3, "0")}`).textContent!;
      for (const t of [`Supplier ${i}`, `USD ${i}.00`, "2026-05-01", "USD 18.0000 as of 2026-11-20", "× 1.10", `R ${i},00`, `R ${i + 5},00`]) expect(row).toContain(t);
    }
    const all = screen.getByTestId("ready-details-cooling").textContent!;
    expect(all).toContain("Auto from Cin7: 7.00 USD last supplied 2026-05-01");
    expect(all).toContain("Exchange rate: Fixture feed.");
  });
  it("a freight source that DIFFERS between components is not collapsed into a single claim: each keeps its own", () => {
    const skus = [comp(1), comp(2, { freightNote: "Freight: Sea freight policy v2." })];
    render(<ReadyForVerification auto={auto({ ready: [cooling(0, { skus, ...readyWarnings(skus) })] })} />);
    expect(screen.queryByTestId("ready-freight-cooling")).toBeNull();
    const d = screen.getByTestId("ready-details-cooling").textContent!;
    expect(d).toContain("COOL001: " + COST(1)); expect(d).toContain("Freight: Commercial settings v8"); expect(d).toContain("Freight: Sea freight policy v2.");
    expect(screen.getByTestId("ready-warning-freight_unapproved").textContent).toContain("(1 of 2 components)");
  });
  it("a package with approved freight and no age escalation shows no warning", () => {
    const skus = [comp(1, { freightNote: "Freight: Approved policy v3.", costNote: COST(1) })];
    render(<ReadyForVerification auto={auto({ ready: [cooling(0, { skus, ...readyWarnings(skus) })] })} />);
    expect(screen.queryByTestId("ready-warnings-cooling")).toBeNull();
    expect(screen.queryByTestId("auto-ready-critical")).toBeNull();
  });
  it("an age-escalated cost is a (non-critical) warning counted once", () => {
    const aged = (i: number) => comp(i, { costNote: `Auto from Cin7: 1.00 USD last supplied 2023-05-17, +12.5% age escalation over 1280 days (commercial settings v8). Needs verification.`, freightNote: "Freight: Approved." });
    expect(readyWarnings([aged(1), aged(2), comp(3, { freightNote: null })]).warnings).toEqual([{ code: "cost_aged", severity: "notice", text: "2 costs are age-escalated (up to 12.5%)." }]);
  });
});

describe("automatic-pricing sections (Estimator)", () => {
  it("the summary states the three counts in words", () => {
    render(<AutoSummary auto={auto()} />);
    expect(screen.getByTestId("auto-count-priced").textContent).toBe("12 automatically priced — awaiting Manager verification");
    expect(screen.getByTestId("auto-count-confirm").textContent).toBe("2 need confirmation");
    expect(screen.getByTestId("auto-count-exceptions").textContent).toBe("2 pricing exceptions");
  });
  it("Ready for verification shows the evidence in place, with the awaiting-verification label, and asks for no cost", () => {
    render(<ReadyForVerification auto={auto()} />);
    const sec = screen.getByTestId("auto-ready");
    expect(sec.textContent).toContain("Automatically priced — awaiting Manager verification");
    for (const t of ["Fixture Supplier", "EUR 10.00", "2026-06-16", "EUR 20.0000 as of 2026-11-16", "× 1.15", "R 230,00", "R 287,50", "Auto from Cin7: 10.00 EUR"]) expect(sec.textContent).toContain(t);
    expect(screen.queryByText(/supplier cost needed/i)).toBeNull();
  });
  it("when Price from Cin7 cannot run the button is shown DISABLED with the plain-words reason (never an action that silently does nothing)", () => {
    const onPrice = vi.fn();
    render(<PricingExceptions auto={auto({ canPrice: false, retryable: 0, unavailableReason: "A Manager must complete the commercial settings (freight policy and exchange rates) before costs can be priced from Cin7." })} canEdit busy={false} onOpen={vi.fn()} onPrice={onPrice} />);
    expect(screen.queryByTestId("price-from-cin7")).toBeNull();
    const b = screen.getByTestId("price-from-cin7-disabled") as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(screen.getByTestId("price-from-cin7-why").textContent).toContain("A Manager must complete the commercial settings");
    fireEvent.click(b); expect(onPrice).not.toHaveBeenCalled();
  });
  it("each pricing exception shows its specific reason and corrective action; Price from Cin7 only where it can help; Open opens the task", () => {
    const onOpen = vi.fn(), onPrice = vi.fn();
    render(<PricingExceptions auto={auto()} canEdit busy={false} onOpen={onOpen} onPrice={onPrice} />);
    expect(screen.getByTestId("exception-reason-QCA00003").textContent).toBe("The USD exchange rate is not set in the commercial settings.");
    expect(screen.getByTestId("exception-action-QCA00003").textContent).toContain("Ask a Manager to enter the exchange rate.");
    expect(screen.getByTestId("exception-reason-SYSH-2750-3").textContent).toMatch(/will be retried/);
    fireEvent.click(screen.getByTestId("price-from-cin7")); expect(onPrice).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Open QCA00003" })); expect(onOpen).toHaveBeenCalledWith("cup_drinker");
  });
  it("no Price from Cin7 button when nothing can be retried or the viewer cannot price; nothing renders with no exceptions", () => {
    const { rerender } = render(<PricingExceptions auto={auto({ retryable: 0 })} canEdit busy={false} onOpen={() => {}} onPrice={() => {}} />);
    expect(screen.queryByTestId("price-from-cin7")).toBeNull();
    rerender(<PricingExceptions auto={auto({ canPrice: false })} canEdit busy={false} onOpen={() => {}} onPrice={() => {}} />);
    expect(screen.queryByTestId("price-from-cin7")).toBeNull();
    rerender(<PricingExceptions auto={auto({ exceptions: [] })} canEdit busy={false} onOpen={() => {}} onPrice={() => {}} />);
    expect(screen.queryByTestId("auto-exceptions")).toBeNull();
  });
});
