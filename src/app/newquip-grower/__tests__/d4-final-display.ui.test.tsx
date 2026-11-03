// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CostPanelBody, type CostPanelBodyProps } from "../[id]/CostPanel";
import { ProductMappingPicker } from "../[id]/ProductMappingPicker";
import { normaliseOption } from "@/lib/projects/supplier-price";
import { formatMicroAmount, NBSP } from "@/lib/format-money";

// D4 final-audit display stragglers: C (disabled Builder controls give a visible, linked reason) and A (supplier unit costs use the shared money formatter).
vi.mock("../actions", () => ({ searchCin7CatalogueForMappingAction: vi.fn() }));
afterEach(cleanup);
const described = (el: HTMLElement) => (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean).map((i) => document.getElementById(i)?.textContent ?? "").join(" ");

describe("C: Search (product mapping picker)", () => {
  it("says why it is disabled until two characters are typed, then has no reason", () => {
    render(<ProductMappingPicker label="Feeder" value={undefined} onChange={() => {}} />);
    const btn = screen.getByRole("button", { name: "Search" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(described(btn)).toMatch(/at least 2 characters/);
    fireEvent.change(screen.getByLabelText(/Search Cin7 for Feeder/), { target: { value: "ab" } });
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute("aria-describedby")).toBeNull();
  });
});

const body = (over: Partial<CostPanelBodyProps> = {}): CostPanelBodyProps => ({
  v: { frozen: false, estimate: null, skuOptions: { "A-1": { options: [normaliseOption({ supplierId: "s1", supplierName: "Acme", cost: 5, currency: "ZAR", lastSupplied: null, stockUnit: null, statedUnitFields: [] }, { fx: {}, nowIso: "2026-11-03T00:00:00Z", maxRateAgeHours: 72, unitBasis: null })] } }, unitBasis: null, incompleteAccepted: null, canCapture: false, note: "", fx: {}, fxAvailable: true } as never,
  loading: false, error: null, note: null, busy: false, manual: null, onCapture: vi.fn(), onRetry: vi.fn(), onClearManual: vi.fn(), onStartManual: vi.fn(), onManualChange: vi.fn(), onSaveManual: vi.fn(),
  onConfirmUnit: vi.fn(), onAcceptIncomplete: vi.fn(), ...over,
});
describe("C: Confirm per stock unit / Record exception", () => {
  it("each says what is missing, clears when satisfied, and says when another action is running", () => {
    const { rerender } = render(<CostPanelBody {...body()} />);
    const unit = screen.getByRole("button", { name: "Confirm per stock unit" }) as HTMLButtonElement;
    const exc = screen.getByRole("button", { name: "Record exception" }) as HTMLButtonElement;
    expect(unit.disabled && exc.disabled).toBe(true);
    expect(described(unit)).toMatch(/at least 10 characters/);
    expect(described(exc)).toMatch(/at least 10 characters/);
    fireEvent.change(screen.getByLabelText(/How do you know/), { target: { value: "Supplier price list says per unit" } });
    fireEvent.change(screen.getByLabelText(/Exception reason/), { target: { value: "Owner accepted the gap" } });
    expect(unit.disabled || exc.disabled).toBe(false);
    expect(unit.getAttribute("aria-describedby")).toBeNull();
    rerender(<CostPanelBody {...body({ busy: true })} />);
    expect(described(screen.getByRole("button", { name: "Confirm per stock unit" }))).toMatch(/Another action is in progress/);
    expect(described(screen.getByRole("button", { name: "Record exception" }))).toMatch(/Another action is in progress/);
  });
});

describe("A: supplier unit costs use the shared formatter", () => {
  it("R with NBSP separators and a comma decimal, never ICU 'ZAR 1 234,56'", () => {
    expect(formatMicroAmount(1_234_560_000, "ZAR")).toBe(`R${NBSP}1${NBSP}234,56`);
    expect(formatMicroAmount(4_200, "ZAR")).toBe(`R${NBSP}0,0042`); // a real sub-cent unit cost is not rounded to R 0,00
    expect(formatMicroAmount(12_500_000, "USD")).toBe(`USD${NBSP}12,50`);
    expect(formatMicroAmount(-5_000_000, "ZAR")).toBe(`-R${NBSP}5,00`);
    expect(formatMicroAmount(null, "ZAR")).toBe("—");
  });
});
