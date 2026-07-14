"use client";

import { useMemo, useState, useTransition, Fragment } from "react";
import {
  loadProductionTrackingAction,
  loadProductionOrderDetailAction,
  loadProductionTrackingSyncStatusAction,
  triggerProductionTrackingSyncAction,
} from "./actions";
import { listInstancesForPicker, type InstancePickerItem } from "@/actions/instances";
import type { ProductionTrackingRow, ProductionOperationRow, ProductionTrackingSyncStatus } from "@/reports/production-tracking/query";
import {
  isLate,
  daysLate,
  groupByWorkCentre,
  groupByStatus,
  cumulativeCostThroughStage,
  hasInputShortfall,
  hasInputOverproduction,
  operationHasInputShortfall,
  operationHasInputOverproduction,
  previousOperation,
  reconcileInputFlow,
  currentStageFallbackLabel,
  PRODUCTION_STATUS_ORDER,
  type WorkCentreColumn,
} from "@/reports/production-tracking/build";
import { StaleBadge, staleSyncButtonClass } from "../sync-staleness";
import { compareNullable, SortHeader, type SortDirection } from "../sortable-table";
import { Spinner } from "@/app/Spinner";
import { ReportDescription } from "../ReportDescription";

type SortColumn = "orderNumber" | "product" | "currentOperation" | "listStatus" | "requiredByDate" | "daysLate" | "wipActualCost" | "totalWastage";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function sortValue(row: ProductionTrackingRow, column: SortColumn, today: string): string | number | null {
  switch (column) {
    case "orderNumber":
      return row.orderNumber;
    case "product":
      return row.productName ?? row.productSku;
    case "currentOperation":
      return row.currentOperationName;
    case "listStatus":
      return row.listStatus;
    case "requiredByDate":
      return row.requiredByDate;
    case "daysLate":
      return daysLate(row.requiredByDate, today);
    case "wipActualCost":
      return row.wipActualCost ?? 0;
    case "totalWastage":
      return row.totalWastage;
  }
}

function money(value: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function qty(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function dateOnly(value: string | null): string {
  return value ? value.slice(0, 10) : "—";
}

function ProductionOrderDetailPanel({
  operations,
  isLoading,
  error,
}: {
  operations: ProductionOperationRow[] | undefined;
  isLoading: boolean;
  error: string | undefined;
}) {
  if (isLoading)
    return (
      <p className="px-4 py-3 text-sm text-slate-500">
        <Spinner className="mr-1.5" />
        Loading operations…
      </p>
    );
  if (error) return <p className="px-4 py-3 text-sm text-red-700">{error}</p>;
  if (!operations || operations.length === 0)
    return <p className="px-4 py-3 text-sm text-slate-500">No operation detail synced yet for this order.</p>;

  return (
    <div className="overflow-x-auto px-4 py-4">
      <table className="w-full text-left text-sm text-slate-700">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-slate-400">
            <th className="py-1 pr-4 font-medium">Operation</th>
            <th className="py-1 pr-4 font-medium">Work Centre</th>
            <th className="py-1 pr-4 font-medium">Status</th>
            <th className="py-1 pr-4 text-right font-medium">Planned Time</th>
            <th className="py-1 pr-4 text-right font-medium">Actual Time</th>
            <th className="py-1 pr-4 font-medium">Input (from previous stage)</th>
            <th className="py-1 pr-4 text-right font-medium">Component Wastage</th>
            <th className="py-1 pr-4 text-right font-medium">Actual Cost</th>
            <th className="py-1 pr-4 text-right font-medium">Cost so far</th>
          </tr>
        </thead>
        <tbody>
          {operations.map((op) => {
            const stageCost = (op.actualResourceCost ?? 0) + (op.actualMaterialCost ?? 0);
            const hasInputData = op.inputExpectedQty !== null;
            const shortfall = operationHasInputShortfall(op);
            const overproduction = operationHasInputOverproduction(op);
            const shortfallQty = shortfall ? (op.inputExpectedQty ?? 0) - (op.inputActualQty ?? 0) : 0;
            const overQty = overproduction ? (op.inputActualQty ?? 0) - (op.inputExpectedQty ?? 0) : 0;
            // Cin7 tracks Output wastage (flagged on the producing stage) and Input
            // wastage (flagged on the receiving stage) as separate, non-propagating
            // figures — confirmed live 2026-07-14 (MO-00042) that Roasting's own
            // Output recorded 2 wastage while Grinding's Input still read 0 for the
            // same handoff. Check the previous stage's own Output record before
            // claiming a shortfall "wasn't flagged as wastage" anywhere.
            const upstream = shortfall ? previousOperation(operations, op.operationOrder) : null;
            const upstreamWastage = upstream?.outputWastageQty ?? 0;
            return (
              <tr
                key={op.operationOrder}
                className={`border-t ${shortfall ? "border-red-200 bg-red-50" : overproduction ? "border-amber-200 bg-amber-50" : "border-slate-100"}`}
              >
                <td className="py-1 pr-4">{op.operationName ?? "—"}</td>
                <td className="py-1 pr-4">{op.workCenterName ?? "—"}</td>
                <td className="py-1 pr-4">{op.status ?? "—"}</td>
                <td className="py-1 pr-4 text-right">{op.plannedTime ?? "—"}</td>
                <td className="py-1 pr-4 text-right">{op.actualTime ?? "—"}</td>
                <td className="py-1 pr-4 text-xs">
                  {hasInputData ? (
                    <>
                      Received {qty(op.inputActualQty ?? 0)} of {qty(op.inputExpectedQty ?? 0)} expected
                      {(op.inputWastageQty ?? 0) > 0 && (
                        <span className="text-rose-600"> — {qty(op.inputWastageQty ?? 0)} lost upstream</span>
                      )}
                      {shortfall &&
                        (upstreamWastage > 0 ? (
                          <span className="font-semibold text-rose-700">
                            {" "}
                            — ⚠ {qty(shortfallQty)} short — flagged as {qty(upstreamWastage)} wastage in {upstream?.operationName ?? "the previous stage"}
                          </span>
                        ) : (
                          <span className="font-semibold text-rose-700"> — ⚠ {qty(shortfallQty)} short (not flagged as wastage)</span>
                        ))}
                      {overproduction && (
                        <span className="font-semibold text-amber-700"> — ▲ {qty(overQty)} over-received</span>
                      )}
                    </>
                  ) : (
                    <span className="text-slate-400">Not tracked for this stage</span>
                  )}
                </td>
                <td className="py-1 pr-4 text-right">{op.wastageQty ? qty(op.wastageQty) : "—"}</td>
                <td className="py-1 pr-4 text-right">{stageCost ? money(stageCost) : "—"}</td>
                <td className="py-1 pr-4 text-right font-medium">
                  {money(cumulativeCostThroughStage(operations, op.operationOrder))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Read-only — no drag-and-drop. Cin7's own UI (Start/Suspend/Resume/
 * Complete) is where operations actually move; dragging a card here would
 * imply write-back, which is out of scope (this report is visibility
 * only). Column/card styling mirrors Shipping Calendar's day-column
 * kanban (src/app/reports/shipping-calendar/page.tsx) minus every
 * drag-specific prop.
 */
function ProductionOrderCard({ row, today, onOpenDetail }: { row: ProductionTrackingRow; today: string; onOpenDetail: (id: string) => void }) {
  const late = isLate(row.requiredByDate, row.listStatus, today);
  const days = daysLate(row.requiredByDate, today);
  const shortfall = hasInputShortfall(row);
  const overproduction = hasInputOverproduction(row);
  return (
    <div
      onClick={() => onOpenDetail(row.productionOrderId)}
      className={`min-w-0 cursor-pointer overflow-hidden rounded-lg border p-2 text-xs shadow-sm transition hover:border-indigo-300 ${
        shortfall ? "border-red-400 bg-red-50" : overproduction ? "border-amber-400 bg-amber-50" : "border-slate-200 bg-white"
      }`}
    >
      <div className="truncate font-medium text-slate-900">{row.orderNumber ?? row.productionOrderId}</div>
      <div className="truncate text-slate-500">{row.productName ?? row.productSku ?? "—"}</div>
      {row.tags && <div className="truncate text-slate-400">🏷 {row.tags}</div>}
      <div className="mt-1 text-slate-400">Qty planned: {row.plannedQuantity !== null ? qty(row.plannedQuantity) : "—"}</div>
      {shortfall && (
        <div className="mt-1 rounded bg-red-100 px-1.5 py-0.5 font-semibold text-red-700">
          ⚠ Short input: {qty(row.currentInputActualQty ?? 0)} of {qty(row.currentInputExpectedQty ?? 0)} expected
        </div>
      )}
      {overproduction && (
        <div className="mt-1 rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-700">
          ▲ Over-received: {qty(row.currentInputActualQty ?? 0)} of {qty(row.currentInputExpectedQty ?? 0)} expected
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {late && <span className="rounded-full bg-rose-100 px-2 py-0.5 font-semibold text-rose-700">{days}d late</span>}
        {row.totalWastage > 0 && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-700">component wastage</span>
        )}
      </div>
      {row.listStatus !== "COMPLETED" && row.listStatus !== "VOIDED" && (
        <div className="mt-1 text-slate-400">WIP: {row.wipActualCost ? money(row.wipActualCost) : "—"}</div>
      )}
    </div>
  );
}

function WorkCentreColumnView({
  workCentre,
  orders,
  today,
  onOpenDetail,
}: {
  workCentre: string;
  orders: ProductionTrackingRow[];
  today: string;
  onOpenDetail: (id: string) => void;
}) {
  return (
    <div className="flex min-h-[220px] w-64 shrink-0 flex-col gap-1.5 rounded-xl border border-slate-200 bg-slate-50 p-2">
      <div className="mb-1 flex items-baseline justify-between px-0.5 text-xs font-semibold text-slate-600">
        <span>{workCentre}</span>
        <span className="font-normal text-slate-400">{orders.length}</span>
      </div>
      {orders.map((row) => (
        <ProductionOrderCard key={row.productionOrderId} row={row} today={today} onOpenDetail={onOpenDetail} />
      ))}
    </div>
  );
}

/** Renders any set of already-grouped columns — reused for both the work-centre board (groupByWorkCentre) and the status board (groupByStatus); the two groupings differ, the rendering doesn't. */
function BoardView({ columns, today, onOpenDetail }: { columns: WorkCentreColumn[]; today: string; onOpenDetail: (id: string) => void }) {
  if (columns.length === 0) return null;
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {columns.map((column) => (
        <WorkCentreColumnView key={column.workCentre} workCentre={column.workCentre} orders={column.orders} today={today} onOpenDetail={onOpenDetail} />
      ))}
    </div>
  );
}

/** Detail doesn't fit readably inside a card at any font size — same reasoning Shipping Calendar's own OrderDetailModal comment gives — so a click opens this instead. */
function ProductionOrderDetailModal({
  row,
  operations,
  isLoading,
  error,
  onClose,
}: {
  row: ProductionTrackingRow;
  operations: ProductionOperationRow[] | undefined;
  isLoading: boolean;
  error: string | undefined;
  onClose: () => void;
}) {
  const reconciliation = operations ? reconcileInputFlow(operations) : null;
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50" onClick={onClose}>
      <div className="mx-auto my-8 max-w-6xl rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">{row.orderNumber ?? row.productionOrderId}</h2>
            <p className="text-sm text-slate-500">
              {row.productName ?? row.productSku} — {row.currentOperationName ?? currentStageFallbackLabel(row)}
              {row.currentWorkCenterName && ` (${row.currentWorkCenterName})`}
            </p>
            {row.tags && <p className="text-sm text-slate-500">🏷 {row.tags}</p>}
            <p className="text-sm text-slate-500">
              Qty planned: {row.plannedQuantity !== null ? qty(row.plannedQuantity) : "—"}
            </p>
            {row.actualOutputQty !== null && (
              <p
                className={`text-sm ${
                  row.plannedQuantity !== null && row.actualOutputQty < row.plannedQuantity ? "font-semibold text-red-700" : "text-slate-500"
                }`}
              >
                Actual out: {qty(row.actualOutputQty)}
              </p>
            )}
            {reconciliation && (
              <p
                className={`mt-2 inline-block rounded-lg px-3 py-1.5 text-sm font-medium ${
                  reconciliation.netDeviationQty < 0 ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"
                }`}
              >
                {qty(Math.abs(reconciliation.netDeviationQty))} {reconciliation.netDeviationQty < 0 ? "short" : "over"} overall as of{" "}
                {reconciliation.finalOperationName}
                {reconciliation.originOperationName !== reconciliation.finalOperationName && (
                  <>
                    {" "}
                    — first appeared at {reconciliation.originOperationName}
                    {reconciliation.originDeviationQty === reconciliation.netDeviationQty
                      ? ", unchanged since (no additional loss/gain downstream)"
                      : ` (${qty(Math.abs(reconciliation.originDeviationQty))} there, now ${qty(Math.abs(reconciliation.netDeviationQty))})`}
                  </>
                )}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Close
          </button>
        </div>
        <ProductionOrderDetailPanel operations={operations} isLoading={isLoading} error={error} />
      </div>
    </div>
  );
}

type ViewMode = "table" | "board" | "status";

const VIEW_MODE_TABS: { value: ViewMode; label: string }[] = [
  { value: "table", label: "Table" },
  { value: "board", label: "Work Centre Board" },
  { value: "status", label: "Status Board" },
];

export default function ProductionTrackingPage() {
  const [instances, setInstances] = useState<InstancePickerItem[]>([]);
  const [instancesError, setInstancesError] = useState<string | null>(null);
  const [isLoadingInstances, startLoadTransition] = useTransition();
  const [instanceId, setInstanceId] = useState<string | null>(null);

  const [syncStatus, setSyncStatus] = useState<ProductionTrackingSyncStatus | null>(null);
  const [isSyncing, startSyncTransition] = useTransition();
  const [syncError, setSyncError] = useState<string | null>(null);

  const [rows, setRows] = useState<ProductionTrackingRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoadingRows, startRowsTransition] = useTransition();
  const [includeCompleted, setIncludeCompleted] = useState(false);

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [operationsById, setOperationsById] = useState<Record<string, ProductionOperationRow[]>>({});
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const [loadingDetailIds, setLoadingDetailIds] = useState<Set<string>>(new Set());

  const [viewMode, setViewMode] = useState<ViewMode>("table");
  const [modalOrderId, setModalOrderId] = useState<string | null>(null);
  // COMPLETED/VOIDED start hidden (unchecked) on purpose: hiddenStatuses
  // only filters already-loaded rows, and those two are never fetched
  // until toggleStatusColumn's fetch-trigger runs on a hidden -> shown
  // transition — starting them shown skips that transition entirely
  // (confirmed live: they read "checked" but show nothing until manually
  // unticked and reticked), so the first real check needs them to start
  // unticked.
  const [hiddenStatuses, setHiddenStatuses] = useState<Set<string>>(new Set(["COMPLETED", "VOIDED"]));
  const [productSearch, setProductSearch] = useState("");

  function toggleStatusColumn(status: string) {
    const wasHidden = hiddenStatuses.has(status);
    setHiddenStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
    // Un-hiding COMPLETED/VOIDED only matters if those orders were actually
    // fetched — the top-level "Include completed/voided" toggle lives on
    // the Table view only now, so checking these columns here must trigger
    // that fetch itself the first time, rather than un-hiding an empty set.
    if (wasHidden && (status === "COMPLETED" || status === "VOIDED") && !includeCompleted && instanceId) {
      setIncludeCompleted(true);
      refreshRowsAndStatus(instanceId, true);
    }
  }

  const [sortColumn, setSortColumn] = useState<SortColumn>("daysLate");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  function handleSort(column: SortColumn) {
    if (column === sortColumn) setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  }

  function handleLoadInstances() {
    setInstancesError(null);
    startLoadTransition(async () => {
      const res = await listInstancesForPicker();
      if (!res.ok) {
        setInstancesError(res.error ?? "Unknown error");
        return;
      }
      setInstances(res.instances ?? []);
    });
  }

  function refreshRowsAndStatus(id: string, withCompleted: boolean) {
    setLoadError(null);
    setExpandedIds(new Set());
    setOperationsById({});
    setDetailErrors({});
    setModalOrderId(null);
    startRowsTransition(async () => {
      const res = await loadProductionTrackingAction(id, withCompleted);
      if (!res.ok) {
        setLoadError(res.error ?? "Unknown error");
        return;
      }
      setRows(res.data ?? []);
    });
    loadProductionTrackingSyncStatusAction(id).then((res) => {
      if (res.ok) setSyncStatus(res.data ?? null);
    });
  }

  function handleSelectInstance(id: string) {
    setInstanceId(id);
    setRows(null);
    refreshRowsAndStatus(id, includeCompleted);
  }

  function handleToggleIncludeCompleted() {
    const next = !includeCompleted;
    setIncludeCompleted(next);
    if (instanceId) refreshRowsAndStatus(instanceId, next);
  }

  function handleSync() {
    if (!instanceId) return;
    setSyncError(null);
    startSyncTransition(async () => {
      const result = await triggerProductionTrackingSyncAction(instanceId);
      if (!result.ok) {
        setSyncError(result.error ?? "Unknown error");
        return;
      }
      refreshRowsAndStatus(instanceId, includeCompleted);
    });
  }

  /** Fetches one order's operations if not already cached or in flight — shared by the table's row-expand and the board's detail modal, neither of which re-fetches an order that's already loaded. */
  function ensureOperationsLoaded(productionOrderId: string) {
    if (!instanceId || operationsById[productionOrderId] || loadingDetailIds.has(productionOrderId)) return;
    setLoadingDetailIds((prev) => new Set(prev).add(productionOrderId));
    loadProductionOrderDetailAction(instanceId, productionOrderId).then((res) => {
      setLoadingDetailIds((prev) => {
        const next = new Set(prev);
        next.delete(productionOrderId);
        return next;
      });
      if (!res.ok || !res.data) {
        setDetailErrors((prev) => ({ ...prev, [productionOrderId]: res.error ?? "Unknown error" }));
        return;
      }
      setOperationsById((prev) => ({ ...prev, [productionOrderId]: res.data! }));
    });
  }

  function handleToggleExpand(productionOrderId: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(productionOrderId)) next.delete(productionOrderId);
      else next.add(productionOrderId);
      return next;
    });
    ensureOperationsLoaded(productionOrderId);
  }

  function handleOpenModal(productionOrderId: string) {
    setModalOrderId(productionOrderId);
    ensureOperationsLoaded(productionOrderId);
  }

  const today = todayIso();

  /** Matches product name OR SKU, case-insensitive substring — shared by table, work-centre board, and status board since all three render from sortedRows. */
  const filteredRows = useMemo(() => {
    if (!rows) return [];
    const q = productSearch.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => (r.productName ?? "").toLowerCase().includes(q) || (r.productSku ?? "").toLowerCase().includes(q));
  }, [rows, productSearch]);

  const sortedRows = useMemo(() => {
    const copy = [...filteredRows];
    copy.sort((a, b) => {
      const cmp = compareNullable(sortValue(a, sortColumn, today), sortValue(b, sortColumn, today));
      return sortDirection === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [filteredRows, sortColumn, sortDirection, today]);

  const summary = rows
    ? {
        open: filteredRows.length,
        late: filteredRows.filter((r) => isLate(r.requiredByDate, r.listStatus, today)).length,
        wipTotal: filteredRows.reduce((sum, r) => sum + (r.wipActualCost ?? 0), 0),
      }
    : null;

  const isPendingStale = Boolean(syncStatus) && (syncStatus?.pendingRunDetail ?? 0) > 0;

  return (
    <>
      <ReportDescription title="Production Tracking">
        Every open Production Order (Advanced Manufacturing) on one instance — which work centre/operation each is
        currently at, actual wastage recorded per stage, and an estimated work-in-progress cost, alongside which
        orders have missed their required-by date. Current stage and wastage come from Cin7&rsquo;s Production Run
        resource (the real, in-progress state), not the static BOM plan — WIP cost is reconstructed from actual
        operation costs recorded so far and may not reconcile exactly to your GL&rsquo;s WIP account.
      </ReportDescription>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="font-medium text-slate-900">Instance</p>
        <div className="mt-3">
          <button
            type="button"
            onClick={handleLoadInstances}
            disabled={isLoadingInstances}
            className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {isLoadingInstances && <Spinner className="mr-1.5" />}
            {isLoadingInstances ? "Loading…" : "Load instances"}
          </button>
          {instancesError && <p className="mt-2 text-sm text-red-600">{instancesError}</p>}
          {instances.length > 0 && (
            <div className="mt-3 flex flex-col gap-1.5">
              {instances.map((inst) => (
                <label key={inst.id} className="flex items-center gap-2 text-base">
                  <input
                    type="radio"
                    name="production-tracking-instance"
                    checked={instanceId === inst.id}
                    onChange={() => handleSelectInstance(inst.id)}
                    disabled={!inst.active}
                    className="h-4 w-4"
                  />
                  {inst.name} {!inst.active && <span className="text-sm text-slate-400">(inactive)</span>}
                </label>
              ))}
            </div>
          )}
        </div>

        {instanceId && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <div>
              {syncStatus && (
                <p className="text-sm text-slate-500">
                  {syncStatus.totalOrders.toLocaleString()} order{syncStatus.totalOrders === 1 ? "" : "s"} synced
                  {syncStatus.pendingRunDetail > 0 &&
                    ` — ${syncStatus.pendingRunDetail.toLocaleString()} still waiting on run detail (rate-limited, catches up a batch every sync run)`}
                </p>
              )}
            </div>
            <div className="flex items-center gap-3">
              {isPendingStale && <StaleBadge label="Catching up" />}
              <button type="button" onClick={handleSync} disabled={isSyncing} className={staleSyncButtonClass(isPendingStale, "sm")}>
                {isSyncing && <Spinner className="mr-1.5" />}
                {isSyncing ? "Syncing…" : "Sync now"}
              </button>
            </div>
          </div>
        )}
        {syncError && <p className="mt-2 text-sm text-red-600">{syncError}</p>}
        {loadError && <p className="mt-2 text-sm text-red-600">{loadError}</p>}
      </section>

      {isLoadingRows && (
        <p className="mt-6 text-sm text-slate-500">
          <Spinner className="mr-1.5" />
          Loading…
        </p>
      )}

      {rows && !isLoadingRows && (
        <section className="mt-6 flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4">
            <div>
              <p className="font-medium text-slate-900">
                {summary?.open ?? 0} order{summary?.open === 1 ? "" : "s"} shown
                {summary && summary.late > 0 && <span className="ml-2 text-rose-700">· {summary.late} late</span>}
              </p>
              <p className="mt-1 text-sm text-slate-500">Estimated WIP cost: {money(summary?.wipTotal ?? 0)}</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="text"
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                placeholder="Search product name…"
                className="rounded-full border border-slate-300 px-3 py-1.5 text-sm text-slate-700 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none"
              />
              {viewMode === "table" && (
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={includeCompleted} onChange={handleToggleIncludeCompleted} className="h-4 w-4" />
                  Include completed/voided orders
                </label>
              )}
              <div className="flex gap-1.5">
                {VIEW_MODE_TABS.map((tab) => (
                  <button
                    key={tab.value}
                    type="button"
                    onClick={() => setViewMode(tab.value)}
                    className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                      viewMode === tab.value ? "bg-indigo-600 text-white" : "border border-slate-300 text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {viewMode === "status" && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 text-sm">
              <span className="font-medium text-slate-700">Columns:</span>
              {PRODUCTION_STATUS_ORDER.map((status) => (
                <label key={status} className="flex items-center gap-1.5 text-slate-600">
                  <input type="checkbox" checked={!hiddenStatuses.has(status)} onChange={() => toggleStatusColumn(status)} className="h-4 w-4" />
                  {status}
                </label>
              ))}
            </div>
          )}

          {rows.length === 0 ? (
            <p className="text-base text-slate-500">
              {includeCompleted ? "No production orders on this instance yet." : "No open production orders right now — every order is completed or voided."}
            </p>
          ) : sortedRows.length === 0 ? (
            <p className="text-base text-slate-500">No orders match &ldquo;{productSearch}&rdquo;.</p>
          ) : viewMode === "board" ? (
            <BoardView columns={groupByWorkCentre(sortedRows)} today={today} onOpenDetail={handleOpenModal} />
          ) : viewMode === "status" ? (
            <BoardView columns={groupByStatus(sortedRows, hiddenStatuses)} today={today} onOpenDetail={handleOpenModal} />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-left text-sm text-slate-700">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                    <th className="w-8 px-2 py-2"></th>
                    <SortHeader label="Order #" column="orderNumber" thClassName="px-4 py-2" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader label="Product" column="product" thClassName="px-4 py-2" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader
                      label="Current Stage"
                      column="currentOperation"
                      thClassName="px-4 py-2"
                      sortColumn={sortColumn}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                    />
                    <SortHeader label="Status" column="listStatus" thClassName="px-4 py-2" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader
                      label="Required By"
                      column="requiredByDate"
                      thClassName="px-4 py-2"
                      sortColumn={sortColumn}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                    />
                    <SortHeader
                      label="Days Late"
                      column="daysLate"
                      align="right"
                      thClassName="px-4 py-2"
                      sortColumn={sortColumn}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                    />
                    <SortHeader
                      label="WIP Cost"
                      column="wipActualCost"
                      align="right"
                      thClassName="px-4 py-2"
                      sortColumn={sortColumn}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                    />
                    <SortHeader
                      label="Component Wastage"
                      column="totalWastage"
                      align="right"
                      thClassName="px-4 py-2"
                      sortColumn={sortColumn}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                    />
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row) => {
                    const late = isLate(row.requiredByDate, row.listStatus, today);
                    const days = daysLate(row.requiredByDate, today);
                    const isExpanded = expandedIds.has(row.productionOrderId);
                    const shortfall = hasInputShortfall(row);
                    const overproduction = hasInputOverproduction(row);
                    return (
                      <Fragment key={row.productionOrderId}>
                        <tr
                          onClick={() => handleToggleExpand(row.productionOrderId)}
                          className={`cursor-pointer border-b last:border-0 ${
                            shortfall
                              ? "border-red-200 bg-red-50 hover:bg-red-100"
                              : overproduction
                                ? "border-amber-200 bg-amber-50 hover:bg-amber-100"
                                : "border-slate-100 hover:bg-slate-50"
                          }`}
                        >
                          <td className="px-2 py-2 align-top text-center text-slate-400">{isExpanded ? "▾" : "▸"}</td>
                          <td className="px-4 py-2 align-top">{row.orderNumber ?? "—"}</td>
                          <td className="px-4 py-2 align-top">
                            {row.productName ?? "—"} <span className="text-xs text-slate-400">({row.productSku ?? "—"})</span>
                          </td>
                          <td className="px-4 py-2 align-top">
                            {row.currentOperationName ? (
                              <>
                                {row.currentOperationName}
                                {row.currentWorkCenterName && <span className="text-xs text-slate-400"> ({row.currentWorkCenterName})</span>}
                              </>
                            ) : (
                              <span className="text-slate-400">{currentStageFallbackLabel(row)}</span>
                            )}
                            {shortfall && (
                              <div className="text-xs font-semibold text-red-700">
                                ⚠ Short input: {qty(row.currentInputActualQty ?? 0)} of {qty(row.currentInputExpectedQty ?? 0)} expected
                              </div>
                            )}
                            {overproduction && (
                              <div className="text-xs font-semibold text-amber-700">
                                ▲ Over-received: {qty(row.currentInputActualQty ?? 0)} of {qty(row.currentInputExpectedQty ?? 0)} expected
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-2 align-top">{row.listStatus ?? "—"}</td>
                          <td className="px-4 py-2 align-top">{dateOnly(row.requiredByDate)}</td>
                          <td className="px-4 py-2 align-top text-right">
                            {late ? (
                              <span className="rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-semibold text-rose-700">{days}d late</span>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="px-4 py-2 align-top text-right">{row.wipActualCost ? money(row.wipActualCost) : "—"}</td>
                          <td className="px-4 py-2 align-top text-right">{row.totalWastage ? qty(row.totalWastage) : "—"}</td>
                        </tr>
                        {isExpanded && (
                          <tr className="border-b border-slate-100 bg-slate-50 last:border-0">
                            <td colSpan={8}>
                              <ProductionOrderDetailPanel
                                operations={operationsById[row.productionOrderId]}
                                isLoading={loadingDetailIds.has(row.productionOrderId)}
                                error={detailErrors[row.productionOrderId]}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {modalOrderId &&
        (() => {
          const modalRow = rows?.find((r) => r.productionOrderId === modalOrderId);
          if (!modalRow) return null;
          return (
            <ProductionOrderDetailModal
              row={modalRow}
              operations={operationsById[modalOrderId]}
              isLoading={loadingDetailIds.has(modalOrderId)}
              error={detailErrors[modalOrderId]}
              onClose={() => setModalOrderId(null)}
            />
          );
        })()}
    </>
  );
}
