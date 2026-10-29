import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Regression: the "Capture latest costs from Cin7" action was invisible whenever the panel's first read failed (the component returned null) and was placed at the
// very bottom of the page. The panel body is now pure and ALWAYS renders something; these tests pin what the Owner sees on an editable draft quotation.
vi.mock("server-only", () => ({}));
vi.mock("../cost-actions", () => ({ getQuoteCostEstimateAction: vi.fn(), captureLatestCostsAction: vi.fn(), setManualCostEstimateAction: vi.fn(), clearManualCostEstimateAction: vi.fn() }));
import { CostPanelBody, type CostPanelBodyProps } from "../[id]/CostPanel";
import type { QuoteCostView } from "../cost-actions";

const at = "2026-10-29T08:00:00Z";
const line = (sku: string, unit: number | null) => ({ sku, description: `${sku} desc`, quantity: 2, status: unit === null ? "MISSING" as const : "LATEST" as const, unitCostCents: unit, totalCostCents: unit === null ? null : unit * 2, source: unit === null ? null : "CIN7_LATEST" as const, retrievedAt: unit === null ? null : at, supplier: unit === null ? null : "Acme", reason: null });
const draftView = (over: Partial<QuoteCostView> = {}): QuoteCostView => ({
  estimate: { lines: [line("A-1", 1500), line("B-2", null)], totalCostCents: 3000, missingSkus: ["B-2"], unresolvedPackages: [], incomplete: true },
  frozen: false, contractCents: 100_000, marginPct: null, gpCents: null, complete: false, note: "Draft estimate.", canCapture: true, retrievedAt: at, ...over,
});
const noop = () => undefined;
/** The opening tag of the Capture button (class names contain "disabled:" utilities, so only the real attribute counts). */
const captureButton = (out: string) => { const i = out.indexOf("Capture latest costs from Cin7"); return out.slice(out.lastIndexOf("<button", i), i); };
const base: CostPanelBodyProps = { v: null, loading: false, error: null, note: null, busy: false, manual: null, onCapture: noop, onRetry: noop, onClearManual: noop, onStartManual: noop, onManualChange: noop, onSaveManual: noop };
const html = (p: Partial<CostPanelBodyProps>) => renderToStaticMarkup(createElement(CostPanelBody, { ...base, ...p }));

describe("the Capture latest costs action on an editable draft quotation", () => {
  it("is rendered, enabled, and states that it only reads Cin7", () => {
    const out = html({ v: draftView() });
    expect(out).toContain("Capture latest costs from Cin7");
    expect(captureButton(out)).not.toMatch(/\sdisabled=""/);
    expect(out).toContain("Reads Cin7 only (no writes)");
  });
  it("identifies missing costs clearly and withholds the margin", () => {
    const out = html({ v: draftView() });
    expect(out).toContain("Missing cost");
    expect(out).toContain("B-2");
    expect(out).toContain("1 SKU(s) have no cost");
    expect(out).toContain("(incomplete)");
    expect(out).toContain("A partial total is never shown as the margin");
    expect(out).toContain("Add manual estimate");
  });
  it("is never silently hidden: loading, a refusal and a failure each render the panel with the reason and a retry", () => {
    expect(html({ loading: true })).toContain("Loading the cost estimate");
    const refused = html({ error: "Costs are internal: only an organisation owner/admin, or someone given the Estimator or Manager role, can see or capture them." });
    expect(refused).toContain("Costs are internal");
    expect(refused).toContain("Try again");
    expect(html({ error: "Capture is not available while Demo Mode is impersonating another user. Exit Demo Mode first." })).toContain("Exit Demo Mode first");
    expect(html({ error: "boom" })).toContain("Cin7 latest cost - capture and margin");
  });
  it("explains a draft with no physical SKUs yet (unmapped packages) and disables capture instead of vanishing", () => {
    const out = html({ v: draftView({ estimate: { lines: [], totalCostCents: 0, missingSkus: [], unresolvedPackages: ["PP penning"], incomplete: true } }) });
    expect(out).toContain("Capture latest costs from Cin7");
    expect(captureButton(out)).toMatch(/\sdisabled=""/);
    expect(out).toContain("map the packages to Cin7 SKUs");
  });
  it("offers no capture on an approved (frozen) quotation, and labels it frozen", () => {
    const out = html({ v: draftView({ frozen: true, canCapture: false }) });
    expect(out).not.toContain("Capture latest costs from Cin7");
    expect(out).toContain("Frozen with the approval");
  });
  it("shows the margin only when the estimate is complete", () => {
    const out = html({ v: draftView({ estimate: { lines: [line("A-1", 1500)], totalCostCents: 3000, missingSkus: [], unresolvedPackages: [], incomplete: false }, complete: true, marginPct: 97, gpCents: 97_000 }) });
    expect(out).toContain("Margin on physical cost");
    expect(out).not.toContain("Margin is incomplete");
  });
});
