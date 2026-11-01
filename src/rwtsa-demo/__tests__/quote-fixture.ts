import type { CustomerRow, ItemRow, QuoteRow } from "@/rwtsa-demo/contracts/tabs";
import type { RwtsaDataset } from "@/rwtsa-demo/dataset";
import { makeDataset } from "./engine-fixture";

/** Hand-built SYNTHETIC quote datasets: small numbers that can be checked by hand. No workbook is read. */

export interface QSpec {
  no: string;
  customer?: string;
  rep?: string | null;
  status: string;
  value?: number;
  reason?: string | null;
  so?: string | null;
  date?: string | null;
  product?: string | null;
}

export function quoteDataset(specs: QSpec[], o: { customers?: { customer: string; rep?: string | null }[]; styles?: string[] } = {}): RwtsaDataset {
  const base = makeDataset({ skus: [] });
  const quotes: QuoteRow[] = specs.map((s) => ({
    quoteNo: s.no,
    customer: s.customer ?? "C1",
    rep: s.rep === undefined ? "R1" : s.rep,
    status: s.status,
    value: s.value === undefined ? 1000 : s.value,
    lostReason: s.reason ?? null,
    convertedOrder: s.so ?? null,
    quoteDate: s.date === undefined ? "2026-01-15" : s.date,
    product: s.product ?? null,
  }));
  const customers: CustomerRow[] = (o.customers ?? []).map((c) => ({ customer: c.customer, contact: null, rep: c.rep ?? null }));
  const items: ItemRow[] = (o.styles ?? []).map((st) => ({
    sku: `${st}-M`, styleCode: st, description: null, productionCode: null, fabric: null, colour: null, size: "M", source: "Local", unit: null,
    minLevel: null, reorderPoint: null, standardCost: 1, standardSellPrice: null, isTender: false,
  }));
  return { ...base, tables: { ...base.tables, quotes, customers, items } };
}

/**
 * The hand-checked reference set (see engine-quotes.test.ts for the arithmetic):
 *  Q1 won  C1 R1 1,000.00 SO-1       2026-01-10 P1
 *  Q2 won  C2 R1 2,000.50 So-2/b     2026-01-20 P1
 *  Q3 lost C1 R2 1,500.00 "Price"    2026-02-05 P2
 *  Q4 lost C2 R2   500.25 "price "   2026-02-15 P1;P2 (two products)
 *  Q5 open C3 R2 3,000.00            2026-03-01 P2
 *  Q6 "Pending review" (unrecognised) C3 R1 700.00 2026-03-02 P1
 */
export const REFERENCE: QSpec[] = [
  { no: "Q1", customer: "C1", rep: "R1", status: "won", value: 1000, so: "SO-1", date: "2026-01-10", product: "P1" },
  { no: "Q2", customer: "C2", rep: "R1", status: "Won", value: 2000.5, so: "So-2/b", date: "2026-01-20", product: "P1" },
  { no: "Q3", customer: "C1", rep: "R2", status: "lost", value: 1500, reason: "Price", date: "2026-02-05", product: "P2" },
  { no: "Q4", customer: "C2", rep: "R2", status: "LOST", value: 500.25, reason: "price ", date: "2026-02-15", product: "P1;P2" },
  { no: "Q5", customer: "C3", rep: "R2", status: "open", value: 3000, date: "2026-03-01", product: "P2" },
  { no: "Q6", customer: "C3", rep: "R1", status: "Pending review", value: 700, date: "2026-03-02", product: "P1" },
];
