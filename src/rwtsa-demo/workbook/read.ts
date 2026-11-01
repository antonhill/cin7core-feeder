import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { MAX_CSV_COLUMNS, MAX_CSV_FIELD_LENGTH, MAX_CSV_ROWS } from "@/lib/csv-upload-limits";
import { normaliseHeader } from "@/rwtsa-demo/contracts/fields";
import { TAB_NAMES, type TabName } from "@/rwtsa-demo/contracts/tabs";
import { finding, RwtsaSafeError, type Finding } from "@/rwtsa-demo/findings";
import { extractTable, SUPPLEMENTARY_SHEETS, type GridRow, type TabLayoutReport } from "@/rwtsa-demo/workbook/layouts";
import { assertWorkbookPathAllowed } from "@/rwtsa-demo/workbook/path-guard";

/**
 * Local, read-only workbook reader. No network, no database, no writes.
 *
 * It extracts RAW tables (header text + cell values) per recognised tab. Header text and cell values stay
 * inside this module's return value for the validator to use; nothing here logs, and every finding is
 * value-free (findings.ts). Sheet names are matched to our tab names by normalised name, so "Routing SMV"
 * matches "Routing_SMV"; sheets that match nothing are only COUNTED.
 */

export interface RawTable {
  readonly tab: TabName;
  /** Raw header text per column (empty string for a blank header cell). INTERNAL: never put in a finding. */
  readonly headers: readonly string[];
  /** 1-based sheet row number per data row (parallel to `rows`). */
  readonly rowNumbers: readonly number[];
  readonly rows: readonly (readonly unknown[])[];
}

export interface ReadResult {
  readonly tables: Partial<Record<TabName, RawTable>>;
  readonly findings: readonly Finding[];
  /** Per-tab layout and row accounting (header row, title / note / trailing rows, derived values). */
  readonly layout: Partial<Record<TabName, TabLayoutReport>>;
}

const TAB_BY_NORMALISED: ReadonlyMap<string, TabName> = new Map(TAB_NAMES.map((t) => [normaliseHeader(t), t]));
const SUPPLEMENTARY: ReadonlySet<string> = new Set(SUPPLEMENTARY_SHEETS.map(normaliseHeader));

interface FlatCounters {
  formulaNoResult: number;
  errorCells: number;
  tooLong: number;
}

/**
 * Cell values: a formula cell yields its CACHED result; a formula with no cached result is `null`
 * (never recomputed or guessed), counted so the validator can warn. Rich text is flattened to its text,
 * a hyperlink to its display text, and an error cell (#N/A etc.) to `null`.
 */
export function flattenCell(value: unknown, counters: FlatCounters): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    const o = value as { result?: unknown; richText?: { text: string }[]; formula?: unknown; sharedFormula?: unknown; text?: unknown; error?: unknown };
    if ("error" in o && o.error !== undefined) {
      counters.errorCells++;
      return null;
    }
    if (o.richText) return flattenCell(o.richText.map((t) => t.text).join(""), counters);
    if (o.formula !== undefined || o.sharedFormula !== undefined) {
      if (o.result === undefined || o.result === null) {
        counters.formulaNoResult++;
        return null;
      }
      return flattenCell(o.result, counters);
    }
    if (typeof o.text === "string") return flattenCell(o.text, counters);
    return null;
  }
  if (typeof value === "string" && value.length > MAX_CSV_FIELD_LENGTH) {
    counters.tooLong++;
    return null;
  }
  return value;
}

export function readWorkbook(wb: ExcelJS.Workbook): ReadResult {
  const findings: Finding[] = [];
  const tables: Partial<Record<TabName, RawTable>> = {};
  const layout: Partial<Record<TabName, TabLayoutReport>> = {};
  let unknownTabs = 0;
  let supplementary = 0;
  const duplicateSheets: Partial<Record<TabName, number>> = {};

  for (const ws of wb.worksheets) {
    const key = normaliseHeader(ws.name);
    const tab = TAB_BY_NORMALISED.get(key);
    if (!tab) {
      if (SUPPLEMENTARY.has(key)) supplementary++;
      else unknownTabs++;
      continue;
    }
    if (tables[tab]) {
      // Two sheets normalising to the same expected tab name is ambiguous: report it (error) rather than silently
      // using the first. The first still wins for parsing so the rest of the report stays useful.
      duplicateSheets[tab] = (duplicateSheets[tab] ?? 0) + 1;
      continue;
    }

    const counters: FlatCounters = { formulaNoResult: 0, errorCells: 0, tooLong: 0 };
    let percentCells = 0;
    const grid: GridRow[] = [];
    let tooManyRows = false;
    let tooManyColumns = false;

    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (tooManyColumns) return;
      const width = (row.values as unknown[]).length - 1;
      if (width > MAX_CSV_COLUMNS) {
        tooManyColumns = true;
        return;
      }
      if (grid.length >= MAX_CSV_ROWS + 1) {
        tooManyRows = true;
        return;
      }
      const cells: unknown[] = [];
      for (let c = 1; c <= width; c++) {
        const cell = row.getCell(c);
        let v = flattenCell(cell.value, counters);
        // A cell FORMATTED as a percentage (0.0%, 0%) is read as it is displayed: 0.857 shown as 85.7% is 85.7. A bare
        // number in a General cell is never reinterpreted.
        if (typeof v === "number" && typeof cell.numFmt === "string" && cell.numFmt.includes("%")) {
          v = Math.round(v * 100 * 1e9) / 1e9;
          percentCells++;
        }
        cells.push(v);
      }
      if (cells.every((c) => c === null || (typeof c === "string" && c.trim() === ""))) return; // fully blank row
      grid.push({ rowNumber, cells });
    });

    if (tooManyColumns) findings.push(finding({ severity: "error", code: "too_many_columns", tab, count: 1 }));
    if (tooManyRows) findings.push(finding({ severity: "error", code: "too_many_rows", tab, count: 1 }));
    if (counters.tooLong > 0) findings.push(finding({ severity: "error", code: "cell_too_long", tab, count: counters.tooLong }));
    if (counters.formulaNoResult > 0) findings.push(finding({ severity: "warning", code: "formula_without_cached_result", tab, count: counters.formulaNoResult }));
    if (counters.errorCells > 0) findings.push(finding({ severity: "warning", code: "error_cell", tab, count: counters.errorCells }));
    if (percentCells > 0) findings.push(finding({ severity: "info", code: "percent_cells_read_as_points", tab, count: percentCells }));

    const extracted = extractTable(tab, tooManyColumns ? [] : grid);
    findings.push(...extracted.findings);
    tables[tab] = extracted.table;
    layout[tab] = extracted.report;
  }

  for (const tab of TAB_NAMES) {
    if (!tables[tab]) findings.push(finding({ severity: "error", code: "missing_tab", tab, count: 1 }));
    const dup = duplicateSheets[tab];
    if (dup) findings.push(finding({ severity: "error", code: "duplicate_sheet", tab, count: dup }));
  }
  if (supplementary > 0) findings.push(finding({ severity: "info", code: "supplementary_sheet", tab: null, count: supplementary }));
  if (unknownTabs > 0) findings.push(finding({ severity: "warning", code: "unknown_tab", tab: null, count: unknownTabs }));

  return { tables, findings, layout };
}

export interface FileReadResult extends ReadResult {
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** Reads a workbook from an in-memory buffer (used for synthetic round-trips and by the file reader). */
export async function readWorkbookBuffer(buffer: Buffer): Promise<ReadResult> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    // The underlying error text is deliberately discarded: it can echo file content.
    throw new RwtsaSafeError("not_a_workbook", "The file could not be opened as an .xlsx workbook.");
  }
  return readWorkbook(wb);
}

/**
 * Reads a protected workbook from disk. The path must be outside every git working tree (path-guard.ts).
 * Returns a content hash and size (never the file name) so a validation certificate can identify the file
 * without naming or exposing it.
 */
export async function readWorkbookFile(file: string): Promise<FileReadResult> {
  const real = assertWorkbookPathAllowed(file);
  const buffer = readFileSync(real);
  const result = await readWorkbookBuffer(buffer);
  return { ...result, sha256: createHash("sha256").update(buffer).digest("hex"), sizeBytes: buffer.length };
}
