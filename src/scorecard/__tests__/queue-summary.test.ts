import { describe, expect, it } from "vitest";
import { mapDashboardQueueRows, type DashboardQueueRow } from "../queue-summary";

const row = (queue: string, n: number, extra: Partial<DashboardQueueRow> = {}): DashboardQueueRow => ({
  queue,
  current_count: n,
  oldest_age_days: null,
  outside_sla_count: null,
  total_value: null,
  unclear_qty: null,
  ...extra,
});

describe("mapDashboardQueueRows", () => {
  it("splits the single dashboard RPC into the four KPI queues (fixed order) and the unclear count", () => {
    const { bottleneckSummary, shipmentStateUnclear } = mapDashboardQueueRows([
      row("shipment_state_unclear", 3, { oldest_age_days: 9, unclear_qty: 42 }),
      row("backorders_awaiting_stock", 128, { oldest_age_days: 616 }),
      row("invoiced_not_shipped", 2, { oldest_age_days: 21, outside_sla_count: 2, total_value: 1976.02 }),
      row("ready_to_pick", 57, { oldest_age_days: 118, outside_sla_count: 50 }),
      row("packed_not_invoiced", 40, { oldest_age_days: 949, outside_sla_count: 40, total_value: 2776387 }),
    ]);

    expect(bottleneckSummary.map((q) => q.queue)).toEqual(["ready_to_pick", "packed_not_invoiced", "invoiced_not_shipped", "backorders_awaiting_stock"]);
    expect(bottleneckSummary[2]).toEqual({ queue: "invoiced_not_shipped", currentCount: 2, oldestAgeDays: 21, outsideSlaCount: 2, totalValue: 1976.02 });
    expect(shipmentStateUnclear).toEqual({ currentCount: 3, oldestAgeDays: 9, unclearQty: 42 });
  });

  it("maps the closed/shipped-but-uninvoiced control apart from the KPI queues", () => {
    const m = mapDashboardQueueRows([
      row("ready_to_pick", 1),
      row("closed_shipped_uninvoiced", 6, { oldest_age_days: 950, closed_uninvoiced_qty: 900 }),
    ]);
    expect(m.bottleneckSummary.map((q) => q.queue)).toEqual(["ready_to_pick"]);
    expect(m.closedShippedUninvoiced).toEqual({ currentCount: 6, oldestAgeDays: 950, uninvoicedQty: 900 });
  });

  it("an older function without the control row yields a zero control (no throw)", () => {
    expect(mapDashboardQueueRows([row("ready_to_pick", 1)]).closedShippedUninvoiced).toEqual({ currentCount: 0, oldestAgeDays: null, uninvoicedQty: 0 });
  });

  it("never lets the unclear row leak into the KPI queues", () => {
    const { bottleneckSummary } = mapDashboardQueueRows([row("ready_to_pick", 1), row("shipment_state_unclear", 5, { unclear_qty: 9 })]);
    expect(bottleneckSummary.map((q) => q.queue)).toEqual(["ready_to_pick"]);
  });

  it("an empty/missing result yields no queues and a zero unclear count (no throw)", () => {
    expect(mapDashboardQueueRows(null)).toEqual({
      bottleneckSummary: [],
      shipmentStateUnclear: { currentCount: 0, oldestAgeDays: null, unclearQty: 0 },
      closedShippedUninvoiced: { currentCount: 0, oldestAgeDays: null, uninvoicedQty: 0 },
    });
    expect(mapDashboardQueueRows([]).shipmentStateUnclear.unclearQty).toBe(0);
  });

  it("coerces a numeric-string unclear quantity (PostgREST returns numeric as string/number)", () => {
    expect(mapDashboardQueueRows([row("shipment_state_unclear", 1, { unclear_qty: "12.5" as unknown as number })]).shipmentStateUnclear.unclearQty).toBe(12.5);
  });
});
