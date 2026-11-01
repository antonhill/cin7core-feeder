import type { BomRow, ItemRow, ProductionOrderRow, RoutingRow } from "@/rwtsa-demo/contracts/tabs";
import type { RwtsaDataset } from "@/rwtsa-demo/dataset";
import { makeDataset } from "./engine-fixture";

/** Hand-built SYNTHETIC manufacturing datasets: small numbers that can be checked by hand. */

export interface BomSpec {
  style?: string;
  code: string;
  name?: string;
  type: string;
  qty: number;
  cost?: number | null;
  size?: string | null;
  sizeFrom?: string | null;
}
export interface OpSpec {
  style?: string;
  op: string;
  smv: number;
  cpm?: number;
  overhead?: number | null;
  efficiency?: number | null;
  margin?: number | null;
}
export interface OrderSpec {
  no: string;
  style?: string;
  qty?: number;
  line?: string;
  plannedMin?: number;
  actualMin?: number;
  plannedM?: number;
  actualM?: number;
  stdPrice?: number | null;
  actPrice?: number | null;
  usageVar?: number | null;
  priceVar?: number | null;
  recovery?: number | null;
}
export interface ItemSpec {
  style?: string;
  size: string;
  std?: number;
}

export function mfgDataset(o: { items?: ItemSpec[]; bom?: BomSpec[]; ops?: OpSpec[]; orders?: OrderSpec[] }): RwtsaDataset {
  const base = makeDataset({ skus: [] });
  const items: ItemRow[] = (o.items ?? []).map((i) => ({
    sku: `${i.style ?? "ST"}-${i.size}`, styleCode: i.style ?? "ST", description: null, productionCode: null, fabric: null, colour: null, size: i.size, source: "Local", unit: null,
    minLevel: null, reorderPoint: null, standardCost: i.std ?? 0, standardSellPrice: null, isTender: false,
  }));
  const bom: BomRow[] = (o.bom ?? []).map((b) => ({
    styleCode: b.style ?? "ST", componentCode: b.code, componentName: b.name ?? b.code, componentType: b.type, qtyPerUnit: b.qty, unit: null, unitCost: b.cost === undefined ? 1 : b.cost, size: b.size ?? null, sizeFrom: b.sizeFrom ?? null,
  }));
  const routing: RoutingRow[] = (o.ops ?? []).map((p) => ({
    styleCode: p.style ?? "ST", operation: p.op, smv: p.smv, costPerMinute: p.cpm ?? 1.5,
    overhead: p.overhead === undefined ? 0.1 : p.overhead, efficiency: p.efficiency === undefined ? 0.85 : p.efficiency, margin: p.margin === undefined ? 0.2 : p.margin,
  }));
  const productionOrders: ProductionOrderRow[] = (o.orders ?? []).map((p) => ({
    orderNo: p.no, styleCode: p.style ?? "ST", qty: p.qty ?? 100, plannedSmv: null, plannedMinutes: p.plannedMin ?? 100, actualMinutes: p.actualMin ?? 100,
    plannedFabricM: p.plannedM ?? 100, actualFabricM: p.actualM ?? 100, standardPrice: p.stdPrice === undefined ? 55 : p.stdPrice, actualPrice: p.actPrice === undefined ? 55 : p.actPrice,
    labourRecoveryPct: p.recovery ?? null, usageVariance: p.usageVar ?? null, priceVariance: p.priceVar ?? null, productionLine: p.line ?? "L1",
  }));
  return { ...base, tables: { ...base.tables, items, bom, routing, productionOrders } };
}
