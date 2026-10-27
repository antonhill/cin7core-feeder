import type { SnapshotEntry } from "./workbook-price-source";

// Pure parser for the NewQuip Master workbook rows → controlled snapshot entries. Kept free of file I/O so it is testable;
// scripts/newquip-build-price-snapshot.ts reads the .xlsx and hands the cell grid here. Only the SKUs the POC needs are kept.
//
// Header detection is by NAME, never by column position: a header row must contain a SKU/code column plus Cost, ROE,
// Freight, MU and Retail Price ex VAT columns. Anything else is rejected rather than guessed.

const norm = (v: unknown): string => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const COLS: Record<keyof Omit<SnapshotEntry, "description">, (h: string) => boolean> = {
  sku: (h) => h === "sku" || h === "code" || h === "product code" || h === "item code",
  cost: (h) => h === "cost" || h === "unit cost" || h === "supplier cost",
  roe: (h) => h === "roe" || h === "exchange rate",
  freight: (h) => h === "freight" || h === "freight factor",
  mu: (h) => h === "mu" || h === "markup" || h === "mark up" || h === "markup factor",
  retailExVat: (h) => /^retail( price)?( ex vat| excl vat| excl)?$/.test(h) || h === "retail price ex vat",
};
const DESC = (h: string) => h === "description" || h === "name" || h === "product name" || h === "product";

export interface ParseResult {
  entries: Record<string, SnapshotEntry>;
  missing: string[];
  rowsRead: number;
}

export function parseMasterRows(rows: unknown[][], wantedSkus: readonly string[]): ParseResult {
  const wanted = new Set(wantedSkus);
  const headerIdx = rows.findIndex((r) => {
    const hs = r.map(norm);
    return (Object.values(COLS) as ((h: string) => boolean)[]).every((test) => hs.some(test));
  });
  if (headerIdx < 0) throw new Error("Master workbook: no header row with SKU, Cost, ROE, Freight, MU and Retail Price ex VAT columns.");
  const hs = rows[headerIdx].map(norm);
  const at = (test: (h: string) => boolean) => hs.findIndex(test);
  const col = {
    sku: at(COLS.sku), cost: at(COLS.cost), roe: at(COLS.roe), freight: at(COLS.freight), mu: at(COLS.mu), retail: at(COLS.retailExVat), desc: at(DESC),
  };
  // Strict: a blank or non-numeric cell is NaN (rejected below) — it is never quietly read as 0.
  const num = (v: unknown): number => {
    if (typeof v === "number") return v;
    const t = String(v ?? "").trim().replace(/[\sR,]/g, "");
    return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
  };
  const entries: Record<string, SnapshotEntry> = {};
  for (const r of rows.slice(headerIdx + 1)) {
    const sku = String(r[col.sku] ?? "").trim();
    if (!sku || !wanted.has(sku)) continue;
    const e: SnapshotEntry = {
      sku,
      description: col.desc >= 0 ? String(r[col.desc] ?? "").trim() : "",
      cost: num(r[col.cost]), roe: num(r[col.roe]), freight: num(r[col.freight]), mu: num(r[col.mu]), retailExVat: num(r[col.retail]),
    };
    if (![e.cost, e.roe, e.freight, e.mu, e.retailExVat].every(Number.isFinite)) throw new Error(`Master workbook: ${sku} has a non-numeric Cost/ROE/Freight/MU/Retail value.`);
    entries[sku] = e;
  }
  return { entries, missing: [...wanted].filter((s) => !entries[s]), rowsRead: rows.length - headerIdx - 1 };
}
