import { normaliseHeader } from "@/rwtsa-demo/contracts/fields";
import { SIZE_ORDER, TAB_CONTRACTS, type TabName } from "@/rwtsa-demo/contracts/tabs";
import { finding, type Finding } from "@/rwtsa-demo/findings";
import type { RawTable } from "@/rwtsa-demo/workbook/read";

/**
 * Sheet layouts. The advisor's workbook has two shapes:
 *   - TABULAR sheets: header in the first non-empty row, one record per row (Items, SalesHistory, Stock, ImportPOs,
 *     Customers, Quotes). Only the header WORDING differs from the contract, which is handled by explicit aliases.
 *   - REPORT sheets (BOM, Routing_SMV, ProductionOrders, LandedCost, Payments_FEC): title / text lines above a header that
 *     sits on a fixed, named row; identifiers and rates stated in those title lines; summary and note rows below the data.
 *
 * Everything here is EXPLICIT and PER SHEET: the header rows to try, the title row and pattern each identifier comes from,
 * the one size-list rule, the one per-unit price rule. There is no fuzzy matching of unknown headers. Every row on the sheet
 * is accounted for (`TabLayoutReport`): nothing is discarded without a counted, value-free finding, and anything that is not
 * explained is left for the strict contract parse to reject.
 */

export type GridRow = { readonly rowNumber: number; readonly cells: readonly unknown[] };

export interface DerivedInfo {
  readonly field: string;
  readonly source: string;
}

export interface TabLayoutReport {
  readonly tab: TabName;
  readonly layout: "standard" | "report";
  readonly headerRow: number;
  /** Non-empty rows on the sheet. */
  readonly sheetRows: number;
  readonly titleRows: number;
  /** Source rows handed to the contract parse (after notes and explained exclusions are removed). */
  readonly dataRows: number;
  /** Merged / single-text note rows inside the data region. */
  readonly noteRows: number;
  /** Rows removed for an explained, counted reason (the routing-derived Labour line). */
  readonly excludedRows: number;
  readonly trailingSummaryRows: number;
  readonly trailingNoteRows: number;
  /** Extra parsed rows created by expanding a size list. */
  readonly expandedRows: number;
  /** Rows in the dataset for this tab (filled in once parsed). */
  readonly parsedRows: number;
  readonly derived: readonly DerivedInfo[];
  /** LandedCost only: lines whose product is an Items style code rather than a SKU. */
  readonly styleLevelLines?: number;
}

export interface LayoutResult {
  readonly table: RawTable;
  readonly report: TabLayoutReport;
  readonly findings: readonly Finding[];
}

interface ContextRule {
  readonly field: string;
  readonly source: "title row" | "text line";
  /** 1-based sheet row the text is read from. */
  readonly row: number;
  readonly pattern: RegExp;
  readonly numeric?: boolean;
  /** When the text does not yield a value: an error (the contract needs the field) or a warning (optional field). */
  readonly severity: "error" | "warning";
}

interface ReportSpec {
  /** Sheet rows to try as the header, in order, after the first non-empty row. */
  readonly headerRows: readonly number[];
  /** Contract fields a row must match to be accepted as the header (default 3; the routing table only has two of them). */
  readonly minHeaderMatches?: number;
  readonly context: readonly ContextRule[];
}

const TOKEN = "[A-Za-z0-9][A-Za-z0-9._-]*";
const NUM = "(\\d[\\d,]*(?:\\.\\d+)?)";

export const REPORT_SPECS: Readonly<Partial<Record<TabName, ReportSpec>>> = {
  BOM: {
    headerRows: [4],
    context: [{ field: "styleCode", source: "title row", row: 2, pattern: new RegExp(`^\\s*Style:\\s*(${TOKEN})`), severity: "error" }],
  },
  Routing_SMV: {
    headerRows: [4],
    minHeaderMatches: 2,
    context: [
      { field: "styleCode", source: "title row", row: 1, pattern: new RegExp(`\\s[-\\u2013\\u2014]\\s(${TOKEN})\\s*\\(`), severity: "error" },
      { field: "costPerMinute", source: "text line", row: 2, pattern: new RegExp(`Cost-per-minute[^:]*:\\s*R\\s*(\\d+(?:\\.\\d+)?)`), numeric: true, severity: "error" },
    ],
  },
  ProductionOrders: { headerRows: [3], context: [] },
  LandedCost: {
    headerRows: [4],
    context: [
      { field: "shipmentRef", source: "title row", row: 1, pattern: /\b(PO-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\b/, severity: "error" },
      { field: "planningFx", source: "text line", row: 2, pattern: new RegExp(`Planning FX[^:]*:\\s*${NUM}`), numeric: true, severity: "warning" },
      { field: "customsFx", source: "text line", row: 2, pattern: new RegExp(`\\(actual\\):\\s*${NUM}`), numeric: true, severity: "warning" },
      { field: "freightTotalZar", source: "text line", row: 2, pattern: new RegExp(`\\(ZAR\\)\\s*=\\s*${NUM}`), numeric: true, severity: "warning" },
    ],
  },
  Payments_FEC: { headerRows: [3], context: [] },
};

/** Sheets that document the workbook but carry no data the engines use. Recognised, counted, never parsed. */
export const SUPPLEMENTARY_SHEETS: readonly string[] = ["ReadMe"];

const isBlank = (v: unknown): boolean => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
const isNumberish = (v: unknown): boolean => typeof v === "number" || v instanceof Date;

function headerText(v: unknown): string {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 7);
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

/** Normalised alias -> field key for one tab. */
function aliasMap(tab: TabName): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of TAB_CONTRACTS[tab].fields) for (const h of f.headers) m.set(normaliseHeader(h), f.key);
  return m;
}

function fieldColumns(tab: TabName, headers: readonly string[]): Map<string, number> {
  const aliases = aliasMap(tab);
  const out = new Map<string, number>();
  headers.forEach((h, i) => {
    const k = aliases.get(normaliseHeader(h));
    if (k !== undefined && !out.has(k)) out.set(k, i);
  });
  return out;
}

/** A merged / single-text note: only text, at most one distinct text, and nothing in the first (key) column. */
function isNoteRow(cells: readonly unknown[]): boolean {
  if (!isBlank(cells[0])) return false;
  const nonBlank = cells.filter((c) => !isBlank(c));
  if (nonBlank.length === 0) return false;
  if (!nonBlank.every((c) => typeof c === "string")) return false;
  if (new Set(nonBlank.map((c) => (c as string).trim())).size !== 1) return false;
  // Merged across columns (the same text repeated), or a long single sentence: not a sparse data row that lost its key.
  return nonBlank.length >= 2 || (nonBlank[0] as string).trim().length >= 25;
}

function canonicalHeader(tab: TabName, field: string): string {
  return TAB_CONTRACTS[tab].fields.find((f) => f.key === field)!.headers[0];
}

function parseNumber(text: string): number | null {
  const n = Number(text.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

const SIZE_SET: ReadonlySet<string> = new Set(SIZE_ORDER);

/** Builds the raw table for one recognised sheet from its non-empty grid rows. Pure. */
export function extractTable(tab: TabName, grid: readonly GridRow[]): LayoutResult {
  const findings: Finding[] = [];
  const spec = REPORT_SPECS[tab];
  const aliases = aliasMap(tab);

  // 1. Header row: the first non-empty row, or (report sheets only) one of the explicit rows for that sheet.
  const scoreRow = (g: GridRow | undefined): number => {
    if (!g) return 0;
    const hit = new Set<string>();
    for (const c of g.cells) {
      const k = aliases.get(normaliseHeader(headerText(c)));
      if (k) hit.add(k);
    }
    return hit.size;
  };
  let headerIdx = grid.length === 0 ? -1 : 0;
  const need = spec?.minHeaderMatches ?? 3;
  if (spec && grid.length > 0 && scoreRow(grid[0]) < need) {
    for (const rowNo of spec.headerRows) {
      const i = grid.findIndex((g) => g.rowNumber === rowNo);
      if (i >= 0 && scoreRow(grid[i]) >= need) {
        headerIdx = i;
        break;
      }
    }
  }
  const isReport = headerIdx > 0;
  // "Duty %" is a RATE column; its normalised name collides with the ZAR duty amount alias, so it is renamed explicitly.
  const headers: string[] = headerIdx >= 0 ? grid[headerIdx].cells.map(headerText).map((h) => (tab === "LandedCost" && /^duty\s*%$/i.test(h) ? "Duty rate (percent)" : h)) : [];
  const titleRows = headerIdx > 0 ? headerIdx : 0;
  const body = headerIdx >= 0 ? grid.slice(headerIdx + 1) : [];
  const derived: DerivedInfo[] = [];

  // 2. Data region. Report sheets end at the first gap in row numbers or the first row with no key; the rest is accounted
  //    as trailing summary / note rows. Tabular sheets are data to the end, except merged note rows.
  let end = body.length;
  if (isReport) {
    let prev = grid[headerIdx].rowNumber;
    for (let i = 0; i < body.length; i++) {
      if (body[i].rowNumber !== prev + 1 || isBlank(body[i].cells[0])) {
        end = i;
        break;
      }
      prev = body[i].rowNumber;
    }
  }
  const region = body.slice(0, end);
  const trailing = body.slice(end);
  const trailingSummary = trailing.filter((g) => g.cells.some(isNumberish)).length;
  const trailingNote = trailing.length - trailingSummary;
  if (trailingSummary > 0) findings.push(finding({ severity: "info", code: "layout_trailing_rows", tab, reason: "summary", count: trailingSummary, rows: trailing.filter((g) => g.cells.some(isNumberish)).map((g) => g.rowNumber) }));
  if (trailingNote > 0) findings.push(finding({ severity: "info", code: "layout_trailing_rows", tab, reason: "note", count: trailingNote, rows: trailing.filter((g) => !g.cells.some(isNumberish)).map((g) => g.rowNumber) }));

  const noteRows = region.filter((g) => isNoteRow(g.cells));
  if (noteRows.length > 0) findings.push(finding({ severity: "info", code: "note_row_ignored", tab, count: noteRows.length, rows: noteRows.map((g) => g.rowNumber) }));
  let data = region.filter((g) => !isNoteRow(g.cells));

  // 3. Title-line context (report sheets): identifiers and rates that the sheet states once, above the table.
  const constants = new Map<string, string | number>();
  if (isReport && spec) {
    for (const rule of spec.context) {
      const titleRow = grid.slice(0, headerIdx).find((g) => g.rowNumber === rule.row);
      const text = titleRow ? titleRow.cells.find((c) => typeof c === "string" && c.trim() !== "") : undefined;
      const m = typeof text === "string" ? rule.pattern.exec(text) : null;
      const raw = m?.[1];
      const value = raw === undefined ? null : rule.numeric ? parseNumber(raw) : raw;
      if (value === null) {
        findings.push(finding({ severity: rule.severity, code: "context_missing", tab, field: rule.field, count: 1 }));
        continue;
      }
      constants.set(rule.field, value);
      derived.push({ field: rule.field, source: rule.source });
    }
  }

  // 4. Tab-specific row rules.
  let columns = fieldColumns(tab, headers);
  // Rows are padded to the header width so appended (derived) columns always line up.
  let rows: { rowNumber: number; cells: unknown[] }[] = data.map((g) => ({ rowNumber: g.rowNumber, cells: Array.from({ length: headers.length }, (_, c) => g.cells[c] ?? null) }));
  let excluded = 0;
  let expanded = 0;
  const outHeaders = [...headers];
  const addColumn = (field: string, source: string, valueOf: (cells: unknown[], i: number) => unknown): void => {
    outHeaders.push(canonicalHeader(tab, field));
    rows.forEach((r, i) => r.cells.push(valueOf(r.cells, i)));
    derived.push({ field, source });
    columns = fieldColumns(tab, outHeaders);
  };

  if (tab === "BOM" && isReport) {
    // A Labour line whose quantity and cost are text pointing at the routing is not a costed component: labour is costed
    // from Routing_SMV. It is counted and reported; any OTHER non-numeric line stays for the strict parse to reject.
    const typeCol = columns.get("componentType");
    const qtyCol = columns.get("qtyPerUnit");
    const costCol = columns.get("unitCost");
    if (typeCol !== undefined && qtyCol !== undefined && costCol !== undefined) {
      const isNum = (v: unknown) => typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.replace(/[\s ]/g, "")));
      const labour = rows.filter((r) => typeof r.cells[typeCol] === "string" && (r.cells[typeCol] as string).trim().toLowerCase() === "labour" && !(isNum(r.cells[qtyCol]) && isNum(r.cells[costCol])));
      if (labour.length > 0) {
        findings.push(finding({ severity: "info", code: "layout_row_excluded", tab, reason: "routing_derived_labour", count: labour.length, rows: labour.map((r) => r.rowNumber) }));
        excluded = labour.length;
        const drop = new Set(labour);
        rows = rows.filter((r) => !drop.has(r));
        data = data.filter((g) => !labour.some((l) => l.rowNumber === g.rowNumber));
      }
    }
    // Size lists: "Applies to sizes" -> one row per size. "All ..." (or blank) means every size.
    const appliesCol = headers.findIndex((h) => normaliseHeader(h) === "appliestosizes");
    if (appliesCol >= 0 && !columns.has("size")) {
      const out: typeof rows = [];
      const bad: number[] = [];
      for (const r of rows) {
        const text = typeof r.cells[appliesCol] === "string" ? (r.cells[appliesCol] as string).trim() : "";
        if (text === "" || /^all\b/i.test(text)) {
          out.push({ rowNumber: r.rowNumber, cells: [...r.cells, null] });
          continue;
        }
        const tokens = text.split(/[,;/]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
        if (tokens.length === 0 || !tokens.every((t) => SIZE_SET.has(t))) {
          bad.push(r.rowNumber);
          out.push({ rowNumber: r.rowNumber, cells: [...r.cells, null] });
          continue;
        }
        expanded += tokens.length - 1;
        for (const t of tokens) out.push({ rowNumber: r.rowNumber, cells: [...r.cells, t] });
      }
      rows = out;
      outHeaders.push(canonicalHeader(tab, "size"));
      derived.push({ field: "size", source: "expanded from Applies to sizes" });
      columns = fieldColumns(tab, outHeaders);
      if (bad.length > 0) findings.push(finding({ severity: "error", code: "size_token_unrecognised", tab, count: bad.length, rows: bad }));
    }
    // The component label doubles as the component name (the sheet has no separate code or name column).
    if (!columns.has("componentName") && columns.has("componentCode")) {
      const col = columns.get("componentCode")!;
      addColumn("componentName", "copied from Component", (cells) => cells[col]);
    }
  }

  if (tab === "LandedCost" && isReport) {
    // "FOB (USD/unit)" is a unit price; the contract's fobUsd is a line total. Only that exact header is converted.
    const unitCol = headers.findIndex((h) => normaliseHeader(h) === "fobusdunit");
    const qtyCol = columns.get("qty");
    if (unitCol >= 0 && qtyCol !== undefined && !columns.has("fobUsd")) {
      outHeaders[unitCol] = canonicalHeader(tab, "fobUsd");
      rows.forEach((r) => {
        const u = r.cells[unitCol];
        const q = r.cells[qtyCol];
        const un = typeof u === "number" ? u : typeof u === "string" ? parseNumber(u) : null;
        const qn = typeof q === "number" ? q : typeof q === "string" ? parseNumber(q) : null;
        if (un !== null && qn !== null) r.cells[unitCol] = Math.round(un * qn * 1e6) / 1e6;
      });
      derived.push({ field: "fobUsd", source: "unit price x quantity" });
      columns = fieldColumns(tab, outHeaders);
    }
  }

  // Context constants become columns (only where the sheet has no column of its own for that field).
  for (const [field, value] of constants) {
    if (columns.has(field)) {
      const i = derived.findIndex((d) => d.field === field);
      if (i >= 0) derived.splice(i, 1);
      continue;
    }
    outHeaders.push(canonicalHeader(tab, field));
    rows.forEach((r) => r.cells.push(value));
    columns = fieldColumns(tab, outHeaders);
  }
  // Keep the derived list in a stable order and without duplicates.
  const seen = new Set<string>();
  const derivedOut = derived.filter((d) => (seen.has(d.field) ? false : (seen.add(d.field), true)));

  const width = outHeaders.length;
  const table: RawTable = {
    tab,
    headers: outHeaders,
    rowNumbers: rows.map((r) => r.rowNumber),
    rows: rows.map((r) => Array.from({ length: width }, (_, c) => (c < r.cells.length ? r.cells[c] : null))),
  };
  const report: TabLayoutReport = {
    tab,
    layout: isReport ? "report" : "standard",
    headerRow: headerIdx >= 0 ? grid[headerIdx].rowNumber : 0,
    sheetRows: grid.length,
    titleRows,
    dataRows: data.length,
    noteRows: noteRows.length,
    excludedRows: excluded,
    trailingSummaryRows: trailingSummary,
    trailingNoteRows: trailingNote,
    expandedRows: expanded,
    parsedRows: 0,
    derived: derivedOut,
  };
  return { table, report, findings };
}
