import "server-only";
// NewQuip Reports: builds each report's view-model for an AUTHORISED viewer. The same function feeds the page and the Excel export, so what is exported is exactly what is shown
// (the export simply ignores the page window). Authorisation of the viewer happens in the caller; the cost entitlement is re-checked inside the costing path.
import type { createServiceRoleClient } from "@/supabase/server";
import { applyFilters, inRange, isMine, ageText, fmtDate, overviewOf, paginate, pipelineRows, sortRows, OUTSTANDING_CATEGORIES, CATEGORY_LABEL, type Category, type Filters, type Overview, type PipelineRow, type Viewer } from "./ops";
import { costingTotals, MARGIN_BASIS_LABEL, type CostingRow, type CostingTotals, type MarginBasis } from "./costing-model";
import { loadCostingRows, loadOperationalData, COSTING_CAP } from "./load";

type Db = ReturnType<typeof createServiceRoleClient>;
export type ReportKind = "overview" | "pipeline" | "costing" | "bottlenecks";
export const REPORT_KINDS: readonly ReportKind[] = ["overview", "pipeline", "costing", "bottlenecks"];
export interface ReportViewer extends Viewer { orgId: string; canSeeCost: boolean }

import type { CostingFilters } from "./service-types";
export type { CostingFilters };

const inList = (rows: readonly PipelineRow[]) => ({
  creators: [...new Set(rows.map((r) => r.createdBy).filter((x): x is string => !!x))].sort(),
  assignees: [...new Set(rows.map((r) => r.assignedTo).filter((x): x is string => !!x))].sort(),
  stages: [...new Set(rows.map((r) => r.stage))].sort(), statuses: [...new Set(rows.map((r) => r.status))].sort(),
});

export async function overviewReport(db: Db, v: ReportViewer, f: Filters, now = new Date()): Promise<{ overview: Overview; filtered: number }> {
  const d = await loadOperationalData(db, v.orgId);
  const rows = applyFilters(pipelineRows(d, now), { from: f.from, to: f.to }, v);
  const projects = d.projects.filter((p) => inRange(p.created_at, f.from, f.to));
  return { overview: overviewOf(rows, projects, now), filtered: rows.length };
}

export async function pipelineReport(db: Db, v: ReportViewer, f: Filters, now = new Date()) {
  const d = await loadOperationalData(db, v.orgId);
  const all = pipelineRows(d, now);
  const filtered = sortRows(applyFilters(all, f, v), f.sort ?? "created", f.dir ?? "desc");
  return { generatedAt: now.toISOString(), facets: inList(all), count: filtered.length, valueCents: filtered.reduce((n, r) => n + (r.valueCents ?? 0), 0), withoutValue: filtered.filter((r) => r.valueCents == null).length, all: filtered, ...paginate(filtered, f.page, f.pageSize) };
}

export interface BottleneckRow extends PipelineRow { blockers?: string[] }
export async function bottleneckReport(db: Db, v: ReportViewer, f: Filters, now = new Date()) {
  const d = await loadOperationalData(db, v.orgId);
  let open = pipelineRows(d, now).filter((r) => r.outstanding);
  // "All outstanding actions" is a Manager view. Anyone else's "all" is their own role's queue: work waiting on a role they hold (a Rep's Rep items are those they created).
  if (!v.roles.has("manager")) open = open.filter((r) => isMine(r, v) || (v.roles.has("estimator") && r.waitingOn === "Estimator") || (v.roles.has("rep") && (r.waitingOn === "Rep" || r.waitingOn === "Rep or Manager") && (r.createdBy ?? "").toLowerCase() === v.email.toLowerCase()));
  const view = f.view ?? "all";
  const filtered = sortRows(applyFilters(open, { ...f, view }, v), f.sort ?? "urgent", f.dir ?? "desc") as BottleneckRow[];
  // Costing blockers (missing supplier costs, unverified costs, unmapped products) are COMMERCIAL signals: attached only for an entitled viewer, and only for quotations still being costed.
  if (v.canSeeCost) {
    const ids = filtered.filter((r) => r.category === "ESTIMATOR_REVIEW" || r.category === "MANAGER_APPROVAL").map((r) => r.id);
    if (ids.length) {
      const c = await loadCostingRows(db, v.orgId, v, ids);
      const by = new Map(c.rows.map((r) => [r.id, r]));
      for (const r of filtered) { const c1 = by.get(r.id); if (c1) r.blockers = c1.exceptions; }
    }
  }
  const counts = OUTSTANDING_CATEGORIES.map((category) => ({ category, label: CATEGORY_LABEL[category], count: open.filter((r) => r.category === category).length })).filter((x) => x.count > 0);
  return { generatedAt: now.toISOString(), counts, count: filtered.length, over3: open.filter((r) => (r.ageDays ?? -1) > 3).length, over7: open.filter((r) => (r.ageDays ?? -1) > 7).length, unknownAge: open.filter((r) => r.ageDays == null).length, all: filtered, ...paginate(filtered, f.page, f.pageSize) };
}

export async function costingReport(db: Db, v: ReportViewer, f: CostingFilters, now = new Date()) {
  if (!v.canSeeCost) throw new Error("Costing and margin reporting is restricted to Estimators and Managers.");
  const d = await loadOperationalData(db, v.orgId);
  const ops = applyFilters(pipelineRows(d, now), { from: f.from, to: f.to, customer: f.customer, q: f.q, creator: f.creator }, v);
  const { rows, truncated } = await loadCostingRows(db, v.orgId, v, ops.map((r) => r.id));
  let list: CostingRow[] = rows;
  if (f.basis) list = list.filter((r) => r.basis === f.basis);
  if (f.exceptionsOnly) list = list.filter((r) => r.exceptions.length > 0);
  const key = f.csort ?? "ref"; const sign = f.dir === "asc" ? 1 : -1;
  list = list.slice().sort((a, b) => {
    if (key !== "ref") { const ka = key === "margin" ? a.marginPct : a.sellingCents; const kb = key === "margin" ? b.marginPct : b.sellingCents; if (ka !== kb) { if (ka == null) return 1; if (kb == null) return -1; return (ka - kb) * sign; } }
    return a.quoteRef < b.quoteRef ? -1 : a.quoteRef > b.quoteRef ? 1 : a.id < b.id ? -1 : 1;
  });
  const totals: CostingTotals = costingTotals(list);
  return { generatedAt: now.toISOString(), truncated, cap: COSTING_CAP, totals, count: list.length, all: list, ...paginate(list, f.page, f.pageSize) };
}

// ── Excel export (one workbook per report; the figures are the displayed ones) ──────────────────────────────────────────────

const rand = (c: number | null) => (c == null ? null : c / 100);
const MONEY = '"R" #,##0.00'; const PCT = '0.00"%"';

export async function exportReport(db: Db, v: ReportViewer, kind: ReportKind, f: CostingFilters, now = new Date()): Promise<{ buffer: Buffer; fileName: string }> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook(); wb.creator = "NewQuip"; wb.created = now;
  const title = { overview: "Management Overview", pipeline: "Quotation Pipeline", costing: "Costing & Margin Analysis (CONFIDENTIAL)", bottlenecks: "Bottlenecks & Outstanding Actions" }[kind];
  const ws = wb.addWorksheet(title.slice(0, 31));
  const head = (cols: Array<{ header: string; key: string; width: number; fmt?: string }>, rows: Array<Record<string, unknown>>) => {
    ws.addRow([`NewQuip: ${title}`]).font = { bold: true, size: 14 };
    ws.addRow([`Generated: ${fmtDate(now.toISOString())} ${now.toISOString().slice(11, 16)} UTC`]);
    ws.addRow([`Filters: ${describe(f)}`]);
    ws.addRow(["All amounts are in South African Rand (ZAR), EXCLUDING VAT, unless a column says otherwise."]);
    ws.addRow([]);
    const hr = ws.addRow(cols.map((c) => c.header)); hr.font = { bold: true };
    cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; if (c.fmt) ws.getColumn(i + 1).numFmt = c.fmt; });
    for (const r of rows) ws.addRow(cols.map((c) => r[c.key] ?? ""));
    ws.getRow(6).eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } }; });
    // The numeric formats were applied to whole columns; reset the text rows above the table so titles are not formatted as money.
    for (let i = 1; i <= 5; i++) ws.getRow(i).eachCell((c) => { c.numFmt = "General"; });
    ws.views = [{ state: "frozen", ySplit: 6 }];
  };
  const opCols = [
    { header: "Quotation", key: "quoteRef", width: 14 }, { header: "Revision", key: "revision", width: 9 }, { header: "Customer", key: "customer", width: 28 }, { header: "Site", key: "site", width: 24 },
    { header: "Created", key: "created", width: 12 }, { header: "Created by", key: "createdBy", width: 28 }, { header: "Stage", key: "stage", width: 20 }, { header: "Status", key: "status", width: 30 },
    { header: "Next action", key: "nextAction", width: 36 }, { header: "Waiting on", key: "waitingOn", width: 22 }, { header: "Assigned to (recorded)", key: "assignedTo", width: 26 },
    { header: "Last action by", key: "lastActionBy", width: 28 }, { header: "Days in stage", key: "age", width: 14 }, { header: "In stage since", key: "since", width: 14 }, { header: "Value ex VAT (ZAR)", key: "value", width: 20, fmt: MONEY },
    { header: "Value basis", key: "basis", width: 16 }, { header: "Customer response", key: "resp", width: 28 }, { header: "Project", key: "project", width: 16 },
  ];
  const opRow = (r: PipelineRow & { blockers?: string[] }) => ({
    quoteRef: r.quoteRef, revision: r.revision, customer: r.customer, site: r.site, created: fmtDate(r.createdAt), createdBy: r.createdBy ?? "Unknown", stage: r.stage, status: r.status, nextAction: r.nextAction,
    waitingOn: r.waitingOnLabel, assignedTo: r.assignedTo ?? "Unassigned", lastActionBy: r.lastActionBy ?? "Not recorded", age: r.ageDays == null ? "Not recorded" : r.ageDays, since: fmtDate(r.since),
    value: rand(r.valueCents), basis: r.valueBasis === "CONTRACT" ? "Approved contract" : r.valueBasis === "CONFIRMED" ? "Indicative (customer-confirmed)" : "No value yet", resp: r.customerResponse, project: r.projectRef ?? "",
    blockers: (r.blockers ?? []).join("; "),
  });
  if (kind === "pipeline") { const r = await pipelineReport(db, v, { ...f, pageSize: 200 }, now); head(opCols, r.all.map(opRow)); }
  else if (kind === "bottlenecks") {
    const r = await bottleneckReport(db, v, { ...f, pageSize: 200 }, now);
    const cols = v.canSeeCost ? [...opCols, { header: "Costing blockers", key: "blockers", width: 44 }] : opCols;
    head(cols, r.all.map(opRow));
  } else if (kind === "overview") {
    const { overview: o } = await overviewReport(db, v, f, now);
    head([{ header: "Measure", key: "m", width: 52 }, { header: "Count", key: "c", width: 12 }, { header: "Value ex VAT (ZAR)", key: "v", width: 22, fmt: MONEY }], [
      { m: "Open quotations", c: o.open, v: rand(o.indicativePipelineCents) }, { m: "Awaiting Rep action", c: o.awaitingRep }, { m: "Awaiting Estimator costing", c: o.awaitingEstimator }, { m: "Awaiting Manager approval", c: o.awaitingManager },
      { m: "Awaiting customer response", c: o.awaitingCustomer }, { m: "Customer acceptance awaiting verification", c: o.awaitingVerification }, { m: "Accepted by customer", c: o.accepted }, { m: "Declined, returned or changes requested", c: o.declinedOrReturned },
      { m: "Active projects", c: o.projects.active }, { m: "Quotations converted into projects", c: o.projects.convertedQuotes }, ...o.byCategory.map((x) => ({ m: `By stage: ${x.label}`, c: x.count, v: rand(x.valueCents) })),
    ]);
  } else {
    const r = await costingReport(db, v, { ...f, pageSize: 200 }, now);
    head([
      { header: "Quotation", key: "quoteRef", width: 14 }, { header: "Revision", key: "revision", width: 9 }, { header: "Customer", key: "customer", width: 28 }, { header: "Margin basis", key: "basis", width: 34 },
      { header: "Selling value ex VAT (ZAR)", key: "sell", width: 24, fmt: MONEY }, { header: "Estimated cost (ZAR)", key: "cost", width: 20, fmt: MONEY }, { header: "Expected gross profit (ZAR)", key: "gp", width: 24, fmt: MONEY },
      { header: "Gross margin %", key: "margin", width: 14, fmt: PCT }, { header: "Markup %", key: "markup", width: 12, fmt: PCT }, { header: "Delivery & installation (ZAR)", key: "di", width: 24, fmt: MONEY },
      { header: "Uncosted charges (ZAR)", key: "unc", width: 20, fmt: MONEY }, { header: "Lines: estimated/historical", key: "prov", width: 16 }, { header: "Lines: manual estimate", key: "ovr", width: 16 },
      { header: "Lines: verified", key: "ver", width: 12 }, { header: "Lines: missing cost", key: "miss", width: 14 }, { header: "Unverified supplier costs", key: "unv", width: 16 }, { header: "Unmapped products", key: "unm", width: 14 },
      { header: "FX overrides", key: "fx", width: 14 }, { header: "Exceptions", key: "exc", width: 60 },
    ], r.all.map((c) => ({
      quoteRef: c.quoteRef, revision: c.revision, customer: c.customer, basis: MARGIN_BASIS_LABEL[c.basis as MarginBasis], sell: rand(c.sellingCents), cost: rand(c.costCents), gp: rand(c.gpCents), margin: c.marginPct, markup: c.markupPct,
      di: rand(c.deliveryInstallCents), unc: rand(c.uncostedChargesCents), prov: c.lines?.provisional ?? "n/a", ovr: c.lines?.override ?? "n/a", ver: c.lines?.verified ?? "n/a", miss: c.lines?.missing ?? "n/a", unv: c.unverifiedSupplierCosts ?? "n/a",
      unm: c.unmapped ?? "n/a", fx: c.fxOverrideCurrencies.join(", "), exc: c.exceptions.join("; "),
    })));
  }
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer: buf, fileName: `newquip-${kind}-${now.toISOString().slice(0, 10)}.xlsx` };
}

function describe(f: CostingFilters): string {
  const parts = Object.entries(f).filter(([k, val]) => val != null && val !== "" && !["page", "pageSize", "sort", "dir", "csort"].includes(k)).map(([k, val]) => `${k}=${String(val)}`);
  return parts.length ? parts.join(", ") : "none";
}
export { ageText };
export type { Category };
