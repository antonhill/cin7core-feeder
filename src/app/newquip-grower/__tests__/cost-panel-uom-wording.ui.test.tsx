// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CostPanelBody, type CostPanelBodyProps } from "../[id]/CostPanel";
import { deriveUnitStatus } from "../[id]/cost-unit-status";
import { normaliseOption, type RawSupplierPrice, type SupplierOption } from "@/lib/projects/supplier-price";
import type { QuoteCostView, SkuOptionsView } from "../cost-actions";

// After #187: Cin7 keeps ONE unit per product, so a supplier record that states no unit field is per stock unit. The CostPanel must say so quietly, and keep the
// alarming "unusable" wording + the confirm control for genuine exceptions only. Presentation only: the options below come from the real normaliser.
vi.mock("../actions", () => ({}));
afterEach(cleanup);
const OLD = "Cin7 does not say which unit a supplier price is for";
const NEUTRAL = "Supplier prices are per stock unit (Cin7 keeps one unit per product and these supplier records state no unit of their own).";
const LEGACY = "This cost snapshot was captured before unit information was tracked, so the unit of these prices cannot be established";
const env = { fx: {}, nowIso: "2026-11-03T00:00:00Z", maxRateAgeHours: 72, unitBasis: null };
const opt = (over: Partial<RawSupplierPrice> = {}): SupplierOption => normaliseOption({ supplierId: "s1", supplierName: "Acme", cost: 5, currency: "ZAR", lastSupplied: null, stockUnit: "Each", statedUnitFields: [], ...over }, env);
const sku = (...options: SupplierOption[]): SkuOptionsView => ({ options, selection: null, selectionStatus: null, message: null, needsRecalculation: false });
const view = (skuOptions: Record<string, SkuOptionsView>, over: Partial<QuoteCostView> = {}) => ({ frozen: false, estimate: null, skuOptions, unitBasis: null, incompleteAccepted: null, canCapture: true, note: "", fx: {}, fxAvailable: true, ...over }) as unknown as QuoteCostView;
const props = (v: QuoteCostView, over: Partial<CostPanelBodyProps> = {}): CostPanelBodyProps => ({
  v, loading: false, error: null, note: null, busy: false, manual: null, onCapture: vi.fn(), onRetry: vi.fn(), onClearManual: vi.fn(), onStartManual: vi.fn(), onManualChange: vi.fn(), onSaveManual: vi.fn(),
  onConfirmUnit: vi.fn(), onAcceptIncomplete: vi.fn(), onRecalculate: vi.fn(), onRecordFx: vi.fn(), onSelect: vi.fn(), ...over,
});
const text = () => document.body.textContent ?? "";
const confirm = () => screen.queryByRole("button", { name: "Confirm per stock unit" }) as HTMLButtonElement | null;
const noActionCalled = (p: CostPanelBodyProps) => { for (const k of ["onCapture", "onConfirmUnit", "onAcceptIncomplete", "onRecalculate", "onRecordFx", "onSelect", "onRetry", "onSaveManual"] as const) expect((p[k] as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled(); };

describe("CostPanel unit-of-measure wording", () => {
  it("1. no unit exceptions: a quiet neutral line, no amber, no control, old sentence absent", () => {
    const p = props(view({ "A-1": sku(opt()), "B-2": sku(opt({ stockUnit: "Each", purchaseUnit: "each" })) }));
    render(<CostPanelBody {...p} />);
    expect(text()).toContain(NEUTRAL);
    expect(text()).not.toContain(OLD);
    expect(screen.queryByTestId("uom-exceptions")).toBeNull();
    expect(confirm()).toBeNull();
    expect(screen.queryByLabelText(/How do you know/)).toBeNull();
    expect(screen.getByText(NEUTRAL).className).not.toMatch(/amber/);
    noActionCalled(p);
  });
  it("2a. a record that states unit fields: amber, per SKU, names the fields, keeps the confirm control with its disabled reason", () => {
    const p = props(view({ "A-1": sku(opt({ statedUnitFields: ["ProductSupplierOptions.PackSize", "SupplierUOM"] })) }));
    render(<CostPanelBody {...p} />);
    const ex = screen.getByTestId("uom-exceptions");
    expect(ex.className).toMatch(/amber/);
    expect(ex.textContent).toContain("A-1 (Acme): Cin7 returned unit information on this price (ProductSupplierOptions.PackSize, SupplierUOM) that this tool cannot interpret.");
    expect(text()).not.toContain(OLD);
    expect(text()).not.toContain(NEUTRAL);
    const b = confirm()!;
    expect(b.disabled).toBe(true);
    expect(document.getElementById(b.getAttribute("aria-describedby")!)!.textContent).toMatch(/at least 10 characters/);
    noActionCalled(p);
  });
  it("2b. unknown stock unit: says Cin7 did not return the stock unit, keeps the control", () => {
    const p = props(view({ "C-3": sku(opt({ stockUnit: null })) }));
    render(<CostPanelBody {...p} />);
    expect(screen.getByTestId("uom-exceptions").textContent).toContain("C-3 (Acme): Cin7 did not return the product's stock unit.");
    expect(confirm()).not.toBeNull();
    expect(text()).not.toContain(OLD);
    noActionCalled(p);
  });
  it("3. legacy snapshot (statedUnitFields undefined): honest recapture text, no confirm control, nothing triggered", () => {
    const legacy = opt(); const raw = { ...legacy.raw }; delete raw.statedUnitFields;
    const o = normaliseOption(raw, env);
    expect(o.status).toBe("UNUSABLE");
    const p = props(view({ "Q-9": sku(o) }));
    render(<CostPanelBody {...p} />);
    expect(screen.getByTestId("uom-legacy").textContent).toContain(`${LEGACY} (Q-9). Capture the latest Cin7 costs again to apply the current rule.`);
    expect(screen.queryByTestId("uom-exceptions")).toBeNull();
    expect(confirm()).toBeNull();
    expect(text()).not.toContain(OLD);
    noActionCalled(p);
  });
  it("5. mixed: exceptions shown, the other prices summarised (collapsed) as per stock unit", () => {
    const p = props(view({ "A-1": sku(opt()), "B-2": sku(opt({ statedUnitFields: ["PackSize"] })) }));
    render(<CostPanelBody {...p} />);
    expect(screen.getByTestId("uom-exceptions").textContent).toContain("B-2 (Acme)");
    expect(screen.getByTestId("uom-exceptions").textContent).not.toContain("A-1");
    const d = document.querySelector("details")!;
    expect(d.open).toBe(false);
    expect(d.textContent).toContain("1 other supplier price is per stock unit");
    expect(d.textContent).toContain(NEUTRAL);
    expect(confirm()).not.toBeNull();
  });
  it("4a. already confirmed: unchanged text and no exceptions/control", () => {
    const v = view({ "A-1": sku(opt()) }, { unitBasis: { basis: "STOCK_UNIT", confirmedBy: "anton@x", confirmedAt: "2026-11-01T08:00:00Z", reason: "Price list says per unit" } });
    render(<CostPanelBody {...props(v)} />);
    expect(text()).toContain("Confirmed per stock unit by anton@x");
    expect(text()).toContain("Price list says per unit");
    expect(text()).not.toContain(OLD);
    expect(confirm()).toBeNull();
  });
  it("4b. frozen: read-only wording, no controls, even with an exception", () => {
    const v = view({}, { frozen: true, canCapture: false });
    render(<CostPanelBody {...props(v)} />);
    expect(text()).toContain("No unit-of-measure confirmation was recorded on this frozen estimate.");
    expect(confirm()).toBeNull();
    expect(text()).not.toContain(OLD);
    cleanup();
    render(<CostPanelBody {...props(view({ "A-1": sku(opt({ statedUnitFields: ["PackSize"] })) }, { frozen: true, canCapture: false }))} />);
    expect(confirm()).toBeNull();
    expect(screen.getByTestId("uom-exceptions")).toBeTruthy();
  });
  it("observer (no onConfirmUnit): the explanation shows, no control", () => {
    render(<CostPanelBody {...props(view({ "A-1": sku(opt({ statedUnitFields: ["PackSize"] })) }), { onConfirmUnit: undefined })} />);
    expect(screen.getByTestId("uom-exceptions")).toBeTruthy();
    expect(confirm()).toBeNull();
  });
  it("nothing captured yet: neutral note, no alarm, no control", () => {
    render(<CostPanelBody {...props(view({}))} />);
    expect(text()).toContain("No supplier prices have been read yet.");
    expect(confirm()).toBeNull();
    expect(text()).not.toContain(OLD);
  });
  it("the derivation counts usable vs exception vs legacy and is pure over its input", () => {
    const legacy = (() => { const r = { ...opt().raw }; delete r.statedUnitFields; return normaliseOption(r, env); })();
    const s = deriveUnitStatus({ A: sku(opt(), opt({ supplierName: "Z" })), B: sku(opt({ statedUnitFields: ["X"] })), C: sku(legacy) });
    expect(s.perStockUnit).toBe(2); expect(s.exceptions).toHaveLength(1); expect(s.legacySkus).toEqual(["C"]);
  });
  it("the new derivation module imports no server action or store", () => {
    const src = readFileSync(join(process.cwd(), "src/app/newquip-grower/[id]/cost-unit-status.ts"), "utf8");
    expect(src.match(/^import .*$/gm)).toEqual(['import type { SkuOptionsView } from "../cost-actions";']);
  });
});
