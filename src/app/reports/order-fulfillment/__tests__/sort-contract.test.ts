import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareOrderRows, orderTableSortValue, type OrderTableColumn } from "../sort-contract";
import type { OrderFulfillmentRow } from "@/reports/query";

const row = (o: Partial<OrderFulfillmentRow>) => o as OrderFulfillmentRow;

/** Every sortable field populated, so "is this column handled?" isn't confused with "is this field set?". */
const fullRow = row({
  cin7_sale_id: "s1",
  order_number: "SO-1",
  customer_name: "Acme",
  ship_by: "2026-01-01",
  combined_picking_status: "PICKED",
  combined_packing_status: "PACKED",
  combined_shipping_status: "NOT SHIPPED",
  combined_invoice_status: "AUTHORISED",
  invoice_numbers: "INV-1",
  combined_payment_status: "PAID",
  total_pickable_qty: 3,
  total_ready_to_invoice_qty: 4,
  total_ready_for_box_label_qty: 5,
  paid_amount: 6,
  ready_to_invoice_fulfilment_numbers: "1",
});

/**
 * Sorting moved into SQL with migration 0091, so there are now two
 * implementations of one contract. These tests pin the TypeScript side's
 * actual behaviour, and then assert the SQL names the same columns for the
 * same keys — a column added to one and not the other is the realistic
 * failure, and it is silent.
 */
describe("compareOrderRows — the semantics SQL has to match", () => {
  it("puts nulls last in ASC", () => {
    const rows = [row({ cin7_sale_id: "a", ship_by: null }), row({ cin7_sale_id: "b", ship_by: "2026-01-01" })];
    expect([...rows].sort(compareOrderRows("shipBy", "asc")).map((r) => r.cin7_sale_id)).toEqual(["b", "a"]);
  });

  it("puts nulls FIRST in DESC, because the page negated the comparator wholesale", () => {
    // compareNullable's docstring claims nulls sort last "regardless of
    // direction". The page negated its return value, so descending really
    // put them first. This test exists because the SQL was first written to
    // match the docstring rather than the code.
    const rows = [row({ cin7_sale_id: "a", ship_by: null }), row({ cin7_sale_id: "b", ship_by: "2026-01-01" })];
    expect([...rows].sort(compareOrderRows("shipBy", "desc")).map((r) => r.cin7_sale_id)).toEqual(["a", "b"]);
  });

  it("compares numbers numerically, not lexically", () => {
    const rows = [
      row({ cin7_sale_id: "a", total_pickable_qty: 9, ship_by: "2026-01-01" }),
      row({ cin7_sale_id: "b", total_pickable_qty: 10, ship_by: "2026-01-01" }),
    ];
    expect([...rows].sort(compareOrderRows("pickableNow", "asc")).map((r) => r.cin7_sale_id)).toEqual(["a", "b"]);
  });

  it("breaks ties by the report's priority-queue order, then sale id", () => {
    const rows = [
      row({ cin7_sale_id: "c", combined_payment_status: "PAID", ship_by: "2026-01-02" }),
      row({ cin7_sale_id: "b", combined_payment_status: "PAID", ship_by: "2026-01-01" }),
      row({ cin7_sale_id: "a", combined_payment_status: "PAID", ship_by: "2026-01-02" }),
    ];
    // Same sort value throughout, so ship_by then id decides.
    expect([...rows].sort(compareOrderRows("payment", "asc")).map((r) => r.cin7_sale_id)).toEqual(["b", "a", "c"]);
  });

  it("with no sort column, falls back to undated-last then ship_by then id", () => {
    const rows = [
      row({ cin7_sale_id: "z", ship_by: null }),
      row({ cin7_sale_id: "m", ship_by: "2026-01-02" }),
      row({ cin7_sale_id: "a", ship_by: "2026-01-01" }),
    ];
    expect([...rows].sort(compareOrderRows(null, "asc")).map((r) => r.cin7_sale_id)).toEqual(["a", "m", "z"]);
  });

  it("sorts by order_number, falling back to customer_name", () => {
    expect(orderTableSortValue("order", row({ order_number: null, customer_name: "Acme" }))).toBe("Acme");
    expect(orderTableSortValue("order", row({ order_number: "SO-1", customer_name: "Acme" }))).toBe("SO-1");
  });
});

describe("SQL sort keys match the TypeScript contract", () => {
  const sql = readFileSync(
    join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations", "0091_order_fulfillment_server_paging.sql"),
    "utf8"
  );

  /** Column keys the TS contract maps to a non-null value, by kind. */
  const textColumns: OrderTableColumn[] = [
    "order", "shipBy", "picking", "packing", "shipping", "invoice", "invoiceNumbers", "payment", "readyToInvoiceFulfilments",
  ];
  const numericColumns: OrderTableColumn[] = ["pickableNow", "readyToInvoiceQty", "boxLabelQty", "paidInvoice"];

  it.each(textColumns)("sort_txt handles %s", (column) => {
    expect(sql).toContain(`when '${column}' then`);
  });

  it.each(numericColumns)("sort_num handles %s", (column) => {
    expect(sql).toContain(`when '${column}' then`);
  });

  it("every sortable column the TS contract knows about appears in the SQL", () => {
    const sortable = [...textColumns, ...numericColumns];
    // Guards the realistic drift: a column added to orderTableSortValue but
    // not to the SQL silently falls back to the default order instead of
    // sorting, with no error anywhere.
    for (const column of sortable) {
      expect(orderTableSortValue(column, fullRow), `${column} has no CASE arm in orderTableSortValue`).not.toBeNull();
      expect(sql, `${column} missing from the SQL CASE arms`).toContain(`when '${column}' then`);
    }
  });

  it("columns that are not sortable are absent from both", () => {
    for (const column of ["select", "boxLabelAction"] as OrderTableColumn[]) {
      expect(orderTableSortValue(column, fullRow)).toBeNull();
      expect(sql).not.toContain(`when '${column}' then`);
    }
  });

  it("states null placement explicitly per direction: asc nulls last, desc nulls first", () => {
    // Never rely on Postgres's defaults here, and never make both directions
    // nulls-last: the page's negated comparator means desc puts nulls first.
    expect((sql.match(/asc nulls last/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((sql.match(/desc nulls first/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(sql).not.toContain("desc nulls last");
  });

  it("ends every ordering with the deterministic paging tiebreak", () => {
    expect(sql).toContain("(r.ship_by is null) asc, r.ship_by asc, r.cin7_sale_id asc");
  });
});
