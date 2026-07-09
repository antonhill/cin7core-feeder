"use client";

import { Fragment, useEffect, useMemo, useState, useTransition } from "react";
import { loadReportFilterOptionsAction } from "../actions";
import { loadOrderFulfillmentAction, exportOrderFulfillmentXlsxAction } from "./actions";
import type { ReportFilterOptions, OrderFulfillmentRow, OrderFulfillmentLineRow } from "@/reports/query";
import { Spinner } from "@/app/Spinner";
import { PageLoadingIndicator } from "@/app/PageLoadingIndicator";
import { ReportDescription } from "../ReportDescription";

type Tab = "pick" | "ship" | "all";

const TABS: { value: Tab; label: string }[] = [
  { value: "pick", label: "Pick Today" },
  { value: "ship", label: "Ship Today" },
  { value: "all", label: "All Orders" },
];

/** Every Combined* status this app tracks shares the same shape (NOT AVAILABLE/VOIDED, NOT <verb>ED, <verb>ING, PARTIALLY <verb>ED, <verb>ED) — one classifier covers all of them rather than an exhaustive per-value map. */
function statusBadgeClass(status: string | null): string {
  if (!status) return "bg-slate-100 text-slate-500";
  const s = status.toUpperCase();
  if (s === "NOT AVAILABLE" || s === "VOIDED") return "bg-slate-100 text-slate-500";
  if (s.startsWith("NOT ") || s === "UNPAID") return "bg-rose-100 text-rose-700";
  if (s.startsWith("PARTIALLY") || s.endsWith("ING")) return "bg-amber-100 text-amber-700";
  return "bg-emerald-100 text-emerald-700";
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-xs text-slate-300">—</span>;
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${statusBadgeClass(status)}`}>{status}</span>;
}

function downloadBase64File(base64: string, filename: string, mimeType: string) {
  const byteChars = atob(base64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function qty(value: number): string {
  return value.toLocaleString();
}

function money(value: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function OrderFulfillmentPage() {
  const [options, setOptions] = useState<ReportFilterOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [instanceIds, setInstanceIds] = useState<string[]>([]);

  const [orders, setOrders] = useState<OrderFulfillmentRow[] | null>(null);
  const [lines, setLines] = useState<OrderFulfillmentLineRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, startLoadTransition] = useTransition();

  const [tab, setTab] = useState<Tab>("pick");
  const [expandedSaleId, setExpandedSaleId] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [paymentFilter, setPaymentFilter] = useState("");
  const [shipByFrom, setShipByFrom] = useState("");
  const [shipByTo, setShipByTo] = useState("");
  const [fullyFulfillableOnly, setFullyFulfillableOnly] = useState(false);

  const [isExporting, startExportTransition] = useTransition();
  const [exportError, setExportError] = useState<string | null>(null);

  function runLoad() {
    setLoadError(null);
    startLoadTransition(async () => {
      const result = await loadOrderFulfillmentAction({ instanceIds: instanceIds.length ? instanceIds : undefined });
      if (!result.ok) {
        setLoadError(result.error ?? "Unknown error");
        return;
      }
      setOrders(result.data?.orders ?? []);
      setLines(result.data?.lines ?? []);
    });
  }

  useEffect(() => {
    loadReportFilterOptionsAction().then((result) => {
      if (!result.ok) setOptionsError(result.error ?? "Unknown error");
      else setOptions(result.data ?? null);
    });
    // Initial load happens directly here (not via runLoad/startTransition) so
    // every setState stays inside a .then() callback rather than running
    // synchronously in the effect body — runLoad is for the "Refresh"
    // button, a real user event, where that's fine.
    loadOrderFulfillmentAction({}).then((result) => {
      if (!result.ok) {
        setLoadError(result.error ?? "Unknown error");
        return;
      }
      setOrders(result.data?.orders ?? []);
      setLines(result.data?.lines ?? []);
    });
  }, []);

  function toggleInstance(id: string) {
    setInstanceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const linesBySaleId = useMemo(() => {
    const map = new Map<string, OrderFulfillmentLineRow[]>();
    for (const line of lines) {
      const existing = map.get(line.cin7_sale_id);
      if (existing) existing.push(line);
      else map.set(line.cin7_sale_id, [line]);
    }
    return map;
  }, [lines]);

  const paymentStatusOptions = useMemo(() => {
    if (!orders) return [];
    return [...new Set(orders.map((o) => o.combined_payment_status).filter((s): s is string => Boolean(s)))].sort();
  }, [orders]);

  const visibleRows = useMemo(() => {
    if (!orders) return [];
    let rows = orders;
    if (tab === "pick") rows = rows.filter((o) => o.is_pick_today);
    else if (tab === "ship") rows = rows.filter((o) => o.is_ship_today);

    const searchLower = search.trim().toLowerCase();
    if (searchLower) {
      rows = rows.filter(
        (o) => (o.order_number ?? "").toLowerCase().includes(searchLower) || (o.customer_name ?? "").toLowerCase().includes(searchLower)
      );
    }
    if (paymentFilter) rows = rows.filter((o) => o.combined_payment_status === paymentFilter);
    if (shipByFrom) rows = rows.filter((o) => o.ship_by !== null && o.ship_by >= shipByFrom);
    if (shipByTo) rows = rows.filter((o) => o.ship_by !== null && o.ship_by <= shipByTo);
    if (fullyFulfillableOnly) rows = rows.filter((o) => o.total_backorder_qty === 0);

    return rows;
  }, [orders, tab, search, paymentFilter, shipByFrom, shipByTo, fullyFulfillableOnly]);

  const counts = orders
    ? { pick: orders.filter((o) => o.is_pick_today).length, ship: orders.filter((o) => o.is_ship_today).length, all: orders.length }
    : null;

  function handleExport() {
    setExportError(null);
    startExportTransition(async () => {
      const result = await exportOrderFulfillmentXlsxAction(visibleRows);
      if (!result.ok || !result.data) {
        setExportError(result.error ?? "Unknown error");
        return;
      }
      downloadBase64File(result.data, `order-fulfillment-${tab}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    });
  }

  return (
    <>
      <ReportDescription title="Order Fulfillment">
        A working dashboard for pick/pack/ship/invoice/payment — not just a status report.
        <strong> Pick Today</strong> and <strong>Ship Today</strong> are priority queues (overdue orders first,
        undated orders last, nothing dropped just because it&rsquo;s late or has no ship-by date), each order
        expandable to the exact SKUs and quantities still needed. <strong>All Orders</strong> shows the complete
        picture across every stage.
      </ReportDescription>
      <PageLoadingIndicator show={isExporting} label="Exporting to Excel…" />

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="text-sm font-medium text-slate-700">Instance(s)</span>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
              {(options?.instances ?? []).map((inst) => (
                <label key={inst.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={instanceIds.includes(inst.id)} onChange={() => toggleInstance(inst.id)} className="h-4 w-4" />
                  {inst.name}
                </label>
              ))}
              {options && options.instances.length === 0 && <p className="text-sm text-slate-400">No instances connected.</p>}
            </div>
          </div>
          <button
            type="button"
            onClick={runLoad}
            disabled={isLoading}
            className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {isLoading && <Spinner className="mr-1.5" />}
            {isLoading ? "Loading…" : "Refresh"}
          </button>
        </div>
        {loadError && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>}
        {optionsError && <p className="mt-2 text-sm text-red-600">{optionsError}</p>}
      </section>

      {orders && (
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <div className="flex gap-1">
              {TABS.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setTab(t.value)}
                  className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
                    tab === t.value ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {t.label}
                  {counts && <span className="ml-1.5 opacity-75">({counts[t.value]})</span>}
                </button>
              ))}
            </div>
            {visibleRows.length > 0 && (
              <button
                type="button"
                onClick={handleExport}
                disabled={isExporting}
                className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {isExporting ? "Exporting…" : "Export to Excel"}
              </button>
            )}
          </div>
          {exportError && <p className="mt-2 text-sm text-red-600">{exportError}</p>}

          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-slate-700">Search</span>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Order # or customer"
                className="w-56 rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-slate-700">Payment</span>
              <select value={paymentFilter} onChange={(e) => setPaymentFilter(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2">
                <option value="">All</option>
                {paymentStatusOptions.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-slate-700">Ship by from</span>
              <input type="date" value={shipByFrom} onChange={(e) => setShipByFrom(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-slate-700">Ship by to</span>
              <input type="date" value={shipByTo} onChange={(e) => setShipByTo(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
            </label>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input
                type="checkbox"
                checked={fullyFulfillableOnly}
                onChange={(e) => setFullyFulfillableOnly(e.target.checked)}
                className="h-4 w-4"
              />
              <span className="font-medium text-slate-700">Fully fulfillable only (no backorders)</span>
            </label>
            {(search || paymentFilter || shipByFrom || shipByTo || fullyFulfillableOnly) && (
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setPaymentFilter("");
                  setShipByFrom("");
                  setShipByTo("");
                  setFullyFulfillableOnly(false);
                }}
                className="rounded-full border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Clear filters
              </button>
            )}
          </div>

          {visibleRows.length === 0 && <p className="mt-4 text-sm text-slate-400">Nothing matches these filters.</p>}

          {visibleRows.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 pr-4">Order</th>
                    <th className="py-2 pr-4">Ship By</th>
                    <th className="py-2 pr-4">Picking</th>
                    <th className="py-2 pr-4">Packing</th>
                    <th className="py-2 pr-4">Shipping</th>
                    <th className="py-2 pr-4">Invoice</th>
                    <th className="py-2 pr-4">Payment</th>
                    <th className="py-2 pr-4 text-right">Pickable Now</th>
                    <th className="py-2 pr-4 text-right">Paid / Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row) => (
                    <Fragment key={row.cin7_sale_id}>
                      <tr
                        onClick={() => setExpandedSaleId(expandedSaleId === row.cin7_sale_id ? null : row.cin7_sale_id)}
                        className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                      >
                        <td className="py-2 pr-4">
                          <div className="font-medium text-slate-900">{row.order_number ?? row.cin7_sale_id}</div>
                          <div className="text-xs text-slate-400">{row.customer_name}</div>
                        </td>
                        <td className="py-2 pr-4">
                          {row.ship_by ?? <span className="text-slate-300">—</span>}
                          {row.is_overdue && <span className="ml-1.5 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">Overdue</span>}
                        </td>
                        <td className="py-2 pr-4">
                          <StatusBadge status={row.combined_picking_status} />
                        </td>
                        <td className="py-2 pr-4">
                          <StatusBadge status={row.combined_packing_status} />
                        </td>
                        <td className="py-2 pr-4">
                          <StatusBadge status={row.combined_shipping_status} />
                        </td>
                        <td className="py-2 pr-4">
                          <StatusBadge status={row.combined_invoice_status} />
                        </td>
                        <td className="py-2 pr-4">
                          <StatusBadge status={row.combined_payment_status} />
                        </td>
                        <td className="py-2 pr-4 text-right font-medium">{qty(row.total_pickable_qty)}</td>
                        <td className="py-2 pr-4 text-right">
                          {money(row.paid_amount)} / {money(row.invoice_amount)}
                        </td>
                      </tr>
                      {expandedSaleId === row.cin7_sale_id && (
                        <tr>
                          <td colSpan={9} className="bg-slate-50 px-4 py-3">
                            {(linesBySaleId.get(row.cin7_sale_id) ?? []).length === 0 ? (
                              <p className="text-sm text-slate-400">No line detail synced for this order yet.</p>
                            ) : (
                              <table className="w-full text-left text-xs">
                                <thead>
                                  <tr className="text-slate-500">
                                    <th className="py-1 pr-4">Product</th>
                                    <th className="py-1 pr-4 text-right">Ordered</th>
                                    <th className="py-1 pr-4 text-right">Backordered</th>
                                    <th className="py-1 pr-4 text-right">Picked</th>
                                    <th className="py-1 pr-4 text-right">Packed</th>
                                    <th className="py-1 pr-4 text-right">Pickable Now</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {(linesBySaleId.get(row.cin7_sale_id) ?? []).map((line, i) => (
                                    <tr key={i} className="border-t border-slate-200">
                                      <td className="py-1 pr-4">
                                        <div className="font-medium text-slate-900">{line.product_name ?? line.product_sku}</div>
                                        <div className="text-slate-400">{line.product_sku}</div>
                                      </td>
                                      <td className="py-1 pr-4 text-right">{qty(line.ordered_qty)}</td>
                                      <td className="py-1 pr-4 text-right">{qty(line.backorder_qty)}</td>
                                      <td className="py-1 pr-4 text-right">{qty(line.picked_qty)}</td>
                                      <td className="py-1 pr-4 text-right">{qty(line.packed_qty)}</td>
                                      <td className="py-1 pr-4 text-right font-medium">{qty(line.pickable_qty)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
