import type { ImportPoRow, LandedCostRow, PaymentFecRow } from "@/rwtsa-demo/contracts/tabs";
import type { RwtsaDataset } from "@/rwtsa-demo/dataset";
import { makeDataset } from "./engine-fixture";

/** Hand-built SYNTHETIC landed-cost / payments datasets: small numbers that can be checked by hand. */

export interface LineSpec {
  shipment: string;
  sku: string;
  qty?: number;
  fobUsd?: number | null;
  planningFx?: number | null;
  customsFx?: number | null;
  duty?: number | null;
  cbm?: number;
  freight?: number | null;
  freightAllocated?: number | null;
}
export interface PaySpec {
  po: string;
  due: string;
  usd: number;
  fec?: string | null;
  locked?: number | null;
  zar?: number | null;
  deposit?: boolean | null;
}
export interface PoSpec2 {
  po: string;
  shipment: string | null;
}

export function landedDataset(lines: LineSpec[], pays: PaySpec[] = [], pos: PoSpec2[] = []): RwtsaDataset {
  const base = makeDataset({ skus: [] });
  const landedCost: LandedCostRow[] = lines.map((l) => ({
    shipmentRef: l.shipment,
    sku: l.sku,
    qty: l.qty ?? 10,
    fobUsd: l.fobUsd === undefined ? 100 : l.fobUsd,
    planningFx: l.planningFx === undefined ? 18 : l.planningFx,
    customsFx: l.customsFx === undefined ? 19 : l.customsFx,
    dutyZar: l.duty === undefined ? 0 : l.duty,
    cbm: l.cbm ?? 1,
    freightTotalZar: l.freight === undefined ? 0 : l.freight,
    freightAllocatedZar: l.freightAllocated ?? null,
  }));
  const paymentsFec: PaymentFecRow[] = pays.map((p) => ({
    poNo: p.po, supplier: "SYN", shipmentDate: null, termsDays: null, dueDate: p.due, usdAmount: p.usd,
    fecRef: p.fec ?? null, lockedRate: p.locked ?? null, zarValue: p.zar ?? null, isDeposit: p.deposit ?? null,
  }));
  const importPos: ImportPoRow[] = pos.map((p) => ({
    poNo: p.po, supplier: "SYN", country: null, currency: null, incoterm: null, sku: null, styleCode: "ST", qty: 1, unitPriceUsd: 1,
    etd: null, etaPort: null, etaStores: "2026-12-01", status: "On order", bondOnArrival: null, shipmentRef: p.shipment,
  }));
  return { ...base, tables: { ...base.tables, landedCost, paymentsFec, importPos } };
}
