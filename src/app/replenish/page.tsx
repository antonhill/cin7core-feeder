"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useInstancePicker } from "@/hooks/useInstancePicker";
import { InstancePicker } from "@/app/InstancePicker";
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
import { Spinner } from "@/app/Spinner";
import { PageLoadingIndicator } from "@/app/PageLoadingIndicator";

function qty(value: number): string {
  return value.toLocaleString();
}

/** Unique per proposed line — matches build.ts's own `${sku}::${location}` threshold-map keying convention. buildReplenishLines only ever emits one line per (sku, destination) pair, so this is stable across re-renders. */
function lineKey(line: ReplenishLine): string {
  return `${line.productSku}::${line.toLocation}`;
}

export default function ReplenishPage() {
  const picker = useInstancePicker();
  const { instanceId } = picker;

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

  // Raw toggle state; ticking a line off excludes it. Not reset on every
  // source-location change — derived below against the currently visible
  // line keys instead (same "drop stale selections rather than resync via
  // effect" pattern as the Data Audit page's IssueTypeSection), so a
  // leftover exclusion from a previous source location can't silently
  // apply to an unrelated line that happens to reuse the same key.
  const [rawExcludedLineKeys, setRawExcludedLineKeys] = useState<Set<string>>(new Set());
  const excludedLineKeys = useMemo(() => {
    if (!lines) return new Set<string>();
    const visibleKeys = new Set(lines.map(lineKey));
    return new Set([...rawExcludedLineKeys].filter((k) => visibleKeys.has(k)));
  }, [rawExcludedLineKeys, lines]);
  const selectedLines = useMemo(() => (lines ? lines.filter((l) => !excludedLineKeys.has(lineKey(l))) : []), [lines, excludedLineKeys]);

  function toggleLine(key: string) {
    setRawExcludedLineKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAllLines() {
    if (!lines) return;
    setRawExcludedLineKeys(excludedLineKeys.size === 0 ? new Set(lines.map(lineKey)) : new Set());
  }

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
    setRawExcludedLineKeys(new Set());
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
    if (!instanceId || !sourceLocation || selectedLines.length === 0) return;
    setCreateError(null);
    setCreatedTransfers(null);
    startCreateTransition(async () => {
      const result = await createReplenishTransfersAction(instanceId, sourceLocation, selectedLines);
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
      <PageLoadingIndicator show={isLoadingPreview} label="Building replenish list…" />

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="text-sm font-medium text-slate-700">Instance</span>
            <div className="mt-2">
              <InstancePicker {...picker} onChange={picker.setInstanceId} />
            </div>
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
                disabled={writeDisabled || selectedLines.length === 0}
                title={!canWrite ? "Writing to Cin7 is disabled on your current plan." : undefined}
                className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {isCreating && <Spinner className="mr-1.5" />}
                {isCreating
                  ? "Creating…"
                  : selectedLines.length === 0
                    ? "Create Transfers"
                    : `Create ${new Set(selectedLines.map((l) => l.toLocation)).size} Transfer${new Set(selectedLines.map((l) => l.toLocation)).size === 1 ? "" : "s"} (${selectedLines.length} line${selectedLines.length === 1 ? "" : "s"})`}
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
                    <th className="py-2 pr-4">
                      <input
                        type="checkbox"
                        checked={excludedLineKeys.size === 0}
                        ref={(el) => {
                          if (el) el.indeterminate = excludedLineKeys.size > 0 && excludedLineKeys.size < lines.length;
                        }}
                        onChange={toggleAllLines}
                        className="h-4 w-4"
                      />
                    </th>
                    <th className="py-2 pr-4">Product</th>
                    <th className="py-2 pr-4">To Location</th>
                    <th className="py-2 pr-4 text-right">Quantity</th>
                    <th className="py-2 pr-4"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line: ReplenishLine) => {
                    const key = lineKey(line);
                    const checked = !excludedLineKeys.has(key);
                    return (
                      <tr key={key} className={`border-b border-slate-100 ${checked ? "" : "opacity-50"}`}>
                        <td className="py-1.5 pr-4">
                          <input type="checkbox" checked={checked} onChange={() => toggleLine(key)} className="h-4 w-4" />
                        </td>
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
