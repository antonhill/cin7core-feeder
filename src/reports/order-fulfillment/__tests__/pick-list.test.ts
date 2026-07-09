import { describe, expect, it } from "vitest";
import { buildBatchPickList } from "@/reports/order-fulfillment/pick-list";
import type { OrderFulfillmentRow, OrderFulfillmentLineRow } from "@/reports/query";

function order(overrides: Partial<OrderFulfillmentRow>): OrderFulfillmentRow {
  return {
    cin7_sale_id: "sale-1",
    instance_id: "inst-1",
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
    is_pick_today: true,
    is_ship_today: false,
    ...overrides,
  };
}

function line(overrides: Partial<OrderFulfillmentLineRow>): OrderFulfillmentLineRow {
  return {
    cin7_sale_id: "sale-1",
    product_sku: "SKU-A",
    product_name: "Widget",
    ordered_qty: 1,
    backorder_qty: 0,
    picked_qty: 0,
    packed_qty: 0,
    pickable_qty: 1,
    picked_from_locations: null,
    suggested_pick_location: null,
    suggested_pick_location_on_hand: null,
    backorder_po_number: null,
    backorder_eta: null,
    backorder_po_outstanding_qty: null,
    ...overrides,
  };
}

describe("buildBatchPickList", () => {
  it("sums pickable qty for the same SKU across multiple selected orders", () => {
    const orders = [
      order({ cin7_sale_id: "sale-1", order_number: "SO-1" }),
      order({ cin7_sale_id: "sale-2", order_number: "SO-2" }),
    ];
    const linesBySaleId = new Map([
      ["sale-1", [line({ cin7_sale_id: "sale-1", product_sku: "SKU-A", pickable_qty: 2, suggested_pick_location: "Aisle 1" })]],
      ["sale-2", [line({ cin7_sale_id: "sale-2", product_sku: "SKU-A", pickable_qty: 3, suggested_pick_location: "Aisle 1" })]],
    ]);

    const result = buildBatchPickList(orders, linesBySaleId);

    expect(result.consolidated).toEqual([
      expect.objectContaining({ productSku: "SKU-A", totalQty: 5, suggestedPickLocation: "Aisle 1" }),
    ]);
    expect(result.orders).toEqual([
      { cin7SaleId: "sale-1", orderNumber: "SO-1", customerName: "Acme", lines: [{ productSku: "SKU-A", productName: "Widget", qty: 2 }] },
      { cin7SaleId: "sale-2", orderNumber: "SO-2", customerName: "Acme", lines: [{ productSku: "SKU-A", productName: "Widget", qty: 3 }] },
    ]);
  });

  it("excludes lines with nothing currently pickable (fully backordered)", () => {
    const orders = [order({ cin7_sale_id: "sale-1" })];
    const linesBySaleId = new Map([
      [
        "sale-1",
        [
          line({ cin7_sale_id: "sale-1", product_sku: "SKU-A", pickable_qty: 1 }),
          line({ cin7_sale_id: "sale-1", product_sku: "SKU-B", pickable_qty: 0 }),
        ],
      ],
    ]);

    const result = buildBatchPickList(orders, linesBySaleId);

    expect(result.consolidated).toHaveLength(1);
    expect(result.consolidated[0].productSku).toBe("SKU-A");
    expect(result.orders[0].lines).toEqual([{ productSku: "SKU-A", productName: "Widget", qty: 1 }]);
  });

  it("keeps the same SKU on different instances as separate consolidated rows", () => {
    const orders = [
      order({ cin7_sale_id: "sale-1", instance_id: "inst-1" }),
      order({ cin7_sale_id: "sale-2", instance_id: "inst-2" }),
    ];
    const linesBySaleId = new Map([
      ["sale-1", [line({ cin7_sale_id: "sale-1", product_sku: "SKU-A", pickable_qty: 1, suggested_pick_location: "Warehouse A" })]],
      ["sale-2", [line({ cin7_sale_id: "sale-2", product_sku: "SKU-A", pickable_qty: 1, suggested_pick_location: "Warehouse B" })]],
    ]);

    const result = buildBatchPickList(orders, linesBySaleId);

    expect(result.consolidated).toHaveLength(2);
    expect(result.consolidated.map((r) => r.instanceId).sort()).toEqual(["inst-1", "inst-2"]);
  });

  it("sorts consolidated rows by suggested location, with no-location SKUs sorted last", () => {
    const orders = [order({ cin7_sale_id: "sale-1" })];
    const linesBySaleId = new Map([
      [
        "sale-1",
        [
          line({ cin7_sale_id: "sale-1", product_sku: "SKU-Z", pickable_qty: 1, suggested_pick_location: null }),
          line({ cin7_sale_id: "sale-1", product_sku: "SKU-B", pickable_qty: 1, suggested_pick_location: "Bin 2" }),
          line({ cin7_sale_id: "sale-1", product_sku: "SKU-A", pickable_qty: 1, suggested_pick_location: "Bin 1" }),
        ],
      ],
    ]);

    const result = buildBatchPickList(orders, linesBySaleId);

    expect(result.consolidated.map((r) => r.productSku)).toEqual(["SKU-A", "SKU-B", "SKU-Z"]);
  });

  it("returns empty consolidated/orders lists when nothing is selected", () => {
    expect(buildBatchPickList([], new Map())).toEqual({ orders: [], consolidated: [] });
  });
});
