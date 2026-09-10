import type { OrderFulfillmentRow } from "@/reports/query";

/**
 * Adds orders the user has just moved back into a window's fetched rows.
 *
 * Since migration 0090 the board fetches only the ship_by range that can
 * land on the visible week, and rescheduling a card jumps the board to the
 * week the card moved into. That jump re-fetches straight away, while the
 * Cin7 write-back and its `sales` mirror are still in flight — so the moved
 * order is not in the new window's rows yet, and the card the user just
 * dragged would disappear until something else triggered a reload.
 *
 * `moved` is keyed by cin7_sale_id and holds the row as it was before the
 * move; the caller's ship_by override decides which day it is drawn on, so a
 * carried order only ever appears in the week it was actually moved to. Once
 * the write lands, the next fetch of that week returns the order for real
 * and the fetched copy wins.
 */
export function mergeCarriedOrders(
  fetched: OrderFulfillmentRow[],
  moved: Record<string, OrderFulfillmentRow>
): OrderFulfillmentRow[] {
  const fetchedIds = new Set(fetched.map((o) => o.cin7_sale_id));
  const carried = Object.values(moved).filter((o) => !fetchedIds.has(o.cin7_sale_id));
  return carried.length ? [...fetched, ...carried] : fetched;
}
