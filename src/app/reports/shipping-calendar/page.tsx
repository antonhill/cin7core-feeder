"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { loadShippingCalendarOrdersAction, updateOrderShipByAction, loadCarriersAction, markOrderShippedAction } from "./actions";
import { currentWeekStart, mondayOf, addDays, formatDayLabel, todayIso } from "./date-utils";
import type { OrderFulfillmentRow, OrderFulfillmentLineRow } from "@/reports/query";
import type { MarkShippedInput } from "@/cin7/sales";
import type { InstancePickerItem } from "@/actions/instances";
import { ReportDescription } from "../ReportDescription";
import { StatusBadge } from "../status-badge";
import { Spinner } from "@/app/Spinner";
import { InstanceMultiPicker } from "@/app/InstanceMultiPicker";

/** What the page's onMarkShipped callback resolves to — enough for MarkAsShippedSection to render success/error itself, without needing the full ShippingCalendarActionResult shape. */
interface MarkShippedOutcome {
  ok: boolean;
  error?: string;
  cin7WebUrl?: string;
}

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

/**
 * The "mark as shipped" form + its own submit/success/error state, split
 * out of OrderDetailModal since it's genuinely self-contained (carrier
 * list, date/carrier/tracking inputs, one submit action) and the modal
 * itself doesn't need to know any of that mid-submission state.
 */
function MarkAsShippedSection({
  order,
  onMarkShipped,
}: {
  order: OrderFulfillmentRow;
  onMarkShipped: (saleId: string, instanceId: string, input: MarkShippedInput) => Promise<MarkShippedOutcome>;
}) {
  const [shipmentDate, setShipmentDate] = useState(todayIso);
  const [carrier, setCarrier] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [carrierOptions, setCarrierOptions] = useState<string[]>([]);
  const [isSubmitting, startSubmitTransition] = useTransition();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [shippedResult, setShippedResult] = useState<{ cin7WebUrl: string } | null>(null);

  useEffect(() => {
    loadCarriersAction(order.instance_id).then((result) => {
      if (result.ok) setCarrierOptions(result.data ?? []);
    });
  }, [order.instance_id]);

  const level = readiness(order);

  if (shippedResult) {
    return (
      <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
        <p className="font-medium">Marked as shipped in Cin7.</p>
        <p className="mt-1">
          Cin7&rsquo;s API has no box-label endpoint —{" "}
          <a href={shippedResult.cin7WebUrl} target="_blank" rel="noopener noreferrer" className="underline">
            open Cin7 Core
          </a>{" "}
          to print it from there.
        </p>
      </div>
    );
  }

  if (level !== "ready") {
    return (
      <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        Not ready to ship yet — Cin7 requires this order to be fully packed first ({READINESS_LABEL[level]}).
      </p>
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    startSubmitTransition(async () => {
      const result = await onMarkShipped(order.cin7_sale_id, order.instance_id, {
        shipmentDate,
        carrier,
        trackingNumber: trackingNumber || undefined,
      });
      if (!result.ok) {
        setSubmitError(result.error ?? "Unknown error");
        return;
      }
      setShippedResult({ cin7WebUrl: result.cin7WebUrl ?? "" });
    });
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <label className="flex flex-col gap-1 text-sm text-slate-600">
        Shipment date
        <input
          type="date"
          value={shipmentDate}
          onChange={(e) => setShipmentDate(e.target.value)}
          required
          disabled={isSubmitting}
          className="rounded border border-slate-300 px-2 py-1 text-sm disabled:opacity-50"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-slate-600">
        Carrier
        <input
          type="text"
          list="shipping-calendar-carriers"
          value={carrier}
          onChange={(e) => setCarrier(e.target.value)}
          required
          disabled={isSubmitting}
          placeholder="e.g. DEFAULT Carrier"
          className="w-48 rounded border border-slate-300 px-2 py-1 text-sm disabled:opacity-50"
        />
        <datalist id="shipping-calendar-carriers">
          {carrierOptions.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </label>
      <label className="flex flex-col gap-1 text-sm text-slate-600">
        Tracking number
        <input
          type="text"
          value={trackingNumber}
          onChange={(e) => setTrackingNumber(e.target.value)}
          placeholder="Optional"
          disabled={isSubmitting}
          className="w-40 rounded border border-slate-300 px-2 py-1 text-sm disabled:opacity-50"
        />
      </label>
      <button
        type="submit"
        disabled={isSubmitting || !carrier.trim()}
        className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
      >
        {isSubmitting && <Spinner className="mr-1.5" />}
        {isSubmitting ? "Marking shipped…" : "Mark as Shipped"}
      </button>
      {submitError && <p className="w-full text-sm text-rose-600">{submitError}</p>}
    </form>
  );
}

function OrderCard({
  order,
  instanceName,
  isPending,
  error,
  onOpenDetail,
}: {
  order: OrderFulfillmentRow;
  /** Only passed when more than one instance is connected — a single-instance org has no need for the label. */
  instanceName?: string;
  isPending: boolean;
  error?: string;
  onOpenDetail: (saleId: string) => void;
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
        <StatusBadge status={order.combined_invoice_status} wrap />
        <StatusBadge status={order.combined_payment_status} wrap />
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
          isPending={pendingSaleIds.has(order.cin7_sale_id)}
          error={writeErrors[order.cin7_sale_id]}
          onOpenDetail={onOpenDetail}
        />
      ))}
    </div>
  );
}

/**
 * Order detail (all 5 Combined*Status fields + full line-level SKU table)
 * doesn't fit readably inside a ~180px kanban card at any font size — shown
 * full-width in a modal instead, same pattern as Order Fulfillment's own
 * Batch Pick List modal. The "Move to" date picker lives here too, not on
 * the card — a native date input has its own browser-enforced minimum
 * width that a week-view column (there are always 7 of them, at any screen
 * size) can't reliably give it without either clipping a digit or forcing
 * the whole grid wider than intended.
 */
function OrderDetailModal({
  order,
  lines,
  effectiveShipBy,
  isPending,
  instanceActive,
  onReschedule,
  onMarkShipped,
  onClose,
}: {
  order: OrderFulfillmentRow;
  lines: OrderFulfillmentLineRow[];
  effectiveShipBy: string;
  isPending: boolean;
  /** False when this order's Cin7 instance has been disconnected — reschedule/mark-shipped/carrier-loading all hit the live Cin7 API and would just fail server-side, so disable them with an explanation instead. */
  instanceActive: boolean;
  onReschedule: (saleId: string, newDate: string) => void;
  onMarkShipped: (saleId: string, instanceId: string, input: MarkShippedInput) => Promise<MarkShippedOutcome>;
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

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="text-sm text-slate-600">
            Ship By: <span className="font-medium text-slate-900">{order.ship_by ?? "—"}</span>
            {order.is_overdue && (
              <span className="ml-2 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">Overdue</span>
            )}
          </p>
          <label className="flex items-center gap-1.5 text-sm text-slate-500">
            Move to
            <input
              type="date"
              value={effectiveShipBy}
              disabled={isPending || !instanceActive}
              title={!instanceActive ? "Instance disconnected — can't reschedule" : undefined}
              onChange={(e) => e.target.value && onReschedule(order.cin7_sale_id, e.target.value)}
              className="rounded border border-slate-300 px-2 py-1 text-sm text-slate-700 disabled:opacity-50"
            />
            {isPending && <Spinner className="h-3 w-3" />}
          </label>
          {!instanceActive && (
            <p className="w-full text-sm text-slate-400">Instance disconnected — read-only.</p>
          )}
        </div>

        {instanceActive && <MarkAsShippedSection order={order} onMarkShipped={onMarkShipped} />}

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
  const [instances, setInstances] = useState<InstancePickerItem[]>([]);
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
  const instanceActiveById = useMemo(() => new Map(instances.map((i) => [i.id, i.active])), [instances]);

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
      // Re-checked here (not just at load time) so an order just marked
      // shipped from this page disappears from the grid immediately,
      // rather than waiting for the next full reload.
      if (!isSchedulable(order)) continue;
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

  /** Marks the order shipped in Cin7, then updates the local copy's status so ordersByDay's isSchedulable check drops it from the grid right away — MarkAsShippedSection renders the actual success/error state itself from what this resolves to. */
  async function handleMarkShipped(saleId: string, instanceId: string, input: MarkShippedInput): Promise<MarkShippedOutcome> {
    const result = await markOrderShippedAction(instanceId, saleId, input);
    if (!result.ok || !result.data) {
      return { ok: false, error: result.error ?? "Unknown error" };
    }
    setOrders((prev) => (prev ? prev.map((o) => (o.cin7_sale_id === saleId ? { ...o, combined_shipping_status: "SHIPPED" } : o)) : prev));
    return { ok: true, cin7WebUrl: result.data.cin7WebUrl };
  }

  return (
    <>
      <ReportDescription title="Shipping Calendar">
        Every open order with a Ship By date, laid out on a week grid. Drag a card to a different day within the
        visible week, or click it to open its detail and use the <strong>Move to</strong>{" "}
        date picker to jump it to any date — either way, the new date is written straight back to Cin7 Core, not just
        changed here. The dot shows whether it&rsquo;s actually ready to ship yet.
      </ReportDescription>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        {instances.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-slate-100 pb-4">
            <span className="text-sm font-medium text-slate-700">Instance(s)</span>
            <InstanceMultiPicker instances={instances} selectedIds={instanceIds} onToggle={toggleInstance} wrap />
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
          effectiveShipBy={shipByOverrides[detailOrder.cin7_sale_id] ?? detailOrder.ship_by ?? today}
          isPending={pendingSaleIds.has(detailOrder.cin7_sale_id)}
          instanceActive={instanceActiveById.get(detailOrder.instance_id) !== false}
          onReschedule={handleReschedule}
          onMarkShipped={handleMarkShipped}
          onClose={() => setDetailSaleId(null)}
        />
      )}
    </>
  );
}
