import { createHash } from "node:crypto";
import type { Reconciliation, RwtsaDataset, StyleControlTotals } from "@/rwtsa-demo/dataset";

/**
 * Deterministic control totals and a canonical content hash. Pure and order-independent: the same data in a
 * different row or column order yields the same totals and the same `controlHash`.
 *
 * The totals are derived values for the owner to compare against the advisor's own figures LOCALLY. They are
 * never logged by this code; the validate script writes them to a local file only when explicitly asked.
 */

type Tables = RwtsaDataset["tables"];

/** The brief's Available (§4): JHB + Durban + Cape Town + Factory store - Committed. Bond and In transit are excluded. */
export function computeAvailable(s: { jhb: number; durban: number; capeTown: number; factoryStore: number; committed: number }): number {
  return s.jhb + s.durban + s.capeTown + s.factoryStore - s.committed;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalRows(rows: readonly object[]): string[] {
  return rows.map((r) => stableStringify(r)).sort();
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

function emptyTotals(): { -readonly [K in keyof StyleControlTotals]: StyleControlTotals[K] } {
  return { skuCount: 0, availableUnits: 0, committedUnits: 0, inTransitUnits: 0, bondUnits: 0, salesLast6Months: 0, salesLast12Months: 0, salesAllMonths: 0, salesMissingObservations: 0, importPoQty: 0 };
}

export function reconcile(tables: Tables, months: readonly string[]): Reconciliation {
  const styleBySku = new Map(tables.items.map((i) => [i.sku, i.styleCode]));
  const byStyle = new Map<string, ReturnType<typeof emptyTotals>>();
  const bucket = (style: string) => {
    let b = byStyle.get(style);
    if (!b) byStyle.set(style, (b = emptyTotals()));
    return b;
  };

  for (const i of tables.items) bucket(i.styleCode).skuCount++;
  for (const s of tables.stock) {
    const style = styleBySku.get(s.sku);
    if (!style) continue;
    const b = bucket(style);
    b.availableUnits += s.availableComputed;
    b.committedUnits += s.committed;
    b.inTransitUnits += s.inTransit;
    b.bondUnits += s.bond;
  }

  const last6 = new Set(months.slice(-6));
  const last12 = new Set(months.slice(-12));
  for (const p of tables.salesHistory) {
    const style = styleBySku.get(p.sku);
    if (!style) continue;
    const b = bucket(style);
    if (p.qty === null) {
      b.salesMissingObservations++; // a missing observation contributes nothing to any sum and is never treated as 0
      continue;
    }
    b.salesAllMonths += p.qty;
    if (last6.has(p.month)) b.salesLast6Months += p.qty;
    if (last12.has(p.month)) b.salesLast12Months += p.qty;
  }
  for (const po of tables.importPos) {
    const style = po.styleCode ?? (po.sku ? styleBySku.get(po.sku) : undefined);
    if (style) bucket(style).importPoQty += po.qty;
  }

  const unitsByStyle: Record<string, StyleControlTotals> = {};
  const totals = emptyTotals();
  for (const style of [...byStyle.keys()].sort()) {
    const b = byStyle.get(style)!;
    const rounded = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, round(v)])) as unknown as StyleControlTotals;
    unitsByStyle[style] = rounded;
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] = round(totals[k] + rounded[k]);
  }

  const rowCounts: Record<string, number> = {
    Items: tables.items.length,
    SalesHistory: new Set(tables.salesHistory.map((p) => p.sku)).size,
    Stock: tables.stock.length,
    ImportPOs: tables.importPos.length,
    BOM: tables.bom.length,
    Routing_SMV: tables.routing.length,
    ProductionOrders: tables.productionOrders.length,
    LandedCost: tables.landedCost.length,
    Payments_FEC: tables.paymentsFec.length,
    Customers: tables.customers.length,
    Quotes: tables.quotes.length,
  };

  const hash = createHash("sha256");
  for (const [name, rows] of Object.entries(tables)) {
    hash.update(`${name}\n`);
    hash.update(canonicalRows(rows as readonly object[]).join("\n"));
    hash.update("\n");
  }
  hash.update(months.join(","));

  return {
    rowCounts,
    months: { first: months[0] ?? null, last: months[months.length - 1] ?? null, count: months.length },
    unitsByStyle,
    totals,
    controlHash: hash.digest("hex"),
  };
}
