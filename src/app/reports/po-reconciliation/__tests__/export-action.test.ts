import { describe, expect, it, vi, beforeEach } from "vitest";

const getPoQuantityReport = vi.fn();
const renderXlsxBase64 = vi.fn(async () => "BASE64");
const requireModuleAccess = vi.fn();
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => ({ marker: "db" }) }));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: (...a: unknown[]) => requireModuleAccess(...a) }));
vi.mock("@/reports/po-quantity-query", () => ({ getPoQuantityReport: (...a: unknown[]) => getPoQuantityReport(...a) }));
vi.mock("@/reports/xlsx-writer", () => ({ renderXlsxBase64: (...a: unknown[]) => renderXlsxBase64(...(a as [])) }));

import { exportPoQuantityXlsxAction } from "../actions";

const row = (po: string, sku: string, ordered: number, received: number, supplier: string) => ({
  key: `${po}|${sku}`, instanceId: "i1", instanceName: "Inst", cin7PurchaseId: po, orderNumber: po, supplierName: supplier, orderDate: "2026-05-01", poStatus: "ORDERED",
  receivingStatus: "PARTIALLY RECEIVED", isDropShip: false, sku, productName: sku, orderLineCount: 1, ordered, received, outstanding: ordered - received, lineStatus: "partially_received",
  notOnOrder: false, dataQuality: "ok", dataQualityNote: null, detailSyncedAt: "2026-06-01T00:00:00Z",
});

const view = { supplier: "Acme", poStatus: "", lineStatus: "", quality: "", poSearch: "", search: "", sortColumn: "po", sortDirection: "asc" } as const;

beforeEach(() => {
  getPoQuantityReport.mockReset();
  renderXlsxBase64.mockClear();
  requireModuleAccess.mockReset().mockResolvedValue({ orgId: "orgA" });
});

describe("exportPoQuantityXlsxAction", () => {
  it("reloads the report for the SESSION org, applies the same view, and exports exactly those rows", async () => {
    getPoQuantityReport.mockResolvedValue({ rows: [row("PO-2", "X", 5, 1, "Acme"), row("PO-1", "X", 3, 3, "Acme"), row("PO-9", "X", 7, 0, "Other")], sync: [], excludedNoOrderDate: 0 });

    const res = await exportPoQuantityXlsxAction({ filters: { instanceIds: ["i1"], dateFrom: "2026-01-01" }, view });

    expect(res).toEqual({ ok: true, data: "BASE64" });
    expect(getPoQuantityReport).toHaveBeenCalledWith({ marker: "db" }, "orgA", { instanceIds: ["i1"], dateFrom: "2026-01-01" });
    const sheet = (renderXlsxBase64.mock.calls[0] as unknown as [{ data: (string | number)[][] }])[0];
    const hdr = sheet.data[0];
    const ordered = sheet.data.slice(1).map((r) => [r[hdr.indexOf("PO Number")], r[hdr.indexOf("Qty Ordered")], r[hdr.indexOf("Qty Received")], r[hdr.indexOf("Outstanding")]]);
    expect(ordered).toEqual([["PO-1", 3, 3, 0], ["PO-2", 5, 1, 4]]); // filtered to Acme, sorted by PO asc, totals preserved
  });

  it("never accepts rows from the client: a denied caller exports nothing and loads nothing", async () => {
    requireModuleAccess.mockRejectedValueOnce(new Error("forbidden"));
    const res = await exportPoQuantityXlsxAction({ filters: {}, view });
    expect(res).toEqual({ ok: false, error: "forbidden" });
    expect(getPoQuantityReport).not.toHaveBeenCalled();
    expect(renderXlsxBase64).not.toHaveBeenCalled();
  });
});
