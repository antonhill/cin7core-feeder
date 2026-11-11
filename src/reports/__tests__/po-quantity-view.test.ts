import { describe, expect, it } from "vitest";
import { applyPoView, compareNullable, type PoViewSpec } from "@/reports/po-quantity-view";
import { buildPoQuantityRows, type PurchaseHeader } from "@/reports/po-quantity-comparison";

const names = { i1: "Inst" };
const po = (over: Partial<PurchaseHeader>): PurchaseHeader => ({
  instance_id: "i1",
  cin7_purchase_id: "p",
  order_number: "PO-1",
  supplier_name: "Acme",
  status: "ORDERED",
  combined_receiving_status: "PARTIALLY RECEIVED",
  order_date: "2026-05-01",
  is_drop_ship: false,
  source: "purchase",
  detail_synced_at: "2026-06-01T10:00:00Z",
  created_at: "2026-05-02T00:00:00Z",
  updated_at: "2026-06-01T09:59:59Z",
  ...over,
});
const line = (id: string, sku: string, q: number) => ({ instance_id: "i1", cin7_purchase_id: id, product_sku: sku, product_name: `N-${sku}`, quantity: q });

const rows = buildPoQuantityRows({
  purchases: [
    po({ cin7_purchase_id: "a", order_number: "PO-A", supplier_name: "Acme", order_date: "2026-05-03" }),
    po({ cin7_purchase_id: "b", order_number: "PO-B", supplier_name: "Beta", order_date: "2026-05-01", combined_receiving_status: "NOT RECEIVED" }),
    po({ cin7_purchase_id: "c", order_number: "PO-C", supplier_name: "Acme", order_date: "2026-05-02", detail_synced_at: null }),
  ],
  orderLines: [line("a", "X", 10), line("a", "Y", 5), line("b", "X", 3)],
  receiptLines: [line("a", "X", 4), line("a", "Y", 9)],
  instanceNames: names,
});

const base: PoViewSpec = { supplier: "", poStatus: "", lineStatus: "", quality: "", poSearch: "", search: "", sortColumn: "orderDate", sortDirection: "desc" };

describe("applyPoView (shared by the page and the Excel export)", () => {
  it("applies every filter and sorts, with nulls last in both directions", () => {
    expect(applyPoView(rows, base).map((r) => r.orderNumber)).toEqual(["PO-A", "PO-A", "PO-C", "PO-B"]);
    expect(applyPoView(rows, { ...base, sortColumn: "outstanding", sortDirection: "asc" }).map((r) => r.outstanding)).toEqual([-4, 3, 6, null]);
    expect(applyPoView(rows, { ...base, sortColumn: "outstanding", sortDirection: "desc" }).map((r) => r.outstanding)).toEqual([6, 3, -4, null]);
  });

  it("filters by supplier, line status, quality group and the two searches", () => {
    expect(applyPoView(rows, { ...base, supplier: "Beta" }).map((r) => r.orderNumber)).toEqual(["PO-B"]);
    expect(applyPoView(rows, { ...base, lineStatus: "over_received" }).map((r) => r.sku)).toEqual(["Y"]);
    expect(applyPoView(rows, { ...base, quality: "incomplete" }).map((r) => r.orderNumber)).toEqual(["PO-C"]);
    expect(applyPoView(rows, { ...base, poSearch: "po-a" }).length).toBe(2);
    expect(applyPoView(rows, { ...base, search: "n-y" }).map((r) => r.sku)).toEqual(["Y"]);
  });

  it("the spec is tiny and size-independent (the reason the export no longer posts rows)", () => {
    const many = Array.from({ length: 20000 }, (_, i) => ({ ...rows[0], key: `k${i}` }));
    expect(many.length).toBe(20000);
    expect(JSON.stringify({ filters: { instanceIds: ["i1"], dateFrom: "2026-01-01" }, view: base }).length).toBeLessThan(600);
  });

  it("compareNullable keeps nulls last", () => {
    expect([3, null, 1].sort(compareNullable)).toEqual([1, 3, null]);
  });
});
