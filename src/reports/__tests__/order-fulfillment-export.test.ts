import { describe, expect, it } from "vitest";
import { buildOrderFulfillmentSheet } from "@/reports/order-fulfillment-export";
import type { OrderFulfillmentRow } from "@/reports/query";

function row(overrides: Partial<OrderFulfillmentRow>): OrderFulfillmentRow {
  return {
    cin7_sale_id: "sale-1",
    instance_id: "instance-1",
    order_number: "SO-1",
    customer_name: "Acme",
    order_date: null,
    days_open: null,
    ship_by: null,
    is_overdue: false,
    order_status: "AUTHORISED",
    combined_picking_status: "NOT PICKED",
    combined_packing_status: "NOT AVAILABLE",
    combined_shipping_status: "NOT AVAILABLE",
    combined_invoice_status: "NOT INVOICED",
    combined_payment_status: "UNPAID",
    paid_amount: 0,
    invoice_amount: 0,
    total_ordered_qty: 0,
    total_backorder_qty: 0,
    total_pickable_qty: 0,
    total_picked_qty: 0,
    is_pick_today: false,
    is_ship_today: false,
    ...overrides,
  };
}

describe("buildOrderFulfillmentSheet", () => {
  it("builds one header row plus one row per order", () => {
    const sheet = buildOrderFulfillmentSheet([
      row({
        order_number: "SO-95",
        customer_name: "Anton Tech PTY LTD",
        ship_by: "2026-10-26",
        is_overdue: true,
        combined_picking_status: "PICKED",
        combined_packing_status: "NOT PACKED",
        combined_shipping_status: "NOT SHIPPED",
        combined_invoice_status: "INVOICED",
        combined_payment_status: "UNPAID",
        total_ordered_qty: 2,
        total_backorder_qty: 0,
        total_pickable_qty: 0,
        total_picked_qty: 2,
        invoice_amount: 4608.04,
        paid_amount: 0,
      }),
    ]);

    expect(sheet.headerRowCount).toBe(1);
    expect(sheet.merges).toEqual([]);
    expect(sheet.data).toEqual([
      ["Order #", "Customer", "Ship By", "Overdue?", "Picking", "Packing", "Shipping", "Invoice", "Payment", "Ordered Qty", "Backorder Qty", "Pickable Now", "Picked So Far", "Invoice Amount", "Paid"],
      ["SO-95", "Anton Tech PTY LTD", "2026-10-26", "Overdue", "PICKED", "NOT PACKED", "NOT SHIPPED", "INVOICED", "UNPAID", 2, 0, 0, 2, 4608.04, 0],
    ]);
  });

  it("falls back to the Cin7 sale ID and blanks a null ship-by date", () => {
    const sheet = buildOrderFulfillmentSheet([row({ order_number: null, cin7_sale_id: "sale-2", ship_by: null })]);
    expect(sheet.data[1][0]).toBe("sale-2");
    expect(sheet.data[1][2]).toBe("");
    expect(sheet.data[1][3]).toBe("");
  });
});
