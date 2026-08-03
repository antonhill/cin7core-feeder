/**
 * Stocktake Assistant — takes a Cin7 stocktake export CSV (one row per
 * Product Code x Bin) and surfaces the stock currently picked/packed for
 * open sales orders at that stocktake's location, so a physical count
 * doesn't understate what Cin7 still carries as on-hand there.
 *
 * Cin7's Sale Fulfilment pick/pack data has no Bin field at all (confirmed
 * live 2026-07-09, see migration 0034) — only Location. The uploaded CSV,
 * by contrast, splits the same product across several Bin-specific rows.
 * Per Anton's explicit call, this tool never guesses which Bin row a
 * location-level quantity belongs to: every original row passes through
 * completely untouched, and confirmed picked/packed quantities are
 * appended as brand-new, clearly-flagged rows for a human to place.
 */

import Papa from "papaparse";
import { toCsv } from "@/export/csv-format";
import type { StocktakeStagedStockRow } from "@/reports/query";

export const STOCKTAKE_HEADER = [
  "Product Code",
  "Product Name",
  "Bin",
  "Unit",
  "BatchSN",
  "ExpiryDate_YYYYMMDD",
  "Quantity On Hand",
  "Stocktake Quantity",
] as const;

/** A row exactly as read from the uploaded file — kept as plain strings so every original value round-trips out unchanged. */
export type StocktakeRow = Record<(typeof STOCKTAKE_HEADER)[number], string>;

export interface ParseStocktakeFileResult {
  rows: StocktakeRow[];
  /** Set when the file doesn't look like a Cin7 stocktake export at all (missing a required column) — rows is empty in that case. */
  error: string | null;
}

/** Parses the uploaded CSV, requiring at minimum a "Product Code" column (the match key) and a "Stocktake Quantity" column (what Cin7 imports back) — the other columns are optional so a partially-stripped export still works, defaulting to "". */
export function parseStocktakeFile(csvText: string): ParseStocktakeFileResult {
  const { data, errors, meta } = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: "greedy",
    dynamicTyping: false,
  });

  const fatalErrors = errors.filter((e) => e.type !== "FieldMismatch");
  if (fatalErrors.length) {
    return { rows: [], error: `CSV parse error: ${fatalErrors.map((e) => e.message).join("; ")}` };
  }

  const fields = new Set(meta.fields ?? []);
  if (!fields.has("Product Code") || !fields.has("Stocktake Quantity")) {
    return { rows: [], error: 'File must have "Product Code" and "Stocktake Quantity" columns — is this a Cin7 stocktake export?' };
  }

  const rows: StocktakeRow[] = data
    .filter((raw) => (raw["Product Code"] ?? "").trim() !== "")
    .map((raw) => {
      const row = {} as StocktakeRow;
      for (const col of STOCKTAKE_HEADER) row[col] = raw[col] ?? "";
      return row;
    });

  return { rows, error: null };
}

export type StocktakeStage = "pick" | "pack";

export interface ConfirmationLine {
  productSku: string;
  productName: string | null;
  stage: StocktakeStage;
  quantity: number;
  checked: boolean;
}

/** One confirmation line per (SKU, stage) with a nonzero quantity, default-checked — the shape the UI's checkbox table + bulk skip-all-Picked/Packed filters operate on. */
export function buildConfirmationLines(staged: StocktakeStagedStockRow[]): ConfirmationLine[] {
  const lines: ConfirmationLine[] = [];
  for (const s of staged) {
    if (s.picked_qty > 0) lines.push({ productSku: s.product_sku, productName: s.product_name, stage: "pick", quantity: s.picked_qty, checked: true });
    if (s.packed_qty > 0) lines.push({ productSku: s.product_sku, productName: s.product_name, stage: "pack", quantity: s.packed_qty, checked: true });
  }
  return lines;
}

/** Pure bulk-toggle helper — sets `checked` on every line matching `stage` (or every line if stage is omitted), leaving the rest untouched. Powers "Skip all Picked" / "Skip all Packed" / "Recheck all". */
export function setBulkChecked(lines: ConfirmationLine[], checked: boolean, stage?: StocktakeStage): ConfirmationLine[] {
  return lines.map((l) => (stage === undefined || l.stage === stage ? { ...l, checked } : l));
}

const PLACE_MANUALLY_PREFIX = "[PICKED/PACKED - PLACE MANUALLY] ";

export interface MergeStocktakeResult {
  rows: StocktakeRow[];
  /** How many new reference rows were appended (one per SKU with a nonzero confirmed total). */
  appendedCount: number;
}

/**
 * Every original row passes through byte-for-byte unchanged (per Anton's
 * explicit call — no auto-placement into a specific Bin row). For each SKU
 * with at least one checked confirmation line, appends one new row summing
 * every checked quantity for that SKU (picked + packed combined), with Bin/
 * Unit/BatchSN/ExpiryDate/Quantity On Hand left blank since none of those
 * are known at the location level — only Stocktake Quantity is set, and
 * Product Name is prefixed so the row is unmistakable as a manual-placement
 * reference rather than a real physical count.
 */
export function mergeStocktakeFile(originalRows: StocktakeRow[], confirmationLines: ConfirmationLine[]): MergeStocktakeResult {
  const totalsBySku = new Map<string, { productName: string | null; quantity: number }>();
  for (const line of confirmationLines) {
    if (!line.checked || line.quantity <= 0) continue;
    const existing = totalsBySku.get(line.productSku);
    totalsBySku.set(line.productSku, {
      productName: existing?.productName ?? line.productName,
      quantity: (existing?.quantity ?? 0) + line.quantity,
    });
  }

  const appended: StocktakeRow[] = [];
  for (const [sku, { productName, quantity }] of totalsBySku) {
    if (quantity <= 0) continue;
    appended.push({
      "Product Code": sku,
      "Product Name": PLACE_MANUALLY_PREFIX + (productName ?? ""),
      Bin: "",
      Unit: "",
      BatchSN: "",
      ExpiryDate_YYYYMMDD: "",
      "Quantity On Hand": "",
      "Stocktake Quantity": String(quantity),
    });
  }

  return { rows: [...originalRows, ...appended], appendedCount: appended.length };
}

/** Serializes back to Cin7's fixed 8-column stocktake import order, regardless of the uploaded file's original column order. */
export function buildStocktakeCsv(rows: StocktakeRow[]): string {
  const dataRows = rows.map((row) => STOCKTAKE_HEADER.map((col) => row[col]));
  return toCsv([[...STOCKTAKE_HEADER], ...dataRows]);
}
