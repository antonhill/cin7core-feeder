"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { loadShippingCalendarOrdersAction, updateOrderShipByAction } from "./actions";
import { currentWeekStart, mondayOf, addDays, formatDayLabel } from "./date-utils";
import type { OrderFulfillmentRow, OrderFulfillmentLineRow } from "@/reports/query";
import { ReportDescription } from "../ReportDescription";
import { StatusBadge } from "../status-badge";
import { Spinner } from "@/app/Spinner";

const DAY_COUNT = 7;

/** Nothing left to schedule — a calendar for rescheduling shouldn't surface orders that have already shipped or been voided. */
function isSchedulable(order: OrderFulfillmentRow): boolean {
  return order.combined_shipping_status !== "SHIPPED" && order.combined_shipping_status !== "VOIDED";
}

type Readiness = "ready" | "in_progress" | "not_started";

/** "Ready to ship" mirrors Order Fulfillment's own picking/packing badges — surfaced here as a quick traffic-light dot so a card doesn't get dragged to "ship tomorrow" while it's still sitting at NOT PICKED. */
function readiness(order: OrderFulfillmentRow): Readiness {
  if (order.combined_packing_status === "PACKED") return "ready";
  if (!order.combined_picking_status || order.combined_picking_status === "NOT PICKED") return "not_started";
  return "in_progress";
}

const READINESS_DOT_CLASS: Record<Readiness, string> = {
  ready: "bg-emerald-500",
  in_progress: "bg-amber-400",
  not_started: "bg-slate-300",
};

const READINESS_LABEL: Record<Readiness, string> = {
  ready: "Packed — ready to ship",
  in_progress: "Picking/packing in progress",
  not_started: "Not picked yet",
};

function qty(value: number): string {
  return value.toLocaleString();
}

function OrderCard({
  order,
  lines,
  isExpanded,
  effectiveShipBy,
  isPending,
  error,
  onToggleExpand,
  onReschedule,
}: {
  order: OrderFulfillmentRow;
  lines: OrderFulfillmentLineRow[];
  isExpanded: boolean;
  effectiveShipBy: string;
  isPending: boolean;
  error?: string;
  onToggleExpand: (saleId: string) => void;
  onReschedule: (saleId: string, newDate: string) => void;
}) {
  const level = readiness(order);
  return (
    <div
      draggable={!isPending}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", order.cin7_sale_id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => onToggleExpand(order.cin7_sale_id)}
      className={`rounded-lg border bg-white p-2 text-xs shadow-sm transition ${
        isPending ? "opacity-50" : "cursor-grab active:cursor-grabbing"
      } ${error ? "border-rose-300" : "border-slate-200"}`}
    >
      <div className="flex items-start gap-1.5">
        <span
          title={READINESS_LABEL[level]}
          className={`mt-1 h-2 w-2 shrink-0 rounded-full ${READINESS_DOT_CLASS[level]}`}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-slate-900">{order.order_number ?? order.cin7_sale_id}</div>
          <div className="truncate text-slate-500">{order.customer_name}</div>
        </div>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        <StatusBadge status={order.combined_invoice_status} />
        <StatusBadge status={order.combined_payment_status} />
      </div>
      {order.is_overdue && <div className="mt-1 font-semibold text-rose-600">Overdue</div>}
      {isPending && (
        <div className="mt-1 flex items-center gap-1 text-indigo-500">
          <Spinner className="h-3 w-3" /> Saving…
        </div>
      )}
      {error && (
        <div className="mt-1 text-rose-600" title={error}>
          Failed — reverted
        </div>
      )}
      <label className="mt-1.5 flex items-center gap-1 text-slate-400" onClick={(e) => e.stopPropagation()}>
        Move to
        <input
          type="date"
          value={effectiveShipBy}
          disabled={isPending}
          onChange={(e) => e.target.value && onReschedule(order.cin7_sale_id, e.target.value)}
          className="rounded border border-slate-200 px-1 py-0.5 text-slate-600 disabled:opacity-50"
        />
      </label>
      {isExpanded && (
        <div className="mt-1.5 border-t border-slate-100 pt-1.5" onClick={(e) => e.stopPropagation()}>
          {lines.length === 0 ? (
            <p className="text-slate-400">No line detail synced for this order yet.</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {lines.map((line, i) => (
                <li key={i} className="flex items-baseline justify-between gap-2 text-slate-600">
                  <span className="truncate">
                    {line.product_sku} {line.product_name ? `— ${line.product_name}` : ""}
                  </span>
                  <span className="shrink-0 whitespace-nowrap">
                    {qty(line.ordered_qty)}
                    {line.backorder_qty > 0 && <span className="ml-1 text-rose-500">({qty(line.backorder_qty)} bo)</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function DayColumn({
  day,
  orders,
  linesBySaleId,
  isToday,
  isDraggedOver,
  expandedSaleId,
  onDragOverDay,
  onDragLeaveDay,
  onToggleExpand,
  onReschedule,
  shipByOverrides,
  pendingSaleIds,
  writeErrors,
}: {
  day: string;
  orders: OrderFulfillmentRow[];
  linesBySaleId: Map<string, OrderFulfillmentLineRow[]>;
  isToday: boolean;
  isDraggedOver: boolean;
  expandedSaleId: string | null;
  onDragOverDay: (day: string) => void;
  onDragLeaveDay: (day: string) => void;
  onToggleExpand: (saleId: string) => void;
  onReschedule: (saleId: string, newDate: string) => void;
  shipByOverrides: Record<string, string>;
  pendingSaleIds: Set<string>;
  writeErrors: Record<string, string>;
}) {
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        onDragOverDay(day);
      }}
      onDragLeave={() => onDragLeaveDay(day)}
      onDrop={(e) => {
        e.preventDefault();
        const saleId = e.dataTransfer.getData("text/plain");
        onDragLeaveDay(day);
        if (saleId) onReschedule(saleId, day);
      }}
      className={`flex min-h-[220px] flex-col gap-1.5 rounded-xl border p-2 ${
        isDraggedOver ? "border-indigo-400 bg-indigo-50" : isToday ? "border-indigo-200 bg-indigo-50/40" : "border-slate-200 bg-slate-50"
      }`}
    >
      <div className="mb-1 flex items-baseline justify-between px-0.5 text-xs font-semibold text-slate-600">
        <span>{formatDayLabel(day)}</span>
        <span className="font-normal text-slate-400">{orders.length}</span>
      </div>
      {orders.map((order) => (
        <OrderCard
          key={order.cin7_sale_id}
          order={order}
          lines={linesBySaleId.get(order.cin7_sale_id) ?? []}
          isExpanded={expandedSaleId === order.cin7_sale_id}
          effectiveShipBy={shipByOverrides[order.cin7_sale_id] ?? order.ship_by ?? day}
          isPending={pendingSaleIds.has(order.cin7_sale_id)}
          error={writeErrors[order.cin7_sale_id]}
          onToggleExpand={onToggleExpand}
          onReschedule={onReschedule}
        />
      ))}
    </div>
  );
}

export default function ShippingCalendarPage() {
  const [weekStart, setWeekStart] = useState(currentWeekStart);
  const [orders, setOrders] = useState<OrderFulfillmentRow[] | null>(null);
  const [lines, setLines] = useState<OrderFulfillmentLineRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, startLoadTransition] = useTransition();

  const [search, setSearch] = useState("");
  const [expandedSaleId, setExpandedSaleId] = useState<string | null>(null);

  // Applied instantly on drop so the card visibly moves before the Cin7
  // write-back round-trip resolves; reverted if the write fails.
  const [shipByOverrides, setShipByOverrides] = useState<Record<string, string>>({});
  const [pendingSaleIds, setPendingSaleIds] = useState<Set<string>>(new Set());
  const [writeErrors, setWriteErrors] = useState<Record<string, string>>({});
  const [draggedOverDay, setDraggedOverDay] = useState<string | null>(null);

  useEffect(() => {
    startLoadTransition(async () => {
      const result = await loadShippingCalendarOrdersAction();
      if (!result.ok || !result.data) {
        setLoadError(result.error ?? "Unknown error");
        return;
      }
      setOrders(result.data.orders.filter(isSchedulable));
      setLines(result.data.lines);
    });
  }, []);

  const today = useMemo(() => currentWeekStart(), []);
  const days = useMemo(() => Array.from({ length: DAY_COUNT }, (_, i) => addDays(weekStart, i)), [weekStart]);

  const linesBySaleId = useMemo(() => {
    const map = new Map<string, OrderFulfillmentLineRow[]>();
    for (const line of lines) {
      const existing = map.get(line.cin7_sale_id);
      if (existing) existing.push(line);
      else map.set(line.cin7_sale_id, [line]);
    }
    return map;
  }, [lines]);

  const searchedOrders = useMemo(() => {
    const searchLower = search.trim().toLowerCase();
    if (!searchLower) return orders ?? [];
    return (orders ?? []).filter(
      (o) => (o.order_number ?? "").toLowerCase().includes(searchLower) || (o.customer_name ?? "").toLowerCase().includes(searchLower)
    );
  }, [orders, search]);

  const ordersByDay = useMemo(() => {
    const map = new Map<string, OrderFulfillmentRow[]>();
    for (const day of days) map.set(day, []);
    for (const order of searchedOrders) {
      const shipBy = shipByOverrides[order.cin7_sale_id] ?? order.ship_by;
      if (!shipBy) continue;
      const bucket = map.get(shipBy.slice(0, 10));
      if (bucket) bucket.push(order);
    }
    return map;
  }, [searchedOrders, days, shipByOverrides]);

  const unscheduledCount = searchedOrders.filter((o) => !o.ship_by).length;

  /** Shared by both the drag-drop and the per-card date picker — a drop target is always a day already on screen, but the date picker can name any date, including one in a different week (jumped to below so the moved card is visible right away). */
  function handleReschedule(saleId: string, newDate: string) {
    const order = (orders ?? []).find((o) => o.cin7_sale_id === saleId);
    if (!order) return;
    const previousShipBy = shipByOverrides[saleId] ?? order.ship_by;
    if (previousShipBy && previousShipBy.slice(0, 10) === newDate) return;

    setShipByOverrides((prev) => ({ ...prev, [saleId]: newDate }));
    setWriteErrors((prev) => {
      const next = { ...prev };
      delete next[saleId];
      return next;
    });
    setPendingSaleIds((prev) => new Set(prev).add(saleId));
    if (mondayOf(newDate) !== weekStart) setWeekStart(mondayOf(newDate));

    startLoadTransition(async () => {
      const result = await updateOrderShipByAction(order.instance_id, saleId, newDate);
      setPendingSaleIds((prev) => {
        const next = new Set(prev);
        next.delete(saleId);
        return next;
      });
      if (!result.ok) {
        setShipByOverrides((prev) => {
          const next = { ...prev };
          delete next[saleId];
          return next;
        });
        setWriteErrors((prev) => ({ ...prev, [saleId]: result.error ?? "Unknown error" }));
      }
    });
  }

  function handleToggleExpand(saleId: string) {
    setExpandedSaleId((cur) => (cur === saleId ? null : saleId));
  }

  return (
    <>
      <ReportDescription title="Shipping Calendar">
        Every open order with a Ship By date, laid out on a week grid. Drag a card to a different day within the
        visible week, or use its <strong>Move to</strong> date picker to jump it to any date — either way, the new
        date is written straight back to Cin7 Core, not just changed here. Click a card to see its SKUs; the dot
        shows whether it&rsquo;s actually ready to ship yet.
      </ReportDescription>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setWeekStart((w) => addDays(w, -7))}
              className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              ← Prev week
            </button>
            <button
              type="button"
              onClick={() => setWeekStart(currentWeekStart())}
              className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              This week
            </button>
            <button
              type="button"
              onClick={() => setWeekStart((w) => addDays(w, 7))}
              className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Next week →
            </button>
            <span className="ml-2 text-sm font-medium text-slate-600">
              {formatDayLabel(weekStart)} – {formatDayLabel(addDays(weekStart, DAY_COUNT - 1))}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Order # or customer"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-56 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
            />
            {isLoading && <Spinner />}
          </div>
        </div>

        {loadError && <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>}

        {unscheduledCount > 0 && (
          <p className="mt-3 text-sm text-slate-400">{unscheduledCount} open order(s) have no Ship By date set — not shown here.</p>
        )}

        {orders && (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-7">
            {days.map((day) => (
              <DayColumn
                key={day}
                day={day}
                orders={ordersByDay.get(day) ?? []}
                linesBySaleId={linesBySaleId}
                isToday={day === today}
                isDraggedOver={draggedOverDay === day}
                expandedSaleId={expandedSaleId}
                onDragOverDay={setDraggedOverDay}
                onDragLeaveDay={(d) => setDraggedOverDay((cur) => (cur === d ? null : cur))}
                onToggleExpand={handleToggleExpand}
                onReschedule={handleReschedule}
                shipByOverrides={shipByOverrides}
                pendingSaleIds={pendingSaleIds}
                writeErrors={writeErrors}
              />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
