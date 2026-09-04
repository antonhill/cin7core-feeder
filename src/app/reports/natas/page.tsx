"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { loadNatasFilterOptionsAction, loadNatasReportAction } from "./actions";
import { loadSalesSyncStatusAction, triggerSalesSyncAction, exportReportXlsxAction } from "../actions";
import type { SalesSyncStatus } from "@/reports/query";
import type { NatasFilterOptions } from "@/reports/natas-query";
import type { AggregatedNataRow, UnmappedItem } from "@/reports/natas-report";
import { buildNatasReportSheet } from "@/reports/natas-export";
import { downloadBase64File } from "@/reports/download-base64-file";
import { StaleBadge, staleSyncButtonClass } from "../sync-staleness";
import { Spinner } from "@/app/Spinner";
import { ReportDescription } from "../ReportDescription";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Checkbox } from "@/components/ui/Checkbox";
import { Alert } from "@/components/ui/Alert";
import { EmptyState } from "@/components/ui/EmptyState";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/Table";

function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(2)}%`;
}

interface DisplayRow extends AggregatedNataRow {
  /** Profit per individual nata — display-only, derived here rather than in natas-report.ts since it's a trivial ratio of two already-computed fields. */
  profitPerNata: number | null;
}

function toDisplayRow(row: AggregatedNataRow): DisplayRow {
  return { ...row, profitPerNata: row.individualNatas > 0 ? row.profit / row.individualNatas : null };
}

function sumRows(rows: AggregatedNataRow[]) {
  return rows.reduce(
    (acc, r) => ({
      individualNatas: acc.individualNatas + r.individualNatas,
      revenueExVat: acc.revenueExVat + r.revenueExVat,
      fullCogs: acc.fullCogs + r.fullCogs,
      natCogs: acc.natCogs + r.natCogs,
      packagingCost: acc.packagingCost + r.packagingCost,
      profit: acc.profit + r.profit,
    }),
    { individualNatas: 0, revenueExVat: 0, fullCogs: 0, natCogs: 0, packagingCost: 0, profit: 0 }
  );
}

type Totals = ReturnType<typeof sumRows>;

/**
 * Every column is independently toggleable via checkbox (this is purely a
 * display-layer concern — it doesn't affect what data was fetched, so
 * toggling never needs to re-run the report). All checked by default —
 * Anton (2026-07-13) removed the earlier "net of packaging" duplicate
 * profit/margin view in favor of a single COGS breakdown (Nata COGS +
 * Packaging COGS = full COGS, with each shown as a % of the total).
 */
const COLUMNS: {
  key: string;
  label: string;
  defaultVisible: boolean;
  render: (row: DisplayRow) => React.ReactNode;
  renderTotal: (totals: Totals) => React.ReactNode;
}[] = [
  { key: "month", label: "Month", defaultVisible: true, render: (r) => r.month, renderTotal: () => "Total" },
  { key: "location", label: "Location", defaultVisible: true, render: (r) => r.location, renderTotal: () => "" },
  { key: "nataType", label: "Nata Type", defaultVisible: true, render: (r) => r.nataType, renderTotal: () => "" },
  {
    key: "individualNatas",
    label: "Individual Natas",
    defaultVisible: true,
    render: (r) => r.individualNatas.toLocaleString(),
    renderTotal: (t) => t.individualNatas.toLocaleString(),
  },
  {
    key: "revenueExVat",
    label: "Revenue (ex VAT)",
    defaultVisible: true,
    render: (r) => money(r.revenueExVat),
    renderTotal: (t) => money(t.revenueExVat),
  },
  { key: "fullCogs", label: "COGS", defaultVisible: true, render: (r) => money(r.fullCogs), renderTotal: (t) => money(t.fullCogs) },
  {
    key: "natCogs",
    label: "Nata COGS",
    defaultVisible: true,
    render: (r) => money(r.natCogs),
    renderTotal: (t) => money(t.natCogs),
  },
  {
    key: "natCogsPercent",
    label: "Nata COGS %",
    defaultVisible: true,
    render: (r) => percent(r.natCogsPercent),
    renderTotal: (t) => percent(t.fullCogs > 0 ? (t.natCogs / t.fullCogs) * 100 : null),
  },
  {
    key: "packagingCost",
    label: "Packaging COGS",
    defaultVisible: true,
    render: (r) => money(r.packagingCost),
    renderTotal: (t) => money(t.packagingCost),
  },
  {
    key: "packagingCostPercent",
    label: "Packaging COGS %",
    defaultVisible: true,
    render: (r) => percent(r.packagingCostPercent),
    renderTotal: (t) => percent(t.fullCogs > 0 ? (t.packagingCost / t.fullCogs) * 100 : null),
  },
  { key: "profit", label: "Profit", defaultVisible: true, render: (r) => money(r.profit), renderTotal: (t) => money(t.profit) },
  {
    key: "profitPerNata",
    label: "Unit Profit",
    defaultVisible: true,
    render: (r) => money(r.profitPerNata),
    renderTotal: (t) => money(t.individualNatas > 0 ? t.profit / t.individualNatas : null),
  },
  {
    key: "marginPercent",
    label: "Margin %",
    defaultVisible: true,
    render: (r) => percent(r.marginPercent),
    renderTotal: (t) => percent(t.revenueExVat > 0 ? (t.profit / t.revenueExVat) * 100 : null),
  },
];

const DEFAULT_VISIBLE_KEYS = new Set(COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key));

export default function NatasReportPage() {
  const [options, setOptions] = useState<NatasFilterOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  const [syncStatus, setSyncStatus] = useState<SalesSyncStatus | null>(null);
  const [isSyncing, startSyncTransition] = useTransition();
  const [syncError, setSyncError] = useState<string | null>(null);
  // Same "stale whenever anything at all is still pending" convention as the Sales report — revenue/COGS accuracy depends on this, not a time-based signal.
  const isSalesStale = Boolean(syncStatus) && (syncStatus?.pendingDetail ?? 0) > 0;

  const [instanceIds, setInstanceIds] = useState<string[]>([]);
  const [location, setLocation] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [rows, setRows] = useState<AggregatedNataRow[] | null>(null);
  const [unmapped, setUnmapped] = useState<UnmappedItem[]>([]);
  const [reportError, setReportError] = useState<string | null>(null);
  const [isRunning, startRunTransition] = useTransition();

  const [isExporting, startExportTransition] = useTransition();
  const [exportError, setExportError] = useState<string | null>(null);

  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(DEFAULT_VISIBLE_KEYS);

  function refreshSyncStatus() {
    loadSalesSyncStatusAction().then((result) => {
      if (result.ok) setSyncStatus(result.data ?? null);
    });
  }

  useEffect(() => {
    loadNatasFilterOptionsAction().then((result) => {
      if (!result.ok) {
        setOptionsError(result.error ?? "Unknown error");
        return;
      }
      setOptions(result.data ?? null);
    });
    refreshSyncStatus();
  }, []);

  function toggleInstance(id: string) {
    setInstanceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleColumn(key: string) {
    setVisibleKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function handleSync() {
    setSyncError(null);
    startSyncTransition(async () => {
      const result = await triggerSalesSyncAction();
      if (!result.ok) {
        setSyncError(result.error ?? "Unknown error");
        return;
      }
      refreshSyncStatus();
    });
  }

  function handleRunReport() {
    setReportError(null);
    startRunTransition(async () => {
      const result = await loadNatasReportAction({
        instanceIds: instanceIds.length ? instanceIds : undefined,
        location: location || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      });
      if (!result.ok) {
        setReportError(result.error ?? "Unknown error");
        return;
      }
      setRows(result.data?.rows ?? []);
      setUnmapped(result.data?.unmapped ?? []);
    });
  }

  function handleExport() {
    if (!rows) return;
    setExportError(null);
    startExportTransition(async () => {
      const result = await exportReportXlsxAction(buildNatasReportSheet(rows), "Natas Sold");
      if (!result.ok || !result.data) {
        setExportError(result.error ?? "Unknown error");
        return;
      }
      downloadBase64File(result.data, "natas-sold.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    });
  }

  const displayRows = useMemo(() => (rows ?? []).map(toDisplayRow), [rows]);
  const totals = rows ? sumRows(rows) : null;
  const visibleColumns = COLUMNS.filter((c) => visibleKeys.has(c.key));

  return (
    <>
      <ReportDescription title="Natas Sold &amp; Packaging COGS">
        Individual natas sold per Nata Type, Location, and Month — normalizing both predefined packs (e.g. &ldquo;Lisbon
        Classic 6&rdquo;, extrapolated to 6 individual natas from its own Assembly BOM) and mixed packs (individual
        singles combined with a zero-cost packaging line in the same sale). COGS (Cin7&rsquo;s own average-cost basis)
        splits into Nata COGS (ingredients/casing) and Packaging COGS (Packaging + Label + Topping, amortized across
        however many natas it packaged), each shown as a % of the total. Revenue is ex VAT (this org records sales
        VAT-inclusive; 15% is backed out here) — Profit and Margin % are computed against that ex-VAT figure, not the
        invoiced amount.
      </ReportDescription>

      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-base font-semibold text-slate-900">Sales data</p>
            {syncStatus && (
              <p className="mt-1 text-sm text-slate-500">
                {syncStatus.totalSales} sale{syncStatus.totalSales === 1 ? "" : "s"} synced
                {syncStatus.pendingDetail > 0 &&
                  ` — ${syncStatus.pendingDetail} still waiting on line-item detail (rate-limited, catches up a batch every sync run)`}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isSalesStale && <StaleBadge label="Behind — sync recommended" />}
            <button type="button" onClick={handleSync} disabled={isSyncing} className={staleSyncButtonClass(isSalesStale, "sm")}>
              {isSyncing && <Spinner className="mr-1.5" />}
              {isSyncing ? "Syncing…" : "Sync sales now"}
            </button>
          </div>
        </div>
        {syncError && (
          <div className="mt-2">
            <Alert tone="danger">{syncError}</Alert>
          </div>
        )}
      </Panel>

      <Panel className="mt-6">
        <PanelTitle>Filters</PanelTitle>
        {optionsError && (
          <div className="mt-2">
            <Alert tone="danger">{optionsError}</Alert>
          </div>
        )}
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <span className="text-sm font-medium text-slate-700">Instance(s)</span>
            <div className="mt-2 flex flex-col gap-1.5">
              {(options?.instances ?? []).map((inst) => (
                <Checkbox key={inst.id} label={inst.name} checked={instanceIds.includes(inst.id)} onChange={() => toggleInstance(inst.id)} />
              ))}
              {options && options.instances.length === 0 && <p className="text-sm text-slate-400">No instances connected.</p>}
            </div>
          </div>

          <Select label="Location" value={location} onChange={(e) => setLocation(e.target.value)}>
            <option value="">All locations</option>
            {(options?.locations ?? []).map((loc) => (
              <option key={loc} value={loc}>
                {loc}
              </option>
            ))}
          </Select>

          <div className="grid grid-cols-2 gap-3">
            <Input type="date" label="From" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            <Input type="date" label="To" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
        </div>

        <div className="mt-5">
          <Button onClick={handleRunReport} loading={isRunning}>
            {isRunning ? "Running…" : "Run report"}
          </Button>
        </div>

        {reportError && (
          <div className="mt-4">
            <Alert tone="danger">{reportError}</Alert>
          </div>
        )}
      </Panel>

      {unmapped.length > 0 && (
        <div className="mt-6">
          <Alert tone="warning">
            <p className="font-medium">
              {unmapped.length} SKU{unmapped.length === 1 ? "" : "s"} not recognized as a known Nata Type
            </p>
            <p className="mt-1">
              These &ldquo;Nata&rdquo;-category sale lines didn&rsquo;t match a known flavor prefix, so they&rsquo;re
              excluded from the totals below rather than being miscounted. Add a new rule to `NATA_TYPE_RULES` in{" "}
              <code>src/reports/natas-report.ts</code> if this is a real new flavor.
            </p>
            <ul className="mt-3 flex flex-col gap-1">
              {unmapped.map((u) => (
                <li key={u.sku}>
                  {u.name ?? u.sku} ({u.sku}) — qty {u.quantity}
                </li>
              ))}
            </ul>
          </Alert>
        </div>
      )}

      {rows && (
        <Panel className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-base font-semibold text-slate-900">
              {rows.length} row{rows.length === 1 ? "" : "s"}
            </p>
            {rows.length > 0 && (
              <Button variant="secondary" size="sm" onClick={handleExport} loading={isExporting}>
                {isExporting ? "Exporting…" : "Export to Excel"}
              </Button>
            )}
          </div>
          {exportError && (
            <div className="mt-2">
              <Alert tone="danger">{exportError}</Alert>
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 border-b border-slate-100 pb-4">
            {COLUMNS.map((col) => (
              <Checkbox key={col.key} label={col.label} checked={visibleKeys.has(col.key)} onChange={() => toggleColumn(col.key)} />
            ))}
          </div>

          {rows.length === 0 && <EmptyState title="No matching Nata sales" />}

          {rows.length > 0 && visibleColumns.length > 0 && (
            <div className="mt-4">
              <Table>
                <THead>
                  <tr>
                    {visibleColumns.map((col) => (
                      <TH key={col.key} align={col.key === "month" || col.key === "location" || col.key === "nataType" ? "left" : "right"}>
                        {col.label}
                      </TH>
                    ))}
                  </tr>
                </THead>
                <TBody>
                  {displayRows.map((row) => (
                    <TR key={`${row.month}|${row.location}|${row.nataType}`}>
                      {visibleColumns.map((col) => (
                        <TD
                          key={col.key}
                          align={col.key === "month" || col.key === "location" || col.key === "nataType" ? "left" : "right"}
                          numeric={col.key !== "month" && col.key !== "location" && col.key !== "nataType"}
                        >
                          {col.render(row)}
                        </TD>
                      ))}
                    </TR>
                  ))}
                </TBody>
                {totals && (
                  <tfoot>
                    <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold text-slate-700">
                      {visibleColumns.map((col) => (
                        <td
                          key={col.key}
                          className={`px-3 py-2 ${col.key === "month" || col.key === "location" || col.key === "nataType" ? "text-left" : "text-right tabular-nums"}`}
                        >
                          {col.renderTotal(totals)}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                )}
              </Table>
            </div>
          )}
          {rows.length > 0 && visibleColumns.length === 0 && (
            <p className="mt-4 text-sm text-slate-400">No columns selected — check at least one above.</p>
          )}
        </Panel>
      )}
    </>
  );
}
