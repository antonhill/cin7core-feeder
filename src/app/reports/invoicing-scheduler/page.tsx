"use client";

import { useEffect, useMemo, useState } from "react";
import { loadInvoicingSchedulerOrdersAction, loadInstanceOriginsAction, type InstanceOrigin } from "./actions";
import { currentWeekStart, addDays, formatDayLabel } from "./date-utils";
import type { OrderFulfillmentRow, OrderFulfillmentLineRow } from "@/reports/query";
import type { InstancePickerItem } from "@/actions/instances";
import { ReportDescription } from "../ReportDescription";
import { StatusBadge } from "../status-badge";
import { matchesSearch } from "../text-search";
import { SearchInput } from "../search-input";
import { InstanceMultiPicker } from "@/app/InstanceMultiPicker";
import { cin7SaleUrl } from "@/cin7/web-url";

const DAY_COUNT = 7;

/**
 * LBL brief P1: `combined_invoice_status` is a sale-level aggregate, so it
 * can't tell a sale with a fulfilment that's packed-and-not-yet-invoiced
 * apart from one that's already fully invoiced on a multi-fulfilment order
 * — it also can't exclude an order that's simply not packed yet at all
 * (nothing to invoice regardless of status). `is_ready_to_invoice`
 * (report_order_fulfillment, migration 0062) is the real per-SKU quantity
 * comparison instead: authorised-packed minus invoiced, summed across every
 * fulfilment/invoice on the order. Already floor-aware (P5.3) — an order
 * hidden by the instance's fulfilment_view_start_date setting is already
 * excluded here, no extra check needed.
 */
function needsInvoicing(order: OrderFulfillmentRow): boolean {
  return order.is_ready_to_invoice;
}

function isShipped(order: OrderFulfillmentRow): boolean {
  return order.combined_shipping_status === "SHIPPED";
}

function InvoicingCard({ order, instanceName, cin7Url }: { order: OrderFulfillmentRow; instanceName?: string; cin7Url: string | null }) {
  const shipped = isShipped(order);
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-white p-1.5 text-[11px] shadow-sm">
      <div className="flex items-start gap-1.5">
        <span
          title={shipped ? "Already shipped" : "Not shipped yet"}
          className={`mt-1 h-2 w-2 shrink-0 rounded-full ${shipped ? "bg-emerald-500" : "bg-slate-300"}`}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-slate-900">{order.order_number ?? order.cin7_sale_id}</div>
          <div className="truncate text-slate-500">{order.customer_name}</div>
          {instanceName && <div className="truncate text-slate-400">{instanceName}</div>}
        </div>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <StatusBadge status={order.combined_invoice_status} wrap />
        <span className={shipped ? "text-emerald-600" : "text-slate-400"}>{shipped ? "Shipped" : "Not shipped"}</span>
      </div>
      {order.ready_to_invoice_fulfilment_numbers && (
        <div
          className="mt-1 text-indigo-600"
          title={(order.ready_to_invoice_fulfilments ?? [])
            .map((f) => `Fulfilment ${f.fulfilment_number ?? "?"}: ${f.ready_to_invoice_qty.toLocaleString()} awaiting invoice`)
            .join("\n")}
        >
          Fulfilment{order.ready_to_invoice_fulfilment_numbers.includes(",") ? "s" : ""} #{order.ready_to_invoice_fulfilment_numbers} ready
        </div>
      )}
      {order.ship_by && <div className="mt-1 text-slate-400">Ship by {order.ship_by.slice(0, 10)}</div>}
      {order.is_overdue && <div className="mt-1 font-semibold text-rose-600">Overdue</div>}
      {cin7Url && (
        <a href={cin7Url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block font-medium text-indigo-600 underline">
          Open in Cin7 ↗
        </a>
      )}
    </div>
  );
}

function DayColumn({
  day,
  orders,
  instanceNameById,
  originByInstanceId,
  isToday,
}: {
  day: string;
  orders: OrderFulfillmentRow[];
  instanceNameById: Map<string, string>;
  originByInstanceId: Map<string, string>;
  isToday: boolean;
}) {
  return (
    <div className={`flex flex-col rounded-xl border bg-slate-50/50 p-2 ${isToday ? "border-indigo-300 ring-1 ring-indigo-200" : "border-slate-200"}`}>
      <div className="mb-2 flex items-center justify-between px-1">
        <span className={`text-xs font-semibold ${isToday ? "text-indigo-700" : "text-slate-600"}`}>{formatDayLabel(day)}</span>
        <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">{orders.length}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {orders.map((order) => {
          const origin = originByInstanceId.get(order.instance_id);
          return (
            <InvoicingCard
              key={order.cin7_sale_id}
              order={order}
              instanceName={instanceNameById.size > 1 ? instanceNameById.get(order.instance_id) : undefined}
              cin7Url={origin ? cin7SaleUrl(origin, order.cin7_sale_id) : null}
            />
          );
        })}
        {orders.length === 0 && <p className="px-1 text-[11px] text-slate-300">Nothing</p>}
      </div>
    </div>
  );
}

export default function InvoicingSchedulerPage() {
  const [weekStart, setWeekStart] = useState(currentWeekStart);
  const [orders, setOrders] = useState<OrderFulfillmentRow[] | null>(null);
  const [lines, setLines] = useState<OrderFulfillmentLineRow[]>([]);
  // P5.3 (LBL brief): counted separately at load time, since `orders` itself
  // already has ready_to_invoice_hidden_by_floor rows filtered out by
  // needsInvoicing — same pattern as shipping-calendar/page.tsx's own
  // hiddenByFloorCount.
  const [hiddenByFloorCount, setHiddenByFloorCount] = useState(0);
  const [instances, setInstances] = useState<InstancePickerItem[]>([]);
  const [origins, setOrigins] = useState<InstanceOrigin[]>([]);
  const [instanceIds, setInstanceIds] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [offsetDays, setOffsetDays] = useState(0);
  const [search, setSearch] = useState("");

  // Same convention as shipping-calendar/page.tsx's own instance-switch
  // effect: only setState from inside the .then() callback, never
  // synchronously in the effect body, to stay clear of
  // react-hooks/set-state-in-effect.
  useEffect(() => {
    loadInvoicingSchedulerOrdersAction({ instanceIds: instanceIds.length ? instanceIds : undefined }).then((result) => {
      if (!result.ok || !result.data) {
        setLoadError(result.error ?? "Unknown error");
        return;
      }
      setLoadError(null);
      setOrders(result.data.orders.filter(needsInvoicing));
      setHiddenByFloorCount(result.data.orders.filter((o) => o.ready_to_invoice_hidden_by_floor).length);
      setLines(result.data.lines);
      setInstances(result.data.instances);
    });
  }, [instanceIds]);

  useEffect(() => {
    loadInstanceOriginsAction().then((result) => {
      if (result.ok) setOrigins(result.data ?? []);
    });
  }, []);

  function toggleInstance(id: string) {
    setInstanceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const today = useMemo(() => currentWeekStart(), []);
  const days = useMemo(() => Array.from({ length: DAY_COUNT }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const instanceNameById = useMemo(() => new Map(instances.map((i) => [i.id, i.name])), [instances]);
  const originByInstanceId = useMemo(() => new Map(origins.map((o) => [o.instanceId, o.origin])), [origins]);

  const linesBySaleId = useMemo(() => {
    const map = new Map<string, OrderFulfillmentLineRow[]>();
    for (const line of lines) {
      const existing = map.get(line.cin7_sale_id);
      if (existing) existing.push(line);
      else map.set(line.cin7_sale_id, [line]);
    }
    return map;
  }, [lines]);

  // P5.4 (LBL brief): matches order #/customer OR any line's SKU/product name.
  const searchedOrders = useMemo(() => {
    if (!search.trim()) return orders ?? [];
    return (orders ?? []).filter(
      (o) =>
        matchesSearch(search, o.order_number, o.customer_name) ||
        (linesBySaleId.get(o.cin7_sale_id) ?? []).some((l) => matchesSearch(search, l.product_sku, l.product_name))
    );
  }, [orders, search, linesBySaleId]);

  // Recomputed instantly whenever the offset/search/week changes — no
  // server round trip, matching every other filter-driven report in this
  // app (e.g. reorder-points' own instant recompute).
  const ordersByDay = useMemo(() => {
    const map = new Map<string, OrderFulfillmentRow[]>();
    for (const day of days) map.set(day, []);
    for (const order of searchedOrders) {
      if (!order.ship_by) continue;
      const bucketDate = addDays(order.ship_by.slice(0, 10), offsetDays);
      const bucket = map.get(bucketDate);
      if (bucket) bucket.push(order);
    }
    return map;
  }, [searchedOrders, days, offsetDays]);

  return (
    <>
      <ReportDescription title="Invoicing Scheduler">
A calendar of sales that have a packed, authorised fulfilment not yet covered by an invoice — including orders
        already partially invoiced from an earlier fulfilment — placed on the day you choose relative to Ship By. Set
        the offset below to see what needs invoicing today, a few days ahead, or a few days after shipping. Each card
        links straight into that sale in Cin7 Core and shows whether it&rsquo;s already shipped. Read-only — nothing
        here writes to Cin7.
      </ReportDescription>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="text-sm font-medium text-slate-700">Instance(s)</span>
            <div className="mt-2">
              <InstanceMultiPicker instances={instances} selectedIds={instanceIds} onToggle={toggleInstance} wrap />
            </div>
          </div>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-slate-700">Show on calendar</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={offsetDays}
                onChange={(e) => setOffsetDays(Number(e.target.value) || 0)}
                className="w-20 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
              />
              <span className="text-slate-500">
                day{Math.abs(offsetDays) === 1 ? "" : "s"} {offsetDays < 0 ? "before" : offsetDays > 0 ? "after" : "on"} Ship By
              </span>
            </div>
          </label>
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Order #, customer, or SKU"
            className="w-56 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
          />
        </div>
        {loadError && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>}
        {hiddenByFloorCount > 0 && (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {hiddenByFloorCount} older order{hiddenByFloorCount === 1 ? "" : "s"} hidden by the start-date setting — visible on Order
            Fulfillment&rsquo;s All Orders tab, or adjust the setting on{" "}
            <a href="/settings/instances" className="underline">
              Instances
            </a>
            .
          </p>
        )}
      </section>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setWeekStart((w) => addDays(w, -7))}
              className="rounded-full border border-slate-300 px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              ← Prev week
            </button>
            <button
              type="button"
              onClick={() => setWeekStart(today)}
              className="rounded-full border border-slate-300 px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              This week
            </button>
            <button
              type="button"
              onClick={() => setWeekStart((w) => addDays(w, 7))}
              className="rounded-full border border-slate-300 px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Next week →
            </button>
          </div>
          <p className="text-sm text-slate-500">
            {formatDayLabel(days[0])} – {formatDayLabel(days[days.length - 1])}
          </p>
        </div>

        {orders && (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-7">
            {days.map((day) => (
              <DayColumn
                key={day}
                day={day}
                orders={ordersByDay.get(day) ?? []}
                instanceNameById={instanceNameById}
                originByInstanceId={originByInstanceId}
                isToday={day === today}
              />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
