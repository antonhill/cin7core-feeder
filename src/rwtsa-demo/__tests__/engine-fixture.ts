import type { ImportPoRow, ItemRow, StockFileRow } from "@/rwtsa-demo/contracts/tabs";
import type { RwtsaDataset, SalesPoint, StockRow } from "@/rwtsa-demo/dataset";

/**
 * Hand-built SYNTHETIC datasets for the Red Flag engine tests: small numbers that can be checked by hand. No workbook is read.
 */

export const MONTHS_6 = ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];

export interface SkuSpec {
  sku: string;
  style?: string;
  size?: string;
  minLevel?: number | null;
  tender?: boolean | null;
  jhb?: number;
  durban?: number;
  capeTown?: number;
  factory?: number;
  bond?: number;
  inTransit?: number;
  committed?: number;
  /** The file's own Available column; default = the brief's formula. */
  reportedAvailable?: number | null;
  /** One value per month in `months` (null = blank cell). */
  sales: (number | null)[];
}

export interface PoSpec {
  poNo: string;
  sku?: string | null;
  style?: string | null;
  qty: number;
  etaStores: string;
  status: string;
}

export function makeDataset(opts: { months?: string[]; skus: SkuSpec[]; pos?: PoSpec[] }): RwtsaDataset {
  const months = opts.months ?? MONTHS_6;
  const items: ItemRow[] = [];
  const stock: StockRow[] = [];
  const salesHistory: SalesPoint[] = [];
  for (const s of opts.skus) {
    const style = s.style ?? "ST";
    const size = s.size ?? "M";
    items.push({
      sku: s.sku, styleCode: style, description: null, productionCode: null, fabric: null, colour: null, size, source: "Import", unit: null,
      minLevel: s.minLevel === undefined ? 10 : s.minLevel, reorderPoint: null, standardCost: 1, standardSellPrice: null, isTender: s.tender ?? false,
    });
    const jhb = s.jhb ?? 0, durban = s.durban ?? 0, capeTown = s.capeTown ?? 0, factoryStore = s.factory ?? 0, committed = s.committed ?? 0;
    const computed = jhb + durban + capeTown + factoryStore - committed;
    const row: StockFileRow = {
      sku: s.sku, styleCode: style, colour: null, size, jhb, durban, capeTown, bond: s.bond ?? 0, factoryStore, inTransit: s.inTransit ?? 0, committed,
      available: s.reportedAvailable === undefined ? computed : s.reportedAvailable,
    };
    stock.push({ ...row, availableComputed: computed });
    s.sales.forEach((qty, i) => salesHistory.push({ sku: s.sku, month: months[i], qty }));
  }
  const importPos: ImportPoRow[] = (opts.pos ?? []).map((p) => ({
    poNo: p.poNo, supplier: "SYN", country: null, currency: null, incoterm: null, sku: p.sku ?? null, styleCode: p.style ?? null, qty: p.qty, unitPriceUsd: 1,
    etd: null, etaPort: "2026-01-01", etaStores: p.etaStores, status: p.status, bondOnArrival: null, shipmentRef: null,
  }));
  return {
    schemaVersion: 1,
    provenance: "synthetic",
    source: { label: "synthetic:test" },
    months,
    tables: { items, salesHistory, salesFileAverages: [], stock, importPos, bom: [], routing: [], productionOrders: [], landedCost: [], paymentsFec: [], customers: [], quotes: [] },
    reconciliation: { rowCounts: {}, months: { first: months[0] ?? null, last: months[months.length - 1] ?? null, count: months.length }, unitsByStyle: {}, totals: {} as never, controlHash: "test" },
    readiness: [],
    findings: [],
  };
}
