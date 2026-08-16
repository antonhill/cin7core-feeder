"use client";

import { loadShippingCalendarOrdersAction, updateOrderShipByAction, loadCarriersAction, markOrderShippedAction } from "./actions";
import type { OrderFulfillmentRow } from "@/reports/query";
import { ReportDescription } from "../ReportDescription";
import { CalendarBoard } from "./calendar-board";

/**
 * Nothing left to schedule — a calendar for rescheduling shouldn't surface
 * orders that have already shipped or been voided. Also respects the
 * instance's fulfilment_view_start_date floor (P5.3, LBL brief) — same
 * ship_today_hidden_by_floor signal Order Fulfillment's Ship Today tab uses
 * (report_order_fulfillment, migration 0061), applied here too per Anton's
 * call: this calendar shows the same "ready to ship" set over a longer
 * horizon, so stale pre-cleanup orders shouldn't clutter it either.
 */
function isSchedulable(order: OrderFulfillmentRow): boolean {
  return order.combined_shipping_status !== "SHIPPED" && order.combined_shipping_status !== "VOIDED" && !order.ship_today_hidden_by_floor;
}

function hiddenByFloor(order: OrderFulfillmentRow): boolean {
  return order.ship_today_hidden_by_floor;
}

export default function ShippingCalendarPage() {
  return (
    <>
      <ReportDescription title="Shipping Calendar">
        Every open order with a Ship By date, laid out on a week grid. Drag a card to a different day within the
        visible week, or click it to open its detail and use the <strong>Move to</strong>{" "}
        date picker to jump it to any date — either way, the new date is written straight back to Cin7 Core, not just
        changed here. The dot shows whether it&rsquo;s actually ready to ship yet.
      </ReportDescription>

      <CalendarBoard
        offsetDays={0}
        dateLabel="Ship By"
        qualifies={isSchedulable}
        hiddenByFloor={hiddenByFloor}
        loadOrders={loadShippingCalendarOrdersAction}
        writeShipBy={updateOrderShipByAction}
        markShipped={{ onMarkShipped: markOrderShippedAction, loadCarriers: loadCarriersAction }}
      />
    </>
  );
}
