import type { OrderFulfillmentRow, OrderFulfillmentLineRow } from "@/reports/query";

export interface PickListOrderLine {
  productSku: string;
  productName: string | null;
  qty: number;
}

export interface PickListOrder {
  cin7SaleId: string;
  orderNumber: string | null;
  customerName: string | null;
  lines: PickListOrderLine[];
}

/** One row per (instance, SKU) actually needed across every selected order — the sheet a picker works from, walking the warehouse once instead of re-visiting the same location per order. */
export interface PickListConsolidatedRow {
  instanceId: string;
  productSku: string;
  productName: string | null;
  totalQty: number;
  suggestedPickLocation: string | null;
  suggestedPickLocationOnHand: number | null;
}

export interface BatchPickList {
  orders: PickListOrder[];
  consolidated: PickListConsolidatedRow[];
}

/**
 * Aggregates already-loaded order/line data (no new Cin7 calls, no server
 * round trip) into a single consolidated pick sheet plus a per-order
 * breakdown for slotting picked stock back into totes afterward. Only
 * lines with pickable_qty > 0 are included — a line still fully backordered
 * has nothing to pick yet. Grouped by (instance, SKU) rather than just SKU,
 * since suggested_pick_location is itself scoped per instance — two
 * instances sharing a SKU could have it in different physical locations.
 */
export function buildBatchPickList(selectedOrders: OrderFulfillmentRow[], linesBySaleId: Map<string, OrderFulfillmentLineRow[]>): BatchPickList {
  const orders: PickListOrder[] = [];
  const consolidatedByKey = new Map<string, PickListConsolidatedRow>();

  for (const order of selectedOrders) {
    const pickableLines = (linesBySaleId.get(order.cin7_sale_id) ?? []).filter((l) => l.pickable_qty > 0);
    orders.push({
      cin7SaleId: order.cin7_sale_id,
      orderNumber: order.order_number,
      customerName: order.customer_name,
      lines: pickableLines.map((l) => ({ productSku: l.product_sku, productName: l.product_name, qty: l.pickable_qty })),
    });

    for (const line of pickableLines) {
      const key = `${order.instance_id}::${line.product_sku}`;
      const existing = consolidatedByKey.get(key);
      if (existing) {
        existing.totalQty += line.pickable_qty;
      } else {
        consolidatedByKey.set(key, {
          instanceId: order.instance_id,
          productSku: line.product_sku,
          productName: line.product_name,
          totalQty: line.pickable_qty,
          suggestedPickLocation: line.suggested_pick_location,
          suggestedPickLocationOnHand: line.suggested_pick_location_on_hand,
        });
      }
    }
  }

  const consolidated = [...consolidatedByKey.values()].sort((a, b) => {
    if (!a.suggestedPickLocation !== !b.suggestedPickLocation) return a.suggestedPickLocation ? -1 : 1;
    if (a.suggestedPickLocation && b.suggestedPickLocation && a.suggestedPickLocation !== b.suggestedPickLocation) {
      return a.suggestedPickLocation.localeCompare(b.suggestedPickLocation);
    }
    return a.productSku.localeCompare(b.productSku);
  });

  return { orders, consolidated };
}
