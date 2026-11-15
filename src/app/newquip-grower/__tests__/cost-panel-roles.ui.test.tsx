// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CostPanelBody, type CostPanelBodyProps } from "../[id]/CostPanel";
import { normaliseOption } from "@/lib/projects/supplier-price";
import type { QuoteCostView, SkuOptionsView } from "../cost-actions";

// Legacy CostPanel is role-aware: the server accepts the Cin7 capture / supplier choice / recalculation / FX / manual estimate / unit basis from an ESTIMATOR only, and the incomplete-costing waiver
// from a MANAGER only, so each control is offered only to that role (others see a read-only note). Without `roles` the panel behaves as before.
vi.mock("../actions", () => ({}));
afterEach(cleanup);
const env = { fx: {}, nowIso: "2026-11-03T00:00:00Z", maxRateAgeHours: 72, unitBasis: null };
const option = normaliseOption({ supplierId: "s1", supplierName: "Acme", cost: 5, currency: "ZAR", lastSupplied: null, stockUnit: "Each", statedUnitFields: [], ...({} as object) } as never, env as never);
const so: SkuOptionsView = { options: [option], selection: null, selectionStatus: null, message: null, needsRecalculation: true };
const line = { sku: "A-1", description: "Thing", quantity: 1, supplier: null, unitCostCents: null, totalCostCents: null, status: "MISSING", issue: "NO_USABLE_PRICE", reason: null, basis: null };
const view = { frozen: false, estimate: { lines: [line], totalCostCents: 0, incomplete: true, missingSkus: ["A-1"], unresolvedPackages: [] }, skuOptions: { "A-1": so }, unitBasis: null, incompleteAccepted: null, canCapture: true, note: "", fx: {}, fxAvailable: true, contractCents: null, complete: false, marginPct: null, gpCents: null } as unknown as QuoteCostView;
const props = (roles?: { estimator: boolean; manager: boolean }): CostPanelBodyProps => ({
  v: view, loading: false, error: null, note: null, busy: false, manual: null, onCapture: vi.fn(), onRetry: vi.fn(), onClearManual: vi.fn(), onStartManual: vi.fn(), onManualChange: vi.fn(), onSaveManual: vi.fn(),
  onConfirmUnit: vi.fn(), onAcceptIncomplete: vi.fn(), onRecalculate: vi.fn(), onRecordFx: vi.fn(), onSelect: vi.fn(), roles,
});
const has = (re: RegExp) => screen.queryByRole("button", { name: re }) !== null;
const MUTATIONS = [/Capture latest costs from Cin7/, /Capture and replace my selections/, /Recalculate with current rates/, /Record rate/, /Add manual estimate/];

describe("legacy CostPanel is role-aware", () => {
  it("an Estimator (not Manager) gets the capture, recalculate, FX and manual controls, but NOT the waiver form (a manager-only note instead)", () => {
    render(<CostPanelBody {...props({ estimator: true, manager: false })} />);
    for (const re of MUTATIONS) expect(has(re), String(re)).toBe(true);
    expect(screen.queryByLabelText(/Exception reason/)).toBeNull();
    expect(screen.getByTestId("waiver-manager-only").textContent).toMatch(/Only a Manager/);
    expect(screen.queryByTestId("cost-readonly-note")).toBeNull();
  });
  it("a Manager (not Estimator) gets NO capture / recalculate / FX / manual controls and a read-only note, but the waiver form", () => {
    render(<CostPanelBody {...props({ estimator: false, manager: true })} />);
    for (const re of MUTATIONS) expect(has(re), String(re)).toBe(false);
    expect(screen.getByTestId("cost-readonly-note").textContent).toMatch(/recorded by an Estimator/);
    expect(screen.getByLabelText(/Exception reason/)).toBeTruthy();
    expect(screen.queryByTestId("waiver-manager-only")).toBeNull();
    expect(document.querySelectorAll('input[type="radio"]:not(:disabled)').length).toBe(0); // no supplier choice
  });
  it("a viewer with both roles gets everything; a viewer with neither gets nothing editable", () => {
    render(<CostPanelBody {...props({ estimator: true, manager: true })} />);
    for (const re of MUTATIONS) expect(has(re), String(re)).toBe(true);
    expect(screen.getByLabelText(/Exception reason/)).toBeTruthy();
    cleanup();
    render(<CostPanelBody {...props({ estimator: false, manager: false })} />);
    for (const re of MUTATIONS) expect(has(re), String(re)).toBe(false);
    expect(screen.queryByLabelText(/Exception reason/)).toBeNull();
    expect(screen.getByTestId("waiver-manager-only")).toBeTruthy();
  });
  it("without `roles` the panel is exactly as before (every control the server allows is offered)", () => {
    render(<CostPanelBody {...props(undefined)} />);
    for (const re of MUTATIONS) expect(has(re), String(re)).toBe(true);
    expect(screen.getByLabelText(/Exception reason/)).toBeTruthy();
    expect(screen.queryByTestId("cost-readonly-note")).toBeNull();
    expect(screen.queryByTestId("waiver-manager-only")).toBeNull();
  });
});
