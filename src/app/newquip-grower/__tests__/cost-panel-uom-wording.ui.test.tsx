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
const CONF = { basis: "STOCK_UNIT" as const, confirmedBy: "anton@x", confirmedAt: "2026-11-01T08:00:00Z", reason: "Price list says per unit" };
const env = { fx: {}, nowIso: "2026-11-03T00:00:00Z", maxRateAgeHours: 72, unitBasis: null as typeof CONF | null };
const CONFENV = { ...env, unitBasis: CONF };
const opt = (over: Partial<RawSupplierPrice> = {}, e: typeof env = env): SupplierOption => normaliseOption({ supplierId: "s1", supplierName: "Acme", cost: 5, currency: "ZAR", lastSupplied: null, stockUnit: "Each", statedUnitFields: [], ...over }, e);
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
  it("2a. a record that states unit fields: amber, per SKU, names the fields, says confirming does not help, and offers NO confirm control", () => {
    const p = props(view({ "A-1": sku(opt({ statedUnitFields: ["ProductSupplierOptions.PackSize", "SupplierUOM"] })) }));
    render(<CostPanelBody {...p} />);
    const ex = screen.getByTestId("uom-exceptions");
    expect(ex.className).toMatch(/amber/);
    expect(ex.textContent).toContain("A-1 (Acme): Cin7 returned unit information on this price (ProductSupplierOptions.PackSize, SupplierUOM) that this tool cannot interpret.");
    expect(screen.getByTestId("uom-not-confirmable").textContent).toMatch(/does not unblock.*Correct that supplier record in Cin7.*manual estimate.*exception/);
    expect(text()).not.toContain(OLD);
    expect(text()).not.toContain(NEUTRAL);
    expect(confirm()).toBeNull();
    noActionCalled(p);
  });
  it("2c. BAD_CONVERSION_FACTOR (purchase unit differs from stock unit): shown with its reason, no confirm control", () => {
    const p = props(view({ "D-4": sku(opt({ purchaseUnit: "Box", stockUnit: "Each" })) }));
    render(<CostPanelBody {...p} />);
    expect(screen.getByTestId("uom-exceptions").textContent).toContain('D-4 (Acme): The price is quoted per "Box" but the stock unit is "Each"');
    expect(screen.getByTestId("uom-not-confirmable")).toBeTruthy();
    expect(confirm()).toBeNull();
  });
  it("2b. unknown stock unit: says Cin7 did not return the stock unit, keeps the control", () => {
    const p = props(view({ "C-3": sku(opt({ stockUnit: null })) }));
    render(<CostPanelBody {...p} />);
    expect(screen.getByTestId("uom-exceptions").textContent).toContain("C-3 (Acme): Cin7 did not return the product's stock unit.");
    expect(confirm()).not.toBeNull();
    expect(screen.getByTestId("uom-confirm-scope").textContent).toContain("C-3");
    expect(screen.queryByTestId("uom-not-confirmable")).toBeNull();
    expect(text()).not.toContain(OLD);
    const b = confirm()!; expect(b.disabled).toBe(true);
    expect(document.getElementById(b.getAttribute("aria-describedby")!)!.textContent).toMatch(/at least 10 characters/);
    noActionCalled(p);
  });
  it("3. legacy snapshot (statedUnitFields undefined): honest recapture text with the replace caveat; confirm offered only because it really unblocks it; nothing triggered", () => {
    const legacy = opt(); const raw = { ...legacy.raw }; delete raw.statedUnitFields;
    const o = normaliseOption(raw, env);
    expect(o.status).toBe("UNUSABLE");
    const p = props(view({ "Q-9": sku(o) }));
    render(<CostPanelBody {...p} />);
    expect(screen.getByTestId("uom-legacy").textContent).toContain(`${LEGACY} (Q-9). Capture the latest Cin7 costs again to apply the current rule. Capturing again replaces the recorded costs; nothing is captured automatically.`);
    expect(screen.queryByTestId("uom-exceptions")).toBeNull();
    expect(confirm()).not.toBeNull();
    expect(screen.getByTestId("uom-confirm-scope").textContent).toContain("Q-9");
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
    expect(confirm()).toBeNull();
  });
  it("5b. mixed with a confirmable and a non-confirmable exception: control scoped to the confirmable SKU only", () => {
    render(<CostPanelBody {...props(view({ "B-2": sku(opt({ statedUnitFields: ["PackSize"] })), "C-3": sku(opt({ stockUnit: null })) }))} />);
    expect(screen.getByTestId("uom-confirm-scope").textContent).toBe("Confirming per stock unit unblocks: C-3.");
    expect(screen.getByTestId("uom-not-confirmable")).toBeTruthy();
    expect(confirm()).not.toBeNull();
  });
  it("4a. already confirmed with nothing left: confirmed text only, no control", () => {
    const v = view({ "A-1": sku(opt()) }, { unitBasis: CONF });
    render(<CostPanelBody {...props(v)} />);
    expect(text()).toContain("Confirmed per stock unit by anton@x");
    expect(text()).toContain("Price list says per unit");
    expect(text()).not.toContain(OLD);
    expect(screen.queryByTestId("uom-exceptions")).toBeNull();
    expect(confirm()).toBeNull();
  });
  it("4c. confirmed but a price remains blocked on the server (stated fields): both shown, no control", () => {
    render(<CostPanelBody {...props(view({ "A-1": sku(opt({ statedUnitFields: ["PackSize"] }, CONFENV)) }, { unitBasis: CONF }))} />);
    expect(text()).toContain("Confirmed per stock unit by anton@x");
    expect(screen.getByTestId("uom-exceptions").textContent).toContain("A-1 (Acme)");
    expect(confirm()).toBeNull();
  });
  it("all options unusable for another reason (no exchange rate): says nothing about the unit", () => {
    const o = opt({ currency: "USD" });
    expect(o.problems.some((x) => x.code === "NO_RATE")).toBe(true);
    render(<CostPanelBody {...props(view({ "A-1": sku(o) }))} />);
    expect(text()).not.toContain("No supplier prices have been read yet");
    expect(text()).not.toContain(NEUTRAL);
    expect(screen.queryByTestId("uom-exceptions")).toBeNull();
    expect(confirm()).toBeNull();
  });
  it("what confirmation really unblocks (real normaliseOption with env.unitBasis): no-stock-unit and legacy yes; stated fields and bad conversion no", () => {
    const legacyRaw = (over: Partial<RawSupplierPrice> = {}) => { const r = { ...opt(over).raw }; delete r.statedUnitFields; return r; };
    const usable = (raw: RawSupplierPrice) => normaliseOption(raw, CONFENV).status === "USABLE";
    const blocked = (raw: RawSupplierPrice) => normaliseOption(raw, env).status === "UNUSABLE";
    const noStock = opt({ stockUnit: null }).raw, legacyNoUnit = legacyRaw(), legacyStock = legacyRaw({ stockUnit: "Each" });
    for (const r of [noStock, legacyNoUnit, legacyStock]) { expect(blocked(r)).toBe(true); expect(usable(r)).toBe(true); }
    expect(normaliseOption(legacyStock, CONFENV).unitBasisSource).toBe("CONFIRMED_BY_USER");
    const stated = opt({ statedUnitFields: ["PackSize"] }).raw, badConv = opt({ purchaseUnit: "Box", stockUnit: "Each" }).raw, badFactor = opt({ conversionFactor: -2 }).raw;
    for (const r of [stated, badConv, badFactor]) { expect(blocked(r)).toBe(true); expect(usable(r)).toBe(false); }
    // and the panel's derivation offers confirmation for exactly the resolvable ones
    const d = (r: RawSupplierPrice) => deriveUnitStatus({ X: sku(normaliseOption(r, env)) }).confirmableSkus.length;
    expect([noStock, legacyNoUnit, legacyStock].map(d)).toEqual([1, 1, 1]);
    expect([stated, badConv, badFactor].map(d)).toEqual([0, 0, 0]);
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
