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
  instanceName,
  effectiveShipBy,
  isPending,
  error,
  onOpenDetail,
  onReschedule,
}: {
  order: OrderFulfillmentRow;
  /** Only passed when more than one instance is connected — a single-instance org has no need for the label. */
  instanceName?: string;
  effectiveShipBy: string;
  isPending: boolean;
  error?: string;
  onOpenDetail: (saleId: string) => void;
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
      onClick={() => onOpenDetail(order.cin7_sale_id)}
      className={`min-w-0 overflow-hidden rounded-lg border bg-white p-1.5 text-[11px] shadow-sm transition ${
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
          {instanceName && <div className="truncate text-slate-400">{instanceName}</div>}
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
      <label className="mt-1.5 flex flex-col gap-0.5 text-slate-400" onClick={(e) => e.stopPropagation()}>
        <span>Move to</span>
        <input
          type="date"
          value={effectiveShipBy}
          disabled={isPending}
          onChange={(e) => e.target.value && onReschedule(order.cin7_sale_id, e.target.value)}
          className="w-full min-w-0 rounded border border-slate-200 px-1 py-0.5 text-[11px] text-slate-600 disabled:opacity-50"
        />
      </label>
    </div>
  );
}

function DayColumn({
  day,
  orders,
  instanceNameById,
  showInstanceName,
  isToday,
  isDraggedOver,
  onDragOverDay,
  onDragLeaveDay,
  onOpenDetail,
  onReschedule,
  shipByOverrides,
  pendingSaleIds,
  writeErrors,
}: {
  day: string;
  orders: OrderFulfillmentRow[];
  instanceNameById: Map<string, string>;
  showInstanceName: boolean;
  isToday: boolean;
  isDraggedOver: boolean;
  onDragOverDay: (day: string) => void;
  onDragLeaveDay: (day: string) => void;
  onOpenDetail: (saleId: string) => void;
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
      className={`flex min-h-[220px] min-w-0 flex-col gap-1.5 overflow-hidden rounded-xl border p-2 ${
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
          instanceName={showInstanceName ? instanceNameById.get(order.instance_id) : undefined}
          effectiveShipBy={shipByOverrides[order.cin7_sale_id] ?? order.ship_by ?? day}
          isPending={pendingSaleIds.has(order.cin7_sale_id)}
          error={writeErrors[order.cin7_sale_id]}
          onOpenDetail={onOpenDetail}
          onReschedule={onReschedule}
        />
      ))}
    </div>
  );
}

/** Order detail (all 5 Combined*Status fields + full line-level SKU table) doesn't fit readably inside a ~180px kanban card at any font size — shown full-width in a modal instead, same pattern as Order Fulfillment's own Batch Pick List modal. */
function OrderDetailModal({
  order,
  lines,
  onClose,
}: {
  order: OrderFulfillmentRow;
  lines: OrderFulfillmentLineRow[];
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50" onClick={onClose}>
      <div className="mx-auto my-8 max-w-2xl rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">{order.order_number ?? order.cin7_sale_id}</h2>
            <p className="text-sm text-slate-500">{order.customer_name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Close
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <StatusBadge status={order.combined_picking_status} />
          <StatusBadge status={order.combined_packing_status} />
          <StatusBadge status={order.combined_shipping_status} />
          <StatusBadge status={order.combined_invoice_status} />
          <StatusBadge status={order.combined_payment_status} />
        </div>

        <p className="mt-3 text-sm text-slate-600">
          Ship By: <span className="font-medium text-slate-900">{order.ship_by ?? "—"}</span>
          {order.is_overdue && (
            <span className="ml-2 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">Overdue</span>
          )}
        </p>

        <h3 className="mt-6 mb-2 text-sm font-semibold text-slate-700">Order lines</h3>
        {lines.length === 0 ? (
          <p className="text-sm text-slate-400">No line detail synced for this order yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-1.5 pr-4">SKU</th>
                <th className="py-1.5 pr-4">Product</th>
                <th className="py-1.5 pr-4 text-right">Ordered</th>
                <th className="py-1.5 pr-4 text-right">Backorder</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} className="border-b border-slate-100 last:border-0">
                  <td className="py-1.5 pr-4">{line.product_sku}</td>
                  <td className="py-1.5 pr-4">{line.product_name ?? "—"}</td>
                  <td className="py-1.5 pr-4 text-right">{qty(line.ordered_qty)}</td>
                  <td className="py-1.5 pr-4 text-right">
                    {line.backorder_qty > 0 ? <span className="font-semibold text-rose-600">{qty(line.backorder_qty)}</span> : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default function ShippingCalendarPage() {
  const [weekStart, setWeekStart] = useState(currentWeekStart);
  const [orders, setOrders] = useState<OrderFulfillmentRow[] | null>(null);
  const [lines, setLines] = useState<OrderFulfillmentLineRow[]>([]);
  const [instances, setInstances] = useState<{ id: string; name: string }[]>([]);
  const [instanceIds, setInstanceIds] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, startLoadTransition] = useTransition();

  const [search, setSearch] = useState("");
  const [detailSaleId, setDetailSaleId] = useState<string | null>(null);

  // Applied instantly on drop so the card visibly moves before the Cin7
  // write-back round-trip resolves; reverted if the write fails.
  const [shipByOverrides, setShipByOverrides] = useState<Record<string, string>>({});
  const [pendingSaleIds, setPendingSaleIds] = useState<Set<string>>(new Set());
  const [writeErrors, setWriteErrors] = useState<Record<string, string>>({});
  const [draggedOverDay, setDraggedOverDay] = useState<string | null>(null);

  // Keyed on instanceIds so toggling a checkbox reloads on its own, rather
  // than silently doing nothing until some other action happens to trigger
  // a refetch — that gap is exactly what made Order Fulfillment's own
  // instance filter look broken (2026-07-10). Runs on mount too
  // (instanceIds starts as []). Direct .then() here, not startTransition,
  // and setLoadError(null) only happens inside the callback (not as its own
  // statement ahead of the fetch) — a setState call directly in the effect
  // body, even before an async call, still trips
  // react-hooks/set-state-in-effect.
  useEffect(() => {
    loadShippingCalendarOrdersAction({ instanceIds: instanceIds.length ? instanceIds : undefined }).then((result) => {
      if (!result.ok || !result.data) {
        setLoadError(result.error ?? "Unknown error");
        return;
      }
      setLoadError(null);
      setOrders(result.data.orders.filter(isSchedulable));
      setLines(result.data.lines);
      setInstances(result.data.instances);
    });
  }, [instanceIds]);

  function toggleInstance(id: string) {
    setInstanceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const today = useMemo(() => currentWeekStart(), []);
  const days = useMemo(() => Array.from({ length: DAY_COUNT }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const instanceNameById = useMemo(() => new Map(instances.map((i) => [i.id, i.name])), [instances]);

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
  const detailOrder = detailSaleId ? (orders ?? []).find((o) => o.cin7_sale_id === detailSaleId) : undefined;

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

  return (
    <>
      <ReportDescription title="Shipping Calendar">
        Every open order with a Ship By date, laid out on a week grid. Drag a card to a different day within the
        visible week, or use its <strong>Move to</strong> date picker to jump it to any date — either way, the new
        date is written straight back to Cin7 Core, not just changed here. Click a card to see its SKUs; the dot
        shows whether it&rsquo;s actually ready to ship yet.
      </ReportDescription>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        {instances.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-slate-100 pb-4">
            <span className="text-sm font-medium text-slate-700">Instance(s)</span>
            {instances.map((inst) => (
              <label key={inst.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={instanceIds.includes(inst.id)} onChange={() => toggleInstance(inst.id)} className="h-4 w-4" />
                {inst.name}
              </label>
            ))}
            <span className="text-xs text-slate-400">(none checked = all instances)</span>
          </div>
        )}
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
                instanceNameById={instanceNameById}
                showInstanceName={instances.length > 1}
                isToday={day === today}
                isDraggedOver={draggedOverDay === day}
                onDragOverDay={setDraggedOverDay}
                onDragLeaveDay={(d) => setDraggedOverDay((cur) => (cur === d ? null : cur))}
                onOpenDetail={setDetailSaleId}
                onReschedule={handleReschedule}
                shipByOverrides={shipByOverrides}
                pendingSaleIds={pendingSaleIds}
                writeErrors={writeErrors}
              />
            ))}
          </div>
        )}
      </section>

      {detailOrder && (
        <OrderDetailModal
          order={detailOrder}
          lines={linesBySaleId.get(detailOrder.cin7_sale_id) ?? []}
          onClose={() => setDetailSaleId(null)}
        />
      )}
    </>
  );
}
