import { MONTH_HEADER_RE, normaliseHeader, type FieldSpec } from "@/rwtsa-demo/contracts/fields";
import type { TabContract } from "@/rwtsa-demo/contracts/tabs";
import { finding, MAX_ROWS_LISTED, type Finding } from "@/rwtsa-demo/findings";
import { coerceCell } from "@/rwtsa-demo/workbook/coerce";
import type { RawTable } from "@/rwtsa-demo/workbook/read";

/**
 * Parses one raw table against its contract, by header NAME (never column position).
 * Every finding is value-free; rows with any invalid or blank-required cell are dropped from `rows` but
 * counted, and the caller treats any error finding as "dataset not usable".
 */

export type ParsedValue = string | number | boolean | null;
export type ParsedRow = Record<string, ParsedValue>;

export interface ParsedTab {
  readonly rows: ParsedRow[];
  readonly rowNumbers: number[];
  /**
   * SalesHistory only: ascending `YYYY-MM`, and per-row quantities aligned to `months`.
   * An explicit numeric 0 stays 0 (valid observation); an EMPTY cell is `null` (missing observation), never 0.
   */
  readonly months: string[];
  readonly monthQty: (number | null)[][];
  readonly findings: Finding[];
}

/** Canonical field key -> a real header text to additionally accept. Supplied from a LOCAL file, never committed. */
export type FieldHeaderOverrides = Readonly<Record<string, string>>;

const MONTHISH_RE = /^\d{4}[^0-9a-z]?\d{1,2}$/i;

function monthIndex(m: string): number {
  return Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
}

class Counter {
  private readonly map = new Map<string, { count: number; rows: number[] }>();
  add(key: string, row?: number): void {
    const e = this.map.get(key) ?? { count: 0, rows: [] };
    e.count++;
    if (row !== undefined && e.rows.length < MAX_ROWS_LISTED) e.rows.push(row);
    this.map.set(key, e);
  }
  entries(): [string, { count: number; rows: number[] }][] {
    return [...this.map.entries()];
  }
}

export function parseTab(contract: TabContract, raw: RawTable, overrides: FieldHeaderOverrides = {}): ParsedTab {
  const findings: Finding[] = [];
  const tab = contract.tab;
  const fail = (): ParsedTab => ({ rows: [], rowNumbers: [], months: [], monthQty: [], findings });

  // 1. Map columns to fields / months by normalised header name.
  const aliasToField = new Map<string, FieldSpec>();
  for (const f of contract.fields) {
    for (const h of f.headers) aliasToField.set(normaliseHeader(h), f);
    const o = overrides[f.key];
    if (o) aliasToField.set(normaliseHeader(o), f);
  }

  const fieldColumn = new Map<string, number>();
  const monthColumns: { month: string; col: number }[] = [];
  let unknownColumns = 0;
  let invalidMonthHeaders = 0;
  const duplicateFields = new Set<string>();

  raw.headers.forEach((h, col) => {
    if (h === "") return;
    if (contract.monthColumns) {
      if (MONTH_HEADER_RE.test(h)) {
        monthColumns.push({ month: h, col });
        return;
      }
      if (MONTHISH_RE.test(h)) {
        invalidMonthHeaders++;
        return;
      }
    }
    const field = aliasToField.get(normaliseHeader(h));
    if (!field) {
      unknownColumns++;
      return;
    }
    if (fieldColumn.has(field.key)) duplicateFields.add(field.key);
    else fieldColumn.set(field.key, col);
  });

  for (const key of duplicateFields) findings.push(finding({ severity: "error", code: "duplicate_header", tab, field: key, count: 1 }));
  if (unknownColumns > 0) findings.push(finding({ severity: "warning", code: "unknown_column", tab, count: unknownColumns }));
  if (invalidMonthHeaders > 0) findings.push(finding({ severity: "error", code: "invalid_month_header", tab, count: invalidMonthHeaders }));

  let headerError = duplicateFields.size > 0 || invalidMonthHeaders > 0;
  for (const f of contract.fields) {
    if (f.required && !fieldColumn.has(f.key)) {
      findings.push(finding({ severity: "error", code: "missing_header", tab, field: f.key, count: 1 }));
      headerError = true;
    }
  }

  // 2. Month columns (SalesHistory).
  let months: string[] = [];
  if (contract.monthColumns) {
    const seen = new Set<string>();
    let dup = 0;
    for (const m of monthColumns) {
      if (seen.has(m.month)) dup++;
      seen.add(m.month);
    }
    if (dup > 0) {
      findings.push(finding({ severity: "error", code: "duplicate_month", tab, count: dup }));
      headerError = true;
    }
    months = [...seen].sort();
    if (months.length === 0) {
      findings.push(finding({ severity: "error", code: "no_month_columns", tab, count: 1 }));
      headerError = true;
    } else {
      let gaps = 0;
      for (let i = 1; i < months.length; i++) if (monthIndex(months[i]) - monthIndex(months[i - 1]) !== 1) gaps++;
      if (gaps > 0) {
        findings.push(finding({ severity: "error", code: "month_gap", tab, count: gaps }));
        headerError = true;
      }
    }
  }
  if (headerError) return fail();

  // Absent OPTIONAL columns are reported, not treated as mandatory: a warning (names the field) when a scenario's
  // calculations need it (`critical`), otherwise one info finding per tab listing our canonical keys.
  const absentOptional = contract.fields.filter((f) => !f.required && !fieldColumn.has(f.key));
  for (const f of absentOptional.filter((x) => x.critical)) {
    findings.push(finding({ severity: "warning", code: "optional_header_absent", tab, field: f.key, count: 1 }));
  }
  const absentOther = absentOptional.filter((x) => !x.critical);
  if (absentOther.length > 0) {
    findings.push(finding({ severity: "info", code: "optional_header_absent", tab, fields: absentOther.map((x) => x.key), count: absentOther.length }));
  }

  // 3. Rows.
  const monthCol = new Map(monthColumns.map((m) => [m.month, m.col]));
  const rows: ParsedRow[] = [];
  const rowNumbers: number[] = [];
  const monthQty: (number | null)[][] = [];
  const blanks = new Counter();
  const negatives = new Counter();
  const negativeErrors = new Set<string>();
  const invalid = new Counter();
  const missingSkuAndStyle: number[] = [];

  raw.rows.forEach((cells, i) => {
    const sheetRow = raw.rowNumbers[i];
    const out: ParsedRow = {};
    let bad = false;
    for (const f of contract.fields) {
      const col = fieldColumn.get(f.key);
      if (col === undefined) {
        out[f.key] = null;
        continue;
      }
      const r = coerceCell(f, cells[col]);
      if (!r.ok) {
        invalid.add(`${f.key}\u0000${r.reason}`, sheetRow);
        bad = true;
      } else if (r.value === null && f.required) {
        blanks.add(f.key, sheetRow);
        bad = true;
      } else {
        out[f.key] = r.value;
        if (typeof r.value === "number" && r.value < 0 && !f.allowNegative) {
          negatives.add(f.key, sheetRow);
          if (f.negativeIsError) negativeErrors.add(f.key);
        }
      }
    }

    const qty: (number | null)[] = [];
    if (contract.monthColumns) {
      for (const m of months) {
        const r = coerceCell({ key: "month", headers: [], kind: "num", required: false }, cells[monthCol.get(m)!]);
        if (!r.ok) {
          invalid.add(`month\u0000${r.reason}`, sheetRow);
          bad = true;
        } else {
          // Empty cell => null (missing observation). An explicit 0 stays 0. Never coerce one into the other.
          const v = typeof r.value === "number" ? r.value : null;
          qty.push(v);
          if (v !== null && v < 0) negatives.add("month", sheetRow);
        }
      }
    }

    if (tab === "ImportPOs" && !bad && out.sku === null && out.styleCode === null) {
      missingSkuAndStyle.push(sheetRow);
      bad = true;
    }
    if (bad) return;
    rows.push(out);
    rowNumbers.push(sheetRow);
    monthQty.push(qty);
  });

  for (const [field, e] of negatives.entries()) {
    findings.push(finding({ severity: negativeErrors.has(field) ? "error" : "warning", code: "negative_value", tab, field, count: e.count, rows: e.rows }));
  }
  for (const [field, e] of blanks.entries()) findings.push(finding({ severity: "error", code: "required_blank", tab, field, count: e.count, rows: e.rows }));
  for (const [k, e] of invalid.entries()) {
    const [field, reason] = k.split("\u0000");
    findings.push(finding({ severity: "error", code: "invalid_cell", tab, field, reason, count: e.count, rows: e.rows }));
  }
  if (missingSkuAndStyle.length > 0) {
    findings.push(finding({ severity: "error", code: "po_missing_sku_and_style", tab, count: missingSkuAndStyle.length, rows: missingSkuAndStyle }));
  }

  // 4. Duplicate natural keys: first occurrence wins; later ones are dropped and reported.
  const seenKeys = new Set<string>();
  const dupRows: number[] = [];
  let dupCount = 0;
  const keptRows: ParsedRow[] = [];
  const keptNumbers: number[] = [];
  const keptQty: (number | null)[][] = [];
  rows.forEach((r, i) => {
    const key = contract.naturalKey.map((k) => String(r[k] ?? "")).join("\u0001");
    if (seenKeys.has(key)) {
      dupCount++;
      if (dupRows.length < MAX_ROWS_LISTED) dupRows.push(rowNumbers[i]);
      return;
    }
    seenKeys.add(key);
    keptRows.push(r);
    keptNumbers.push(rowNumbers[i]);
    keptQty.push(monthQty[i]);
  });
  if (dupCount > 0) {
    findings.push(finding({ severity: "error", code: "duplicate_key", tab, field: contract.naturalKey.join("+"), count: dupCount, rows: dupRows }));
  }

  return { rows: keptRows, rowNumbers: keptNumbers, months, monthQty: keptQty, findings };
}
