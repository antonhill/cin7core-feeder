"use client";

import { useMemo, useState, useTransition } from "react";
import { runSystemHealthAction } from "./actions";
import { useInstancePicker } from "@/hooks/useInstancePicker";
import { InstancePicker } from "@/app/InstancePicker";
import type { DimensionResult, HealthTone, SystemHealthResult } from "@/health/system-health";
import { ModuleHeader } from "@/app/ModuleHeader";
import { HEALTH_MODULE } from "@/app/module-nav";
import { compareNullable, SortHeader, type SortDirection } from "../reports/sortable-table";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Panel } from "@/components/ui/Panel";

const TONE_STYLES: Record<HealthTone, { card: string; label: string }> = {
  green: { card: "border-success-border bg-success-subtle", label: "Healthy" },
  amber: { card: "border-warning-border bg-warning-subtle", label: "Needs attention" },
  red: { card: "border-danger-border bg-danger-subtle", label: "At risk" },
};

const TONE_BADGE: Record<HealthTone, BadgeTone> = { green: "success", amber: "warning", red: "danger" };

function scoreTone(score: number): HealthTone {
  if (score >= 90) return "green";
  if (score >= 70) return "amber";
  return "red";
}

/** Shows just the date portion of an ISO timestamp; blank input (no deadline/reference date set) stays blank rather than showing "Invalid Date" or "1970-01-01". */
function dateOnly(value: string): string {
  return value ? value.slice(0, 10) : "—";
}

interface Column<T> {
  header: string;
  render: (item: T) => React.ReactNode;
  /** Optional — a plain sortable value for this column, separate from render() since that returns a ReactNode. Columns without one (e.g. a composite multi-part cell) render as a plain, non-clickable header. */
  sortValue?: (item: T) => string | number | null;
}

/** Self-contained sort state per card (not lifted to the page) — the 6 dimension tables are independent, no need to coordinate sort across them. */
function DimensionCard<T>({
  dimension,
  columns,
  footer,
}: {
  dimension: DimensionResult<T>;
  columns: Column<T>[];
  footer?: React.ReactNode;
}) {
  const tone = TONE_STYLES[dimension.tone];

  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  function handleSort(header: string) {
    if (header === sortColumn) setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortColumn(header);
      setSortDirection("asc");
    }
  }

  const sortedItems = useMemo(() => {
    const col = columns.find((c) => c.header === sortColumn);
    if (!col?.sortValue) return dimension.items;
    const sortValue = col.sortValue;
    const copy = [...dimension.items];
    copy.sort((a, b) => {
      const cmp = compareNullable(sortValue(a), sortValue(b));
      return sortDirection === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [dimension.items, columns, sortColumn, sortDirection]);

  return (
    <details className={`rounded-xl border p-4 ${tone.card}`} open={dimension.flaggedCount > 0 && dimension.flaggedCount <= 5}>
      <summary className="flex cursor-pointer items-center justify-between gap-3">
        <span className="font-medium text-slate-900">{dimension.label}</span>
        <span className="shrink-0 tabular-nums">
          <Badge tone={TONE_BADGE[dimension.tone]}>
            {dimension.flaggedCount} / {dimension.totalScanned}
          </Badge>
        </span>
      </summary>

      {dimension.items.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-700">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                {columns.map((col) =>
                  col.sortValue ? (
                    <SortHeader
                      key={col.header}
                      label={col.header}
                      column={col.header}
                      thClassName="py-1.5 pr-4"
                      sortColumn={sortColumn ?? ""}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                    />
                  ) : (
                    <th key={col.header} scope="col" className="py-1.5 pr-4 font-medium">
                      {col.header}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {sortedItems.map((item, i) => (
                <tr key={i} className="border-b border-slate-100 last:border-0">
                  {columns.map((col) => (
                    <td key={col.header} className="py-1.5 pr-4 align-top">
                      {col.render(item)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-2 text-sm text-slate-500">Nothing flagged.</p>
      )}

      {footer && <div className="mt-3">{footer}</div>}
    </details>
  );
}

export default function SystemHealthPage() {
  const picker = useInstancePicker();
  const { instanceId } = picker;

  const [result, setResult] = useState<SystemHealthResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [isScanning, startScanTransition] = useTransition();

  function handleScan() {
    if (!instanceId) return;
    setScanError(null);
    setResult(null);
    startScanTransition(async () => {
      const res = await runSystemHealthAction(instanceId);
      if (!res.ok) {
        setScanError(res.error ?? "Unknown error");
        return;
      }
      setResult(res.data ?? null);
    });
  }

  const overallTone = result ? scoreTone(result.overallScore) : null;

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <ModuleHeader module={HEALTH_MODULE}>
        Scans a connected Cin7 instance across Sales, Purchases, Stock Transfers, Assemblies, Production Orders, and
        product data quality, and scores each one — plus one overall health score. Read-only; nothing is written back.
      </ModuleHeader>

      <Panel className="mt-6">
        <p className="font-medium text-slate-900">Instance</p>
        <div className="mt-3">
          <InstancePicker {...picker} onChange={picker.setInstanceId} />
        </div>

        <Button onClick={handleScan} disabled={!instanceId} loading={isScanning} className="mt-4">
          {isScanning ? "Scanning…" : "Scan instance"}
        </Button>
        {scanError && (
          <div className="mt-4">
            <Alert tone="danger">{scanError}</Alert>
          </div>
        )}
      </Panel>

      {result && overallTone && (
        <section className={`mt-6 rounded-lg border p-6 ${TONE_STYLES[overallTone].card}`}>
          <p className="text-sm font-medium text-slate-600">Overall health score</p>
          <p className="mt-1 text-4xl font-bold tabular-nums text-slate-900">{result.overallScore}</p>
          <div className="mt-2">
            <Badge tone={TONE_BADGE[overallTone]}>{TONE_STYLES[overallTone].label}</Badge>
          </div>
        </section>
      )}

      {result && (
        <section className="mt-6 flex flex-col gap-4">
          <DimensionCard
            dimension={result.sales}
            columns={[
              { header: "Order #", render: (s) => s.orderNumber, sortValue: (s) => s.orderNumber },
              { header: "Customer", render: (s) => s.customer, sortValue: (s) => s.customer },
              { header: "Fulfilment", render: (s) => s.fulfilmentStatus, sortValue: (s) => s.fulfilmentStatus },
              { header: "Ship by", render: (s) => dateOnly(s.shipBy), sortValue: (s) => s.shipBy },
            ]}
          />
          <DimensionCard
            dimension={result.purchases}
            columns={[
              { header: "Order #", render: (p) => p.orderNumber, sortValue: (p) => p.orderNumber },
              { header: "Supplier", render: (p) => p.supplier, sortValue: (p) => p.supplier },
              { header: "Receiving status", render: (p) => p.receivingStatus, sortValue: (p) => p.receivingStatus },
              { header: "Required by", render: (p) => dateOnly(p.requiredBy), sortValue: (p) => p.requiredBy },
            ]}
          />
          <DimensionCard
            dimension={result.transfers}
            columns={[
              { header: "Number", render: (t) => t.number, sortValue: (t) => t.number },
              { header: "From → To", render: (t) => `${t.fromLocation} → ${t.toLocation}`, sortValue: (t) => `${t.fromLocation} → ${t.toLocation}` },
              { header: "Status", render: (t) => t.status, sortValue: (t) => t.status },
              { header: "Last modified", render: (t) => dateOnly(t.lastModifiedOn), sortValue: (t) => t.lastModifiedOn },
            ]}
          />
          <DimensionCard
            dimension={result.assemblies}
            columns={[
              { header: "Assembly #", render: (a) => a.assemblyNumber, sortValue: (a) => a.assemblyNumber },
              { header: "Product", render: (a) => a.productName, sortValue: (a) => a.productName },
              { header: "Status", render: (a) => a.status, sortValue: (a) => a.status },
              { header: "Assembly date", render: (a) => dateOnly(a.date), sortValue: (a) => a.date },
            ]}
          />
          <DimensionCard
            dimension={result.productionOrders}
            columns={[
              { header: "Order #", render: (o) => o.orderNumber, sortValue: (o) => o.orderNumber },
              { header: "Product", render: (o) => o.productName, sortValue: (o) => o.productName },
              { header: "Status", render: (o) => o.status, sortValue: (o) => o.status },
              { header: "Required by", render: (o) => dateOnly(o.requiredByDate), sortValue: (o) => o.requiredByDate },
            ]}
          />
          <DimensionCard
            dimension={result.productData}
            columns={[
              { header: "Check", render: (i) => i.label, sortValue: (i) => i.label },
              { header: "Count", render: (i) => `${i.count} ${i.unit}`, sortValue: (i) => i.count },
            ]}
            footer={
              <a href="/audit" className="text-sm font-medium text-primary hover:underline">
                Open Data Audit for full details →
              </a>
            }
          />
        </section>
      )}
    </main>
  );
}
