/**
 * Maps the rows of `report_scorecard_bottleneck_dashboard` (migration 0098) — the
 * four KPI queues plus the shipment-unclear count from ONE pass over the queue
 * view — into the dashboard's two shapes. Kept out of the "use server" actions
 * file (which may only export async functions) so it is unit-testable.
 */

export interface DashboardQueueRow {
  queue: string;
  current_count: number;
  oldest_age_days: number | null;
  outside_sla_count: number | null;
  total_value: number | null;
  unclear_qty: number | null;
  /** Uninvoiced units for the closed_shipped_uninvoiced control row (migration 0100); absent on rows from an older function. */
  closed_uninvoiced_qty?: number | null;
}

export const KPI_QUEUES = ["ready_to_pick", "packed_not_invoiced", "invoiced_not_shipped", "backorders_awaiting_stock"] as const;

export interface QueueSummary {
  queue: string;
  currentCount: number;
  oldestAgeDays: number | null;
  outsideSlaCount: number | null;
  totalValue: number | null;
}

export interface ShipmentStateUnclear {
  currentCount: number;
  oldestAgeDays: number | null;
  unclearQty: number;
}

/** The commercial-control exception — orders Cin7 has closed/shipped whose packed quantity exceeds invoiced quantity. NOT a warehouse KPI queue. */
export interface ClosedShippedUninvoiced {
  currentCount: number;
  oldestAgeDays: number | null;
  uninvoicedQty: number;
}

export function mapDashboardQueueRows(rows: DashboardQueueRow[] | null | undefined): {
  bottleneckSummary: QueueSummary[];
  shipmentStateUnclear: ShipmentStateUnclear;
  closedShippedUninvoiced: ClosedShippedUninvoiced;
} {
  const all = rows ?? [];
  // Preserve the KPI queues' fixed display order regardless of row order from SQL.
  const bottleneckSummary = KPI_QUEUES.flatMap((queue) => {
    const r = all.find((x) => x.queue === queue);
    return r
      ? [{ queue: r.queue, currentCount: r.current_count, oldestAgeDays: r.oldest_age_days, outsideSlaCount: r.outside_sla_count, totalValue: r.total_value }]
      : [];
  });
  const unclear = all.find((x) => x.queue === "shipment_state_unclear");
  const closed = all.find((x) => x.queue === "closed_shipped_uninvoiced");
  return {
    closedShippedUninvoiced: {
      currentCount: closed?.current_count ?? 0,
      oldestAgeDays: closed?.oldest_age_days ?? null,
      uninvoicedQty: Number(closed?.closed_uninvoiced_qty ?? 0),
    },
    bottleneckSummary,
    shipmentStateUnclear: {
      currentCount: unclear?.current_count ?? 0,
      oldestAgeDays: unclear?.oldest_age_days ?? null,
      unclearQty: Number(unclear?.unclear_qty ?? 0),
    },
  };
}
