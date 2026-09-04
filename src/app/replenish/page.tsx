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
  type CreateTransfersResult,
} from "./actions";
import { resolveReorderThresholds, buildReplenishLines, type ReplenishLine } from "@/reports/replenish/build";
import type { ProductAvailabilitySyncStatus } from "@/reports/query";
import { SNAPSHOT_STALE_HOURS, hoursSince, StaleBadge, staleSyncButtonClass } from "@/app/reports/sync-staleness";
import { Spinner } from "@/app/Spinner";
import { PageLoadingIndicator } from "@/app/PageLoadingIndicator";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Panel } from "@/components/ui/Panel";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/Table";

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
  const [transferResult, setTransferResult] = useState<CreateTransfersResult | null>(null);

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
    setTransferResult(null);
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
    setTransferResult(null);
    startCreateTransition(async () => {
      const result = await createReplenishTransfersAction(instanceId, sourceLocation, selectedLines);
      // A partial failure still returns whichever transfers genuinely got
      // created (result.data) alongside ok:false — show that, not just the
      // error, same convention as Supplier Planner's PO creation.
      if (result.data) setTransferResult(result.data);
      else setCreateError(result.error ?? "Unknown error");
    });
  }

  const writeDisabled = isCreating || !canWrite;

  return (
    <>
      <PageLoadingIndicator show={isLoadingPreview} label="Building replenish list…" />

      <Panel className="mt-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="text-sm font-medium text-slate-700">Instance</span>
            <div className="mt-2">
              <InstancePicker {...picker} onChange={picker.setInstanceId} />
            </div>
            {instanceId && (
              <div className="mt-2 flex items-center gap-3">
                <p className="w-72 text-xs text-slate-500">
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
            {syncStatusError && <p className="mt-2 text-xs text-danger">{syncStatusError}</p>}
            {syncError && <p className="mt-2 text-xs text-danger">{syncError}</p>}
          </div>
          <Button onClick={handlePreview} disabled={!instanceId} loading={isLoadingPreview}>
            {isLoadingPreview ? "Building…" : "Build replenish list"}
          </Button>
        </div>
        {previewError && (
          <div className="mt-3">
            <Alert tone="danger">{previewError}</Alert>
          </div>
        )}
      </Panel>

      {previewData && (
        <Panel className="mt-6">
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-100 pb-4">
            <div>
              <Select label="Source location" value={sourceLocation} onChange={(e) => setSourceLocation(e.target.value)} className="w-56">
                <option value="">Choose a source location…</option>
                {previewData.locations.map((loc) => (
                  <option key={loc} value={loc}>
                    {loc}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-xs text-slate-500">Stock is pulled from here to top up every other location below its reorder point.</p>
            </div>
            {lines && lines.length > 0 && (
              <Button
                onClick={handleCreate}
                disabled={writeDisabled || selectedLines.length === 0}
                title={!canWrite ? "Writing to Cin7 is disabled on your current plan." : undefined}
                loading={isCreating}
              >
                {isCreating
                  ? "Creating…"
                  : selectedLines.length === 0
                    ? "Create Transfers"
                    : `Create ${new Set(selectedLines.map((l) => l.toLocation)).size} Transfer${new Set(selectedLines.map((l) => l.toLocation)).size === 1 ? "" : "s"} (${selectedLines.length} line${selectedLines.length === 1 ? "" : "s"})`}
              </Button>
            )}
          </div>

          {previewData.skusWithNoThreshold.length > 0 && (
            <div className="mt-4">
              <Alert tone="warning">
                {previewData.skusWithNoThreshold.length} product{previewData.skusWithNoThreshold.length === 1 ? " has" : "s have"} no reorder
                minimum set anywhere (location-specific or global) on this instance, so they&rsquo;re never proposed here — set one in Cin7 first.
              </Alert>
            </div>
          )}

          {createError && (
            <div className="mt-3">
              <Alert tone="danger">{createError}</Alert>
            </div>
          )}
          {transferResult &&
            (transferResult.created.length > 0 || transferResult.failed.length > 0 || (transferResult.deduplicated?.length ?? 0) > 0) && (
              <div className="mt-3 flex flex-col gap-2">
                {(transferResult.deduplicated?.length ?? 0) > 0 && (
                  <Alert tone="warning">
                    {transferResult.deduplicated!.length} transfer{transferResult.deduplicated!.length === 1 ? " was" : "s were"} already created
                    moments ago for the same lines — returned the existing
                    {transferResult.deduplicated!.length === 1 ? " one" : " ones"} instead of a duplicate:
                    <ul className="mt-1 list-disc pl-5">
                      {transferResult.deduplicated!.map((t) => (
                        <li key={`dedup-${t.taskId}`}>
                          <strong>{t.number}</strong> → {t.toLocation}
                        </li>
                      ))}
                    </ul>
                  </Alert>
                )}
                {transferResult.created.length > 0 && (
                  <Alert tone="success">
                    Created {transferResult.created.length} draft transfer{transferResult.created.length === 1 ? "" : "s"} in Cin7 — review and
                    complete
                    {transferResult.created.length === 1 ? " it" : " them"} there:
                    <ul className="mt-1 list-disc pl-5">
                      {transferResult.created.map((t) => (
                        <li key={t.taskId}>
                          <strong>{t.number}</strong> → {t.toLocation} ({t.skus.length} SKU{t.skus.length === 1 ? "" : "s"}, {t.status})
                        </li>
                      ))}
                    </ul>
                  </Alert>
                )}
                {transferResult.failed.length > 0 && (
                  <Alert tone="danger">
                    {transferResult.failed.length} transfer{transferResult.failed.length === 1 ? "" : "s"} failed to create:
                    <ul className="mt-1 list-disc pl-5">
                      {transferResult.failed.map((f) => (
                        <li key={f.toLocation}>
                          {f.toLocation}: {f.error}
                        </li>
                      ))}
                    </ul>
                  </Alert>
                )}
              </div>
            )}

          {!sourceLocation && <p className="mt-4 text-sm text-slate-500">Choose a source location to see proposed transfers.</p>}

          {sourceLocation && lines && lines.length === 0 && (
            <p className="mt-4 text-sm text-slate-500">Every other location is at or above its reorder point — nothing to replenish.</p>
          )}

          {sourceLocation && lines && lines.length > 0 && (
            <div className="mt-4">
              <Table>
                <THead>
                  <tr>
                    <TH>
                      <input
                        type="checkbox"
                        aria-label="Select all lines"
                        checked={excludedLineKeys.size === 0}
                        ref={(el) => {
                          if (el) el.indeterminate = excludedLineKeys.size > 0 && excludedLineKeys.size < lines.length;
                        }}
                        onChange={toggleAllLines}
                        className="h-4 w-4 rounded border-slate-300 text-primary"
                      />
                    </TH>
                    <TH>Product</TH>
                    <TH>To Location</TH>
                    <TH align="right">Quantity</TH>
                    <TH></TH>
                  </tr>
                </THead>
                <TBody>
                  {lines.map((line: ReplenishLine) => {
                    const key = lineKey(line);
                    const checked = !excludedLineKeys.has(key);
                    return (
                      <TR key={key} className={checked ? "" : "opacity-50"}>
                        <TD>
                          <input
                            type="checkbox"
                            aria-label={`Select ${line.productName ?? line.productSku}`}
                            checked={checked}
                            onChange={() => toggleLine(key)}
                            className="h-4 w-4 rounded border-slate-300 text-primary"
                          />
                        </TD>
                        <TD>
                          <div className="font-medium text-slate-900">{line.productName ?? line.productSku}</div>
                          <div className="font-mono text-xs text-slate-500">{line.productSku}</div>
                        </TD>
                        <TD>{line.toLocation}</TD>
                        <TD align="right" numeric className="font-medium">
                          {qty(line.quantity)}
                        </TD>
                        <TD>
                          {line.capped && <Badge tone="warning">capped — source only had enough for {qty(line.quantity)}</Badge>}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
          )}
        </Panel>
      )}
    </>
  );
}
