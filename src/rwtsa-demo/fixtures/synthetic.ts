import ExcelJS from "exceljs";
import { SIZE_ORDER } from "@/rwtsa-demo/contracts/tabs";

/**
 * Deterministic SYNTHETIC workbook generator for tests and local development.
 *
 * Everything here is invented: names carry a `SYN-` prefix, quantities come from a seeded PRNG, and nothing is
 * derived from or resembles the advisor's protected workbook. The workbook is built in memory and never
 * committed. Same seed + options => identical workbook.
 *
 * It plants, and exposes in `planted`, the cases the engines and validators must handle (brief §4 and §5):
 *   - a one-off tender spike on one style (DP-06),
 *   - a tender / customer-order-only SKU carrying no min level (DP-16),
 *   - an overdue "on the water" PO whose ETA precedes the stock date,
 *   - two POs sharing one shipment, and a SKU present in two shipments (shipment-scoped freight),
 *   - a deposit plus balance payment under an FEC,
 *   - a size-varying BOM component (longer zip from 3XL),
 *   - production orders across order-size brackets and lines,
 *   - lost quotes with reasons.
 */

export interface SyntheticOptions {
  readonly seed?: number;
  /** 3 = two standard vests and one two-tone vest (the agreed demo scope); up to 6. */
  readonly styleCount?: 3 | 4 | 5 | 6;
  readonly shuffleColumns?: boolean;
  readonly shuffleRows?: boolean;
  /** Last month of sales history (`YYYY-MM`). Default "2026-08": history ends before the stock date, as in the brief. */
  readonly endMonth?: string;
}

export interface PlantedCases {
  readonly stockDate: string;
  readonly styles: readonly string[];
  readonly tenderSpike: { readonly styleCode: string; readonly month: string; readonly multipleOfMedianAtLeast: number };
  readonly tenderSku: string;
  readonly overduePoNo: string;
  readonly sharedShipmentRef: string;
  readonly sharedShipmentPoNos: readonly string[];
  readonly skuInTwoShipments: string;
  readonly depositPoNo: string;
  readonly sizeVaryingBom: { readonly styleCode: string; readonly componentCode: string; readonly sizeFrom: string };
  readonly lostQuoteCount: number;
}

export interface SyntheticWorkbook {
  readonly workbook: ExcelJS.Workbook;
  readonly planted: PlantedCases;
  readonly seed: number;
}

type Cell = string | number | boolean | Date | null;
interface Table {
  headers: string[];
  rows: Cell[][];
}

const STOCK_DATE = "2026-10-31";
const STYLE_CODES = ["SYN-VEST-A", "SYN-VEST-B", "SYN-VEST-TT", "SYN-VEST-C", "SYN-VEST-D", "SYN-VEST-TT2"] as const;
const SIZE_WEIGHT = [0.5, 1.2, 1.6, 1.4, 1.0, 0.6, 0.3, 0.15];
const STYLE_BASE = [60, 45, 30, 40, 35, 25];
/** The synthetic size curve (units per size, relative). Real size curves are supplied separately and are not in the workbook. */
export const SYNTHETIC_SIZE_CURVE: Readonly<Record<string, number>> = Object.fromEntries(SIZE_ORDER.map((sz, i) => [sz, SIZE_WEIGHT[i]]));
/** Units on the (style-level) purchase order for the spike style; its size split uses SIZE_WEIGHT. */
const SPIKE_PO_QTY = 900;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function monthsEndingAt(end: string, count: number): string[] {
  const [y, m] = end.split("-").map(Number);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const idx = y * 12 + (m - 1) - i;
    out.push(`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const utc = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

export function buildSyntheticWorkbook(opts: SyntheticOptions = {}): SyntheticWorkbook {
  const seed = opts.seed ?? 20261031;
  const rand = mulberry32(seed);
  const styleCount = opts.styleCount ?? 3;
  const styles = STYLE_CODES.slice(0, styleCount);
  const months = monthsEndingAt(opts.endMonth ?? "2026-08", 36);
  const randInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

  const skuOf = (style: string, size: string) => `${style}-${size}`;
  const allSkus = styles.flatMap((st) => SIZE_ORDER.map((sz) => ({ style: st, size: sz, sku: skuOf(st, sz) })));
  const tenderSku = skuOf(styles[styles.length - 1], "5XL");

  // --- SalesHistory (and per-SKU medians, used to size the planted spike) ---
  const spikeStyle = styles[1];
  // Inside the default six-month demand window (the last six history months), so the spike distorts the forecast until the planner excludes it.
  const SPIKE_INDEX = months.length - 3;
  const spikeMonth = months[SPIKE_INDEX];
  const cleanAvg6 = new Map<string, number>();
  const salesRows: Cell[][] = [];
  for (const [si, st] of styles.entries()) {
    for (const [zi, sz] of SIZE_ORDER.entries()) {
      const base = STYLE_BASE[si] * SIZE_WEIGHT[zi];
      const series = months.map((_, mi) => Math.max(1, Math.round(base * (0.8 + 0.4 * rand()) * (1 + 0.2 * Math.sin(mi / 2)))));
      if (st === spikeStyle) {
        const med = median(series);
        cleanAvg6.set(skuOf(st, sz), series.slice(-6).reduce((a, b) => a + b, 0) / 6);
        series[SPIKE_INDEX] = Math.round(med * 12 + 60);
      }
      const last6 = series.slice(-6);
      const last12 = series.slice(-12);
      const avg = (a: number[]) => Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 100) / 100;
      salesRows.push([skuOf(st, sz), ...series, avg(last6), avg(last12)]);
    }
  }
  const sales: Table = { headers: ["SKU", ...months, "6 month average", "12 month average"], rows: salesRows };

  // --- Items ---
  const items: Table = {
    headers: ["SKU", "Style code", "Description", "Production code", "Fabric", "Colour", "Size", "Source", "Unit", "Min level", "Reorder point", "Standard cost", "Standard sell price", "Tender"],
    rows: allSkus.map(({ style, size, sku }, i) => {
      const si = styles.indexOf(style);
      const zi = SIZE_ORDER.indexOf(size as (typeof SIZE_ORDER)[number]);
      const cost = 100 + si * 10 + zi * 2;
      const isTender = sku === tenderSku;
      const minLevel = isTender ? null : Math.max(5, Math.round(STYLE_BASE[si] * SIZE_WEIGHT[zi] * 0.8));
      return [sku, style, `Synthetic vest ${style} ${size}`, `PC-${i}`, "SYN-FABRIC", si === 2 ? "Orange/Navy" : "Orange", size, "Import", "ea", minLevel, minLevel === null ? null : minLevel * 2, cost, Math.round(cost * 1.6 * 100) / 100, isTender];
    }),
  };

  // --- Stock (Available column is consistent with the brief's formula) ---
  const stock: Table = {
    headers: ["SKU", "Style code", "Colour", "Size", "JHB", "Durban", "Cape Town", "Bond", "Factory store", "In transit", "Committed", "Available"],
    rows: allSkus.map(({ style, size, sku }) => {
      const jhb = randInt(20, 400);
      const durban = randInt(0, 150);
      const capeTown = randInt(0, 120);
      const bond = randInt(0, 200);
      const factory = randInt(0, 80);
      const inTransit = randInt(0, 300);
      const committed = randInt(0, 150);
      const clean = cleanAvg6.get(sku);
      if (clean !== undefined) {
        // Spike style: stock is sized so the clean (spike-excluded) demand never breaches the minimum over 13 weeks, but the
        // spike-inflated forecast does. That is the "false stock-out" the planner removes by excluding the tender month.
        const zi = SIZE_ORDER.indexOf(size as (typeof SIZE_ORDER)[number]);
        const minLevel = Math.max(5, Math.round(STYLE_BASE[styles.indexOf(style)] * SIZE_WEIGHT[zi] * 0.8));
        const clean13 = (clean / 4.345) * 13;
        const inboundShare = (SPIKE_PO_QTY * SIZE_WEIGHT[zi]) / SIZE_WEIGHT.reduce((a, b) => a + b, 0);
        const needed = Math.max(0, Math.ceil(minLevel + clean13 * 1.5 - inboundShare));
        return [sku, style, "Orange", size, needed, 0, 0, bond, 0, inTransit, 0, needed];
      }
      return [sku, style, "Orange", size, jhb, durban, capeTown, bond, factory, inTransit, committed, jhb + durban + capeTown + factory - committed];
    }),
  };

  // --- ImportPOs (quantities by style; size split comes from a separate size curve, not in the workbook) ---
  const poRows: Cell[][] = [];
  const poFor = (n: number, style: string, qty: number, etaStores: string, status: string, ship: string) =>
    poRows.push([`PO-SYN-${String(n).padStart(3, "0")}`, "SYN Supplier Ltd", "Synthetica", "USD", "FOB", null, style, qty, 4.5 + n * 0.1, utc("2026-08-15"), utc("2026-10-01"), utc(etaStores), status, "No", ship]);
  poFor(1, styles[0], 1200, "2026-10-10", "On the water", "SHIP-SYN-1"); // overdue: ETA precedes the stock date, still on the water
  poFor(2, styles[1], SPIKE_PO_QTY, "2026-11-20", "On the water", "SHIP-SYN-1");
  poFor(3, styles[2], 700, "2026-12-15", "On order", "SHIP-SYN-2");
  poFor(4, styles[0], 1500, "2027-01-30", "On order", "SHIP-SYN-2");
  const importPos: Table = {
    headers: ["PO no", "Supplier", "Country", "Currency", "Incoterm", "SKU", "Style code", "Qty", "Unit price USD", "ETD", "ETA port", "ETA stores", "Status", "Bond on arrival", "Shipment"],
    rows: poRows,
  };

  // --- BOM: one per style, with a size-varying zip (longer from 3XL) ---
  const bomRows: Cell[][] = [];
  for (const [si, st] of styles.entries()) {
    bomRows.push([st, "FABRIC-REFL", "Reflective fabric", "Material", 1.2, "m", 55, null, null]);
    if (si === 2) bomRows.push([st, "FABRIC-NAVY", "Contrast fabric", "Material", 0.4, "m", 48, null, null]);
    bomRows.push([st, "ZIP-SHORT", "Zip (short)", "Trim", 1, "ea", 6, null, null]);
    bomRows.push([st, "ZIP-LONG", "Zip (long)", "Trim", 1, "ea", 8.5, null, "3XL"]);
    bomRows.push([st, "THREAD", "Thread", "Thread", 1, "set", 3, null, null]);
    bomRows.push([st, "PRINT", "Print", "Print", 1, "ea", 4, null, null]);
    bomRows.push([st, "PACK", "Packaging", "Packaging", 1, "ea", 2.5, null, null]);
  }
  const bom: Table = { headers: ["Style code", "Component code", "Component name", "Component type", "Qty per unit", "Unit", "Unit cost", "Size", "Size from"], rows: bomRows };

  // --- Routing_SMV ---
  const routingRows: Cell[][] = [];
  for (const st of styles) {
    routingRows.push([st, "Cut", 3.5, 1.5, 0.1, 0.85, 0.2], [st, "Sew", 11, 1.5, 0.1, 0.85, 0.2], [st, "Trim and pack", 2.5, 1.5, 0.1, 0.85, 0.2]);
  }
  const routing: Table = { headers: ["Style code", "Operation", "SMV", "Cost per minute", "Overhead", "Efficiency", "Margin"], rows: routingRows };

  // --- ProductionOrders: order sizes spread across brackets, two lines ---
  const orderQtys = [50, 80, 120, 200, 300, 450, 800, 1200, 1500, 2000, 2500, 3000];
  const prodRows: Cell[][] = orderQtys.map((qty, i) => {
    const smv = 17;
    const planned = qty * smv;
    const recovery = 0.7 + Math.min(0.28, qty / 12000); // short runs recover less
    const actual = Math.round(planned / recovery);
    const plannedFabric = Math.round(qty * 1.2 * 100) / 100;
    const actualFabric = Math.round(plannedFabric * (1 + (rand() * 0.08 - 0.01)) * 100) / 100;
    return [`MO-SYN-${String(i + 1).padStart(3, "0")}`, styles[i % styles.length], qty, smv, planned, actual, plannedFabric, actualFabric, 55, 55 + Math.round((rand() * 6 - 1) * 100) / 100, null, null, null, i % 2 ? "Line 2" : "Line 1"];
  });
  const productionOrders: Table = {
    headers: ["Order", "Style code", "Qty", "Planned SMV", "Planned minutes", "Actual minutes", "Planned fabric (m)", "Actual fabric (m)", "Planned price", "Actual price", "Labour recovery %", "Usage variance", "Price variance", "Production line"],
    rows: prodRows,
  };

  // --- LandedCost: two shipments; one SKU appears in BOTH ---
  const sharedSku = skuOf(styles[0], "M");
  const landedRows: Cell[][] = [
    ["SHIP-SYN-1", skuOf(styles[0], "M"), 300, 1500, 18.0, 18.6, 120, 4.2, 9000, null],
    ["SHIP-SYN-1", skuOf(styles[1], "L"), 450, 2250, 18.0, 18.6, 180, 6.3, 9000, null],
    ["SHIP-SYN-1", skuOf(styles[0], "XL"), 150, 750, 18.0, 18.6, 60, 2.1, 9000, null],
    ["SHIP-SYN-2", sharedSku, 200, 1000, 18.2, 18.9, 80, 2.8, 6000, null],
    ["SHIP-SYN-2", skuOf(styles[2], "L"), 350, 1750, 18.2, 18.9, 140, 4.9, 6000, null],
  ];
  const landedCost: Table = {
    headers: ["Shipment", "SKU", "Qty", "FOB USD", "Planning FX", "Customs FX", "Duty", "CBM", "Freight", "Freight allocated"],
    rows: landedRows,
  };

  // --- Payments_FEC: a deposit plus balance under one FEC ---
  const payments: Table = {
    headers: ["PO no", "Supplier", "Shipment date", "Terms (days)", "Due date", "USD amount", "FEC reference", "Locked rate", "ZAR value", "Deposit"],
    rows: [
      ["PO-SYN-001", "SYN Supplier Ltd", utc("2026-08-15"), 0, utc("2026-08-01"), 5400, "FEC-SYN-1", 18.1, 97740, true],
      ["PO-SYN-001", "SYN Supplier Ltd", utc("2026-08-15"), 30, utc("2026-09-14"), 5400, "FEC-SYN-1", 18.1, 97740, false],
      ["PO-SYN-002", "SYN Supplier Ltd", utc("2026-09-20"), 60, utc("2026-11-19"), 4050, "FEC-SYN-2", 18.3, 74115, false],
      ["PO-SYN-003", "SYN Supplier Ltd", utc("2026-11-10"), 30, utc("2026-12-10"), 3150, null, null, null, false],
      ["PO-SYN-004", "SYN Supplier Ltd", utc("2026-12-20"), 30, utc("2027-01-19"), 6750, null, null, null, false],
    ],
  };

  // --- Customers and Quotes ---
  const reps = ["Rep One", "Rep Two", "Rep Three"];
  const customers: Table = {
    headers: ["Customer", "Contact", "Rep"],
    rows: Array.from({ length: 5 }, (_, i) => [`SYN Customer ${i + 1}`, `Contact ${i + 1}`, reps[i % 3]]),
  };
  const statuses = ["won", "lost", "open", "won", "lost", "won", "open", "lost", "won", "lost", "won", "open"];
  const reasons = ["Price", "Lead time", "Competitor"];
  let lost = 0;
  const quotes: Table = {
    headers: ["Quote", "Customer", "Rep", "Status", "Value", "Lost reason", "Converted order", "Quote date", "Product"],
    rows: statuses.map((s, i) => {
      if (s === "lost") lost++;
      return [`Q-SYN-${String(i + 1).padStart(3, "0")}`, `SYN Customer ${(i % 5) + 1}`, reps[i % 3], s, 10000 + i * 2500, s === "lost" ? reasons[lost % 3] : null, s === "won" ? `SO-SYN-${String(i + 1).padStart(4, "0")}` : null, utc(`2026-0${(i % 9) + 1}-15`), styles[i % styles.length]];
    }),
  };

  // --- Assemble (optionally shuffling columns and rows, seeded) ---
  const shuffle = <T,>(arr: T[]): T[] => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const wb = new ExcelJS.Workbook();
  const add = (name: string, t: Table) => {
    const order = t.headers.map((_, i) => i);
    const cols = opts.shuffleColumns ? shuffle(order) : order;
    const rows = opts.shuffleRows ? shuffle(t.rows) : t.rows;
    const ws = wb.addWorksheet(name);
    ws.addRow(cols.map((c) => t.headers[c]));
    for (const r of rows) ws.addRow(cols.map((c) => r[c]));
  };
  add("Items", items);
  add("SalesHistory", sales);
  add("Stock", stock);
  add("ImportPOs", importPos);
  add("BOM", bom);
  add("Routing_SMV", routing);
  add("ProductionOrders", productionOrders);
  add("LandedCost", landedCost);
  add("Payments_FEC", payments);
  add("Customers", customers);
  add("Quotes", quotes);

  return {
    workbook: wb,
    seed,
    planted: {
      stockDate: STOCK_DATE,
      styles,
      tenderSpike: { styleCode: spikeStyle, month: spikeMonth, multipleOfMedianAtLeast: 8 },
      tenderSku,
      overduePoNo: "PO-SYN-001",
      sharedShipmentRef: "SHIP-SYN-1",
      sharedShipmentPoNos: ["PO-SYN-001", "PO-SYN-002"],
      skuInTwoShipments: sharedSku,
      depositPoNo: "PO-SYN-001",
      sizeVaryingBom: { styleCode: styles[0], componentCode: "ZIP-LONG", sizeFrom: "3XL" },
      lostQuoteCount: statuses.filter((s) => s === "lost").length,
    },
  };
}

/** Writes the synthetic workbook to an in-memory .xlsx buffer (used to exercise the real file-reading path). */
export async function syntheticBuffer(opts: SyntheticOptions = {}): Promise<{ buffer: Buffer; planted: PlantedCases; seed: number }> {
  const s = buildSyntheticWorkbook(opts);
  const buffer = Buffer.from(await s.workbook.xlsx.writeBuffer());
  return { buffer, planted: s.planted, seed: s.seed };
}
