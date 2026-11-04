import type { SkuStock } from "./snapshot";

export interface WorkbookStockRow { sku: string; jhb: number; durban: number; capeTown: number; factoryStore: number; bond: number; committed: number }
/** Owner-supplied explanation of a known demo transaction: the effect on a SKU's physical (and optionally Bond) quantity since the workbook date. */
export interface KnownTransaction { ref: string; sku: string; physicalDelta: number; bondDelta?: number }
interface Side { physical: number; bond: number; allocated: number; usable: number }
export type RowStatus = "MATCH" | "EXPLAINED" | "UNEXPLAINED" | "ONLY_IN_WORKBOOK" | "ONLY_IN_CIN7";
export interface ReconRow {
  sku: string; workbook: Side; cin7: Side;
  deltaPhysical: number; deltaBond: number; deltaAllocated: number; deltaUsable: number;
  explainedPhysical: number; residualPhysical: number; residualBond: number; refs: string[]; status: RowStatus;
}
const ZERO: Side = { physical: 0, bond: 0, allocated: 0, usable: 0 };

const wbSide = (w: WorkbookStockRow): Side => ({ physical: w.jhb + w.durban + w.capeTown + w.factoryStore + w.bond, bond: w.bond, allocated: w.committed, usable: w.jhb + w.durban + w.capeTown + w.factoryStore - w.committed });
const cinSide = (s: SkuStock): Side => ({ physical: s.physical, bond: s.bond, allocated: s.allocatedUnrestricted, usable: s.usable });

/** Report only. Compares; never alters or substitutes workbook inputs, and never forces the two to agree. */
export function reconcileSnapshot(i: { snapshotStock: readonly SkuStock[]; workbook: readonly WorkbookStockRow[]; knownTransactions: readonly KnownTransaction[] }) {
  const wb = new Map(i.workbook.map((w) => [w.sku, w]));
  const cin = new Map(i.snapshotStock.map((s) => [s.sku, s]));
  const rows: ReconRow[] = [];
  for (const sku of [...new Set([...wb.keys(), ...cin.keys()])].sort()) {
    const w = wb.get(sku), c = cin.get(sku);
    const W = w ? wbSide(w) : ZERO, C = c ? cinSide(c) : ZERO;
    const tx = i.knownTransactions.filter((t) => t.sku === sku);
    const explainedPhysical = tx.reduce((t, x) => t + x.physicalDelta, 0), explainedBond = tx.reduce((t, x) => t + (x.bondDelta ?? 0), 0);
    const d = { p: C.physical - W.physical, b: C.bond - W.bond, a: C.allocated - W.allocated, u: C.usable - W.usable };
    const residualPhysical = d.p - explainedPhysical, residualBond = d.b - explainedBond;
    const status: RowStatus = !c ? "ONLY_IN_WORKBOOK" : !w ? "ONLY_IN_CIN7"
      : d.p === 0 && d.b === 0 && d.a === 0 && d.u === 0 ? "MATCH"
      : residualPhysical === 0 && residualBond === 0 && d.a === 0 && tx.length > 0 ? "EXPLAINED" : "UNEXPLAINED";
    rows.push({ sku, workbook: W, cin7: C, deltaPhysical: d.p, deltaBond: d.b, deltaAllocated: d.a, deltaUsable: d.u, explainedPhysical, residualPhysical, residualBond, refs: tx.map((t) => t.ref), status });
  }
  const count = (s: RowStatus) => rows.filter((r) => r.status === s).length;
  const sum = (f: (r: ReconRow) => number) => rows.reduce((t, r) => t + f(r), 0);
  return {
    rows,
    summary: {
      skus: rows.length, match: count("MATCH"), explained: count("EXPLAINED"), unexplained: count("UNEXPLAINED"), onlyInWorkbook: count("ONLY_IN_WORKBOOK"), onlyInCin7: count("ONLY_IN_CIN7"),
      totals: { workbookPhysical: sum((r) => r.workbook.physical), cin7Physical: sum((r) => r.cin7.physical), workbookBond: sum((r) => r.workbook.bond), cin7Bond: sum((r) => r.cin7.bond), workbookUsable: sum((r) => r.workbook.usable), cin7Usable: sum((r) => r.cin7.usable) },
    },
  };
}
