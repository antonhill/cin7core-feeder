// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutoView } from "@/newquip/quote/estimator-workspace";
import { AutoSummary, PricingExceptions, ReadyForVerification } from "../[id]/AutoPricingSections";

afterEach(cleanup);
const auto = (o: Partial<AutoView> = {}): AutoView => ({
  active: true, autoPriced: 12, needConfirmation: 2, canPrice: true, retryable: 2,
  ready: [{ id: "concrete_slat", label: "Concrete slats", quantity: 10, unit: 287.5, revenue: 2875, skus: [{ sku: "NQ1161", supplier: "Fixture Supplier", currency: "EUR", cost: "EUR 10.00", costDate: "2026-06-16", fx: "EUR 20.0000 as of 2026-11-16", freight: "× 1.15", landed: "R 230,00", selling: "R 287,50", provenance: "Auto from Cin7: 10.00 EUR" }] }],
  exceptions: [
    { sku: "SYSH-2750-3", usedBy: ["Bulk tank"], reason: "Not read from Cin7 in this run (out of time): it will be retried.", action: "Use Price from Cin7 to read it again.", taskId: "bulk_tank", retryable: true },
    { sku: "QCA00003", usedBy: ["Cup drinker package"], reason: "The USD exchange rate is not set in the commercial settings.", action: "Ask a Manager to enter the exchange rate.", taskId: "cup_drinker", retryable: false },
  ],
  ...o,
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
