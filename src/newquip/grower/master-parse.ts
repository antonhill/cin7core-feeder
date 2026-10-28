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
  /** SKUs present in the workbook whose price cells are blank / uncached: recorded as zero, i.e. SUPPLIER QUOTE REQUIRED — never guessed. */
  unpriced: string[];
  /** SKUs that appear more than once; the FIRST row wins. */
  duplicates: string[];
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
  // Strict: text that is not a number is NaN and rejected below. A genuinely BLANK cell (or a formula with no cached result) is
  // `null`: the row is then "unpriced" and recorded as zero => supplier-quote-required, never a guessed price.
  const num = (v: unknown): number | null => {
    if (typeof v === "number") return v;
    if (v == null || v === "") return null;
    const t = String(v).trim().replace(/[\sR,]/g, "");
    return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
  };
  const entries: Record<string, SnapshotEntry> = {};
  const unpriced: string[] = [];
  const duplicates: string[] = [];
  for (const r of rows.slice(headerIdx + 1)) {
    const sku = String(r[col.sku] ?? "").trim();
    if (!sku || !wanted.has(sku)) continue;
    if (entries[sku]) { duplicates.push(sku); continue; }
    const f = [r[col.cost], r[col.roe], r[col.freight], r[col.mu], r[col.retail]].map(num);
    if (f.some((x) => x !== null && Number.isNaN(x))) throw new Error(`Master workbook: ${sku} has a non-numeric Cost/ROE/Freight/MU/Retail value.`);
    // Unpriced = no usable cost or retail. Nothing is invented: the whole row becomes zero.
    const blank = f[0] === null || f[4] === null;
    if (blank) unpriced.push(sku);
    const [cost, roe, freight, mu, retail] = blank ? [0, f[1] ?? 0, f[2] ?? 0, f[3] ?? 0, 0] : (f as number[]);
    entries[sku] = { sku, description: col.desc >= 0 ? String(r[col.desc] ?? "").trim() : "", cost, roe, freight, mu, retailExVat: retail };
  }
  return { entries, missing: [...wanted].filter((x) => !entries[x]), unpriced, duplicates, rowsRead: rows.length - headerIdx - 1 };
}
