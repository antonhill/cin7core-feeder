"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { loadShippingCalendarOrdersAction, updateOrderShipByAction } from "./actions";
import { currentWeekStart, addDays, formatDayLabel } from "./date-utils";
import type { OrderFulfillmentRow } from "@/reports/query";
import { ReportDescription } from "../ReportDescription";
import { Spinner } from "@/app/Spinner";

const DAY_COUNT = 7;

/** Nothing left to schedule — a calendar for rescheduling shouldn't surface orders that have already shipped or been voided. */
function isSchedulable(order: OrderFulfillmentRow): boolean {
  return order.combined_shipping_status !== "SHIPPED" && order.combined_shipping_status !== "VOIDED";
}

function OrderCard({
  order,
  isPending,
  error,
}: {
  order: OrderFulfillmentRow;
  isPending: boolean;
  error?: string;
}) {
  return (
    <div
      draggable={!isPending}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", order.cin7_sale_id);
        e.dataTransfer.effectAllowed = "move";
      }}
      className={`rounded-lg border bg-white p-2 text-xs shadow-sm transition ${
        isPending ? "opacity-50" : "cursor-grab active:cursor-grabbing"
      } ${error ? "border-rose-300" : "border-slate-200"}`}
    >
      <div className="truncate font-medium text-slate-900">{order.order_number ?? order.cin7_sale_id}</div>
      <div className="truncate text-slate-500">{order.customer_name}</div>
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
    </div>
  );
}

function DayColumn({
  day,
  orders,
  isToday,
  isDraggedOver,
  onDragOverDay,
  onDragLeaveDay,
  onDrop,
  pendingSaleIds,
  writeErrors,
}: {
  day: string;
  orders: OrderFulfillmentRow[];
  isToday: boolean;
  isDraggedOver: boolean;
  onDragOverDay: (day: string) => void;
  onDragLeaveDay: (day: string) => void;
  onDrop: (day: string, saleId: string) => void;
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
        if (saleId) onDrop(day, saleId);
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
          isPending={pendingSaleIds.has(order.cin7_sale_id)}
          error={writeErrors[order.cin7_sale_id]}
        />
      ))}
    </div>
  );
}

export default function ShippingCalendarPage() {
  const [weekStart, setWeekStart] = useState(currentWeekStart);
  const [orders, setOrders] = useState<OrderFulfillmentRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, startLoadTransition] = useTransition();

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
      setOrders(result.data.filter(isSchedulable));
    });
  }, []);

  const today = useMemo(() => currentWeekStart(), []);
  const days = useMemo(() => Array.from({ length: DAY_COUNT }, (_, i) => addDays(weekStart, i)), [weekStart]);

  const ordersByDay = useMemo(() => {
    const map = new Map<string, OrderFulfillmentRow[]>();
    for (const day of days) map.set(day, []);
    for (const order of orders ?? []) {
      const shipBy = shipByOverrides[order.cin7_sale_id] ?? order.ship_by;
      if (!shipBy) continue;
      const bucket = map.get(shipBy.slice(0, 10));
      if (bucket) bucket.push(order);
    }
    return map;
  }, [orders, days, shipByOverrides]);

  const unscheduledCount = (orders ?? []).filter((o) => !o.ship_by).length;

  function handleDrop(day: string, saleId: string) {
    const order = (orders ?? []).find((o) => o.cin7_sale_id === saleId);
    if (!order) return;
    const previousShipBy = shipByOverrides[saleId] ?? order.ship_by;
    if (previousShipBy && previousShipBy.slice(0, 10) === day) return;

    setShipByOverrides((prev) => ({ ...prev, [saleId]: day }));
    setWriteErrors((prev) => {
      const next = { ...prev };
      delete next[saleId];
      return next;
    });
    setPendingSaleIds((prev) => new Set(prev).add(saleId));

    startLoadTransition(async () => {
      const result = await updateOrderShipByAction(order.instance_id, saleId, day);
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
        Every open order with a Ship By date, laid out on a week grid. Drag a card to a different day to reschedule
        it — the new date is written straight back to Cin7 Core, not just changed here.
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
          {isLoading && <Spinner />}
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
                isToday={day === today}
                isDraggedOver={draggedOverDay === day}
                onDragOverDay={setDraggedOverDay}
                onDragLeaveDay={(d) => setDraggedOverDay((cur) => (cur === d ? null : cur))}
                onDrop={handleDrop}
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
