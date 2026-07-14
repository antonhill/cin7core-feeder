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
import { isLate, daysLate } from "@/reports/production-tracking/build";
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
    <div className="px-4 py-4">
      <table className="w-full text-left text-sm text-slate-700">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-slate-400">
            <th className="py-1 pr-4 font-medium">Operation</th>
            <th className="py-1 pr-4 font-medium">Work Centre</th>
            <th className="py-1 pr-4 font-medium">Status</th>
            <th className="py-1 pr-4 text-right font-medium">Planned Time</th>
            <th className="py-1 pr-4 text-right font-medium">Actual Time</th>
            <th className="py-1 pr-4 text-right font-medium">Wastage</th>
            <th className="py-1 pr-4 text-right font-medium">Actual Cost</th>
          </tr>
        </thead>
        <tbody>
          {operations.map((op) => (
            <tr key={op.operationOrder} className="border-t border-slate-100">
              <td className="py-1 pr-4">{op.operationName ?? "—"}</td>
              <td className="py-1 pr-4">{op.workCenterName ?? "—"}</td>
              <td className="py-1 pr-4">{op.status ?? "—"}</td>
              <td className="py-1 pr-4 text-right">{op.plannedTime ?? "—"}</td>
              <td className="py-1 pr-4 text-right">{op.actualTime ?? "—"}</td>
              <td className="py-1 pr-4 text-right">{op.wastageQty ? qty(op.wastageQty) : "—"}</td>
              <td className="py-1 pr-4 text-right">{op.actualResourceCost ? money(op.actualResourceCost) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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

  function handleToggleExpand(productionOrderId: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(productionOrderId)) next.delete(productionOrderId);
      else next.add(productionOrderId);
      return next;
    });

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

  const today = todayIso();

  const sortedRows = useMemo(() => {
    if (!rows) return [];
    const copy = [...rows];
    copy.sort((a, b) => {
      const cmp = compareNullable(sortValue(a, sortColumn, today), sortValue(b, sortColumn, today));
      return sortDirection === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortColumn, sortDirection, today]);

  const summary = rows
    ? {
        open: rows.length,
        late: rows.filter((r) => isLate(r.requiredByDate, r.listStatus, today)).length,
        wipTotal: rows.reduce((sum, r) => sum + (r.wipActualCost ?? 0), 0),
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
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={includeCompleted} onChange={handleToggleIncludeCompleted} className="h-4 w-4" />
              Include completed/voided orders
            </label>
          </div>

          {rows.length === 0 ? (
            <p className="text-base text-slate-500">
              {includeCompleted ? "No production orders on this instance yet." : "No open production orders right now — every order is completed or voided."}
            </p>
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
                      label="Wastage"
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
                    return (
                      <Fragment key={row.productionOrderId}>
                        <tr
                          onClick={() => handleToggleExpand(row.productionOrderId)}
                          className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
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
                              <span className="text-slate-400">not synced yet</span>
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
    </>
  );
}
