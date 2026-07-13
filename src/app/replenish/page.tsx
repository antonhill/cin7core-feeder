"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { listInstancesForPicker, type InstancePickerItem } from "@/actions/instances";
import { getBillingStatusAction } from "@/actions/billing";
import {
  loadReplenishPreviewAction,
  loadReplenishSyncStatusAction,
  triggerReplenishSyncAction,
  createReplenishTransfersAction,
  type ReplenishPreviewData,
  type CreatedTransfer,
} from "./actions";
import { resolveReorderThresholds, buildReplenishLines, type ReplenishLine } from "@/reports/replenish/build";
import type { ProductAvailabilitySyncStatus } from "@/reports/query";
import { SNAPSHOT_STALE_HOURS, hoursSince, StaleBadge, staleSyncButtonClass } from "@/app/reports/sync-staleness";
import { ModuleHeader } from "@/app/ModuleHeader";
import { REPLENISH_MODULE } from "@/app/module-nav";
import { Spinner } from "@/app/Spinner";
import { PageLoadingIndicator } from "@/app/PageLoadingIndicator";

function qty(value: number): string {
  return value.toLocaleString();
}

export default function ReplenishPage() {
  const [instances, setInstances] = useState<InstancePickerItem[]>([]);
  const [instancesError, setInstancesError] = useState<string | null>(null);
  const [isLoadingInstances, startLoadTransition] = useTransition();
  const [instanceId, setInstanceId] = useState("");

  const [syncStatus, setSyncStatus] = useState<ProductAvailabilitySyncStatus | null>(null);
  const [syncStatusError, setSyncStatusError] = useState<string | null>(null);
  const [isSyncing, startSyncTransition] = useTransition();
  const [syncError, setSyncError] = useState<string | null>(null);
  const isStale = Boolean(syncStatus) && (!syncStatus?.lastSyncedAt || hoursSince(syncStatus.lastSyncedAt) > SNAPSHOT_STALE_HOURS);

  const [previewData, setPreviewData] = useState<ReplenishPreviewData | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isLoadingPreview, startPreviewTransition] = useTransition();

  const [sourceLocation, setSourceLocation] = useState("");

  const [canWrite, setCanWrite] = useState(true);
  const [, startBillingTransition] = useTransition();
  useEffect(() => {
    startBillingTransition(async () => {
      const res = await getBillingStatusAction();
      if (res.ok && res.data) setCanWrite(res.data.canWrite);
    });
  }, []);

  const [isCreating, startCreateTransition] = useTransition();
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdTransfers, setCreatedTransfers] = useState<CreatedTransfer[] | null>(null);

  // Recomputed instantly whenever the source location changes — no server
  // round trip, since resolveReorderThresholds/buildReplenishLines are pure
  // functions and the preview action already handed over every raw
  // ingredient they need.
  const lines = useMemo(() => {
    if (!previewData || !sourceLocation) return null;
    const { thresholds } = resolveReorderThresholds(previewData.availabilityRows, previewData.products);
    return buildReplenishLines(previewData.availabilityRows, thresholds, sourceLocation);
  }, [previewData, sourceLocation]);

  function refreshSyncStatus(forInstanceId: string) {
    setSyncStatusError(null);
    loadReplenishSyncStatusAction(forInstanceId).then((result) => {
      if (!result.ok) {
        setSyncStatusError(result.error ?? "Unknown error");
        return;
      }
      setSyncStatus(result.data ?? null);
    });
  }

  useEffect(() => {
    if (!instanceId) return;
    loadReplenishSyncStatusAction(instanceId).then((result) => {
      if (!result.ok) {
        setSyncStatusError(result.error ?? "Unknown error");
        return;
      }
      setSyncStatus(result.data ?? null);
    });
  }, [instanceId]);

  function handleLoadInstances() {
    setInstancesError(null);
    startLoadTransition(async () => {
      const res = await listInstancesForPicker();
      if (!res.ok) {
        setInstancesError(res.error ?? "Unknown error");
        return;
      }
      setInstances(res.instances ?? []);
      if (res.instances?.length === 1) setInstanceId(res.instances[0].id);
    });
  }

  function handleSync() {
    if (!instanceId) return;
    setSyncError(null);
    startSyncTransition(async () => {
      const result = await triggerReplenishSyncAction(instanceId);
      if (!result.ok) {
        setSyncError(result.error ?? "Unknown error");
        return;
      }
      refreshSyncStatus(instanceId);
    });
  }

  function handlePreview() {
    if (!instanceId) return;
    setPreviewError(null);
    setSourceLocation("");
    setCreatedTransfers(null);
    setCreateError(null);
    startPreviewTransition(async () => {
      const result = await loadReplenishPreviewAction(instanceId);
      if (!result.ok) {
        setPreviewError(result.error ?? "Unknown error");
        return;
      }
      setPreviewData(result.data ?? null);
    });
  }

  function handleCreate() {
    if (!instanceId || !sourceLocation || !lines || lines.length === 0) return;
    setCreateError(null);
    setCreatedTransfers(null);
    startCreateTransition(async () => {
      const result = await createReplenishTransfersAction(instanceId, sourceLocation, lines);
      if (!result.ok) {
        setCreateError(result.error ?? "Unknown error");
        return;
      }
      setCreatedTransfers(result.data ?? []);
    });
  }

  const writeDisabled = isCreating || !canWrite;

  return (
    <>
      <ModuleHeader module={REPLENISH_MODULE}>
        Reads each product&rsquo;s stock-on-hand per location (already synced) against its reorder point — a
        location-specific override when Cin7 has one set, otherwise the product&rsquo;s flat/global minimum — and
        proposes Stock Transfers from one chosen source location to top up whichever locations have fallen below it.
        Transfers are created in Cin7 as <strong>DRAFT</strong>, ready for you to review and complete there.
      </ModuleHeader>
      <PageLoadingIndicator show={isLoadingPreview} label="Building replenish list…" />

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="text-sm font-medium text-slate-700">Instance</span>
            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                onClick={handleLoadInstances}
                disabled={isLoadingInstances}
                className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {isLoadingInstances && <Spinner className="mr-1.5" />}
                {isLoadingInstances ? "Loading…" : "Load instances"}
              </button>
              {instances.length > 0 && (
                <select
                  value={instanceId}
                  onChange={(e) => setInstanceId(e.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="">Choose an instance…</option>
                  {instances.map((inst) => (
                    <option key={inst.id} value={inst.id}>
                      {inst.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {instancesError && <p className="mt-2 text-sm text-red-600">{instancesError}</p>}
            {instanceId && (
              <div className="mt-2 flex items-center gap-3">
                <p className="w-72 text-xs text-slate-400">
                  Stock levels
                  {syncStatus?.lastSyncedAt ? ` — last synced ${new Date(syncStatus.lastSyncedAt).toLocaleString()}` : syncStatus ? " — never synced yet" : ""}.
                </p>
                {isStale && <StaleBadge label="Stale — sync recommended" />}
                <button type="button" onClick={handleSync} disabled={isSyncing} className={staleSyncButtonClass(isStale)}>
                  {isSyncing && <Spinner className="mr-1.5" />}
                  {isSyncing ? "Syncing…" : "Sync stock levels now"}
                </button>
              </div>
            )}
            {syncStatusError && <p className="mt-2 text-xs text-red-600">{syncStatusError}</p>}
            {syncError && <p className="mt-2 text-xs text-red-600">{syncError}</p>}
          </div>
          <button
            type="button"
            onClick={handlePreview}
            disabled={isLoadingPreview || !instanceId}
            className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {isLoadingPreview && <Spinner className="mr-1.5" />}
            {isLoadingPreview ? "Building…" : "Build replenish list"}
          </button>
        </div>
        {previewError && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{previewError}</p>}
      </section>

      {previewData && (
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-100 pb-4">
            <div>
              <span className="text-sm font-medium text-slate-700">Source location</span>
              <p className="mt-1 text-xs text-slate-400">Stock is pulled from here to top up every other location below its reorder point.</p>
              <select
                value={sourceLocation}
                onChange={(e) => setSourceLocation(e.target.value)}
                className="mt-2 rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="">Choose a source location…</option>
                {previewData.locations.map((loc) => (
                  <option key={loc} value={loc}>
                    {loc}
                  </option>
                ))}
              </select>
            </div>
            {lines && lines.length > 0 && (
              <button
                type="button"
                onClick={handleCreate}
                disabled={writeDisabled}
                title={!canWrite ? "Writing to Cin7 is disabled on your current plan." : undefined}
                className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {isCreating && <Spinner className="mr-1.5" />}
                {isCreating ? "Creating…" : `Create ${new Set(lines.map((l) => l.toLocation)).size} Transfer${new Set(lines.map((l) => l.toLocation)).size === 1 ? "" : "s"}`}
              </button>
            )}
          </div>

          {previewData.skusWithNoThreshold.length > 0 && (
            <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {previewData.skusWithNoThreshold.length} product{previewData.skusWithNoThreshold.length === 1 ? " has" : "s have"} no reorder
              minimum set anywhere (location-specific or global) on this instance, so they&rsquo;re never proposed here — set one in Cin7 first.
            </p>
          )}

          {createError && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{createError}</p>}
          {createdTransfers && createdTransfers.length > 0 && (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              Created {createdTransfers.length} draft transfer{createdTransfers.length === 1 ? "" : "s"} in Cin7 — review and complete
              {createdTransfers.length === 1 ? " it" : " them"} there:
              <ul className="mt-1 list-disc pl-5">
                {createdTransfers.map((t) => (
                  <li key={t.taskId}>
                    <strong>{t.number}</strong> → {t.toLocation} ({t.skus.length} SKU{t.skus.length === 1 ? "" : "s"}, {t.status})
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!sourceLocation && <p className="mt-4 text-sm text-slate-400">Choose a source location to see proposed transfers.</p>}

          {sourceLocation && lines && lines.length === 0 && (
            <p className="mt-4 text-sm text-slate-400">Every other location is at or above its reorder point — nothing to replenish.</p>
          )}

          {sourceLocation && lines && lines.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 pr-4">Product</th>
                    <th className="py-2 pr-4">To Location</th>
                    <th className="py-2 pr-4 text-right">Quantity</th>
                    <th className="py-2 pr-4"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line: ReplenishLine, i: number) => (
                    <tr key={i} className="border-b border-slate-100">
                      <td className="py-2 pr-4">
                        <div className="font-medium text-slate-900">{line.productName ?? line.productSku}</div>
                        <div className="text-xs text-slate-400">{line.productSku}</div>
                      </td>
                      <td className="py-2 pr-4">{line.toLocation}</td>
                      <td className="py-2 pr-4 text-right font-medium">{qty(line.quantity)}</td>
                      <td className="py-2 pr-4">
                        {line.capped && (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                            capped — source only had enough for {qty(line.quantity)}
                          </span>
                        )}
                      </td>
                    </tr>
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
