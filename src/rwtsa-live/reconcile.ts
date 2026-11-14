import type { SkuStock, Snapshot } from "./snapshot";
import { RwtsaLiveError } from "./types";

export interface WorkbookStockRow { sku: string; jhb: number; durban: number; capeTown: number; factoryStore: number; bond: number; committed: number }
/** Owner-supplied explanation of a known demo transaction: the effect on a SKU's physical (and optionally Bond) quantity since the workbook date. */
export interface KnownTransaction { ref: string; sku: string; physicalDelta: number; bondDelta?: number }
interface Side { physical: number; bond: number; allocated: number; usable: number }
/** Overall row status. KNOWN_SOURCE_ONLY_ALLOCATION exists only when the owner has accepted source-only allocations and nothing else is unexplained. */
export type RowStatus = "MATCH" | "EXPLAINED" | "KNOWN_SOURCE_ONLY_ALLOCATION" | "UNEXPLAINED" | "ONLY_IN_WORKBOOK" | "ONLY_IN_CIN7";
/** Physical and Bond: a delta equal to the owner-supplied known transactions is EXPLAINED_KNOWN; anything else is UNEXPLAINED. */
export type StockDimension = "MATCH" | "EXPLAINED_KNOWN" | "UNEXPLAINED";
/** Allocation: SOURCE_ONLY_ALLOCATION = the workbook commits stock that Cin7 has no allocation for at all (Cin7 allocated = 0), and the owner has accepted that as a known difference. */
export type AllocationDimension = "MATCH" | "SOURCE_ONLY_ALLOCATION" | "UNEXPLAINED";
export type UsableDimension = "MATCH" | "EXPLAINED" | "UNEXPLAINED";
export interface ReconRow {
  sku: string; workbook: Side; cin7: Side;
  deltaPhysical: number; deltaBond: number; deltaAllocated: number; deltaUsable: number;
  explainedPhysical: number; residualPhysical: number; residualBond: number; refs: string[]; status: RowStatus;
  physicalStatus: StockDimension; bondStatus: StockDimension; allocationStatus: AllocationDimension; usableStatus: UsableDimension;
  /** Workbook-committed units with no Cin7 allocation, counted ONLY when the owner accepted source-only allocations; never added to any Cin7 quantity. */
  sourceOnlyAllocation: number;
  /** delta usable less the known non-Bond movement and the accepted source-only allocation. */
  residualUsable: number;
  /** What Cin7 itself reports as usable now (unchanged snapshot value). */
  cin7OperationalAvailable: number;
  /** DERIVED planning figure: Cin7 non-Bond stock now less the SOURCE WORKBOOK's committed units. Never written into Cin7 numbers. */
  rwtsaPlanningAvailable: number;
}
const EPS = 1e-9;
const z = (n: number) => Math.abs(n) < EPS;

/** Reconciling a partial snapshot would present gaps as differences; refuse unless the owner explicitly accepts that. */
export function assertReconcilable(s: Pick<Snapshot, "completeness" | "source">, allowIncomplete: boolean): void {
  if (s.source?.identity?.status !== "VERIFIED") throw new RwtsaLiveError("STORE", "The snapshot does not carry a VERIFIED account identity; refusing to reconcile it (this cannot be overridden).");
  if (s.completeness.status !== "COMPLETE" && !allowIncomplete) throw new RwtsaLiveError("STORE", "The snapshot is INCOMPLETE; refusing to reconcile it (pass --allow-incomplete to override knowingly).");
}
/** Validates the owner-supplied known-transactions file: numbers only, unique ref+sku. Messages never echo file values. */
export function parseKnownTransactions(raw: unknown): KnownTransaction[] {
  const bad = (m: string): never => { throw new RwtsaLiveError("STORE", `known-transactions file: ${m}`); };
  if (!Array.isArray(raw)) bad("must be a JSON array");
  const seen = new Set<string>();
  return (raw as unknown[]).map((t, i) => {
    const o = (t ?? {}) as Record<string, unknown>;
    if (typeof o.ref !== "string" || !o.ref || typeof o.sku !== "string" || !o.sku) bad(`entry ${i + 1} needs a text ref and sku`);
    if (typeof o.physicalDelta !== "number" || !Number.isFinite(o.physicalDelta)) bad(`entry ${i + 1}: physicalDelta must be a finite number`);
    if (o.bondDelta !== undefined && (typeof o.bondDelta !== "number" || !Number.isFinite(o.bondDelta))) bad(`entry ${i + 1}: bondDelta must be a finite number`);
    const k = JSON.stringify([o.ref, o.sku]); if (seen.has(k)) bad(`entry ${i + 1} repeats an earlier ref+sku`); seen.add(k);
    return { ref: o.ref as string, sku: o.sku as string, physicalDelta: o.physicalDelta as number, bondDelta: o.bondDelta as number | undefined };
  });
}

const ZERO: Side = { physical: 0, bond: 0, allocated: 0, usable: 0 };

const wbSide = (w: WorkbookStockRow): Side => ({ physical: w.jhb + w.durban + w.capeTown + w.factoryStore + w.bond, bond: w.bond, allocated: w.committed, usable: w.jhb + w.durban + w.capeTown + w.factoryStore - w.committed });
const cinSide = (s: SkuStock): Side => ({ physical: s.physical, bond: s.bond, allocated: s.allocatedUnrestricted, usable: s.usable });

function stockDimension(delta: number, known: number): { status: StockDimension; residual: number } {
  const residual = z(delta - known) ? 0 : delta - known;
  if (z(delta) && z(known)) return { status: "MATCH", residual: 0 };
  return { status: residual === 0 ? "EXPLAINED_KNOWN" : "UNEXPLAINED", residual };
}

/**
 * Report only. Compares; never alters or substitutes workbook inputs or Cin7 quantities, and never forces the two to agree.
 * Separate verdicts for physical, Bond, allocation and usable stock. `acceptSourceOnlyAllocations` records the OWNER's decision that workbook
 * commitments with no Cin7 allocation are a known planning-versus-operational difference; without it they stay UNEXPLAINED.
 */
export function reconcileSnapshot(i: { snapshotStock: readonly SkuStock[]; workbook: readonly WorkbookStockRow[]; knownTransactions: readonly KnownTransaction[]; acceptSourceOnlyAllocations?: boolean }) {
  if (new Set(i.workbook.map((w) => w.sku)).size !== i.workbook.length) throw new RwtsaLiveError("STORE", "The workbook has duplicate SKUs; refusing to overwrite one with another.");
  const accept = i.acceptSourceOnlyAllocations === true;
  const wb = new Map(i.workbook.map((w) => [w.sku, w]));
  const cin = new Map(i.snapshotStock.map((s) => [s.sku, s]));
  const rows: ReconRow[] = [];
  for (const sku of [...new Set([...wb.keys(), ...cin.keys()])].sort()) {
    const w = wb.get(sku), c = cin.get(sku);
    const W = w ? wbSide(w) : ZERO, C = c ? cinSide(c) : ZERO;
    const tx = i.knownTransactions.filter((t) => t.sku === sku);
    const explainedPhysical = tx.reduce((t, x) => t + x.physicalDelta, 0), explainedBond = tx.reduce((t, x) => t + (x.bondDelta ?? 0), 0);
    const knownNonBond = explainedPhysical - explainedBond;
    const d = { p: C.physical - W.physical, b: C.bond - W.bond, a: C.allocated - W.allocated, u: C.usable - W.usable };
    const phys = stockDimension(d.p, explainedPhysical), bond = stockDimension(d.b, explainedBond);
    const committed = w?.committed ?? 0;
    const sourceOnly = accept && !!w && !!c && !z(committed) && committed > 0 && z(C.allocated);
    const allocationStatus: AllocationDimension = z(d.a) ? "MATCH" : sourceOnly ? "SOURCE_ONLY_ALLOCATION" : "UNEXPLAINED";
    const sourceOnlyAllocation = allocationStatus === "SOURCE_ONLY_ALLOCATION" ? committed : 0;
    const residualUsable = z(d.u - knownNonBond - sourceOnlyAllocation) ? 0 : d.u - knownNonBond - sourceOnlyAllocation;
    const usableStatus: UsableDimension = z(d.u) && z(knownNonBond) && z(sourceOnlyAllocation) ? "MATCH" : residualUsable === 0 ? "EXPLAINED" : "UNEXPLAINED";
    const anyUnexplained = [phys.status, bond.status, allocationStatus, usableStatus].includes("UNEXPLAINED");
    const status: RowStatus = !c ? "ONLY_IN_WORKBOOK" : !w ? "ONLY_IN_CIN7"
      : anyUnexplained ? "UNEXPLAINED"
      : allocationStatus === "SOURCE_ONLY_ALLOCATION" ? "KNOWN_SOURCE_ONLY_ALLOCATION"
      : phys.status === "MATCH" && bond.status === "MATCH" && allocationStatus === "MATCH" && usableStatus === "MATCH" ? "MATCH" : "EXPLAINED";
    rows.push({
      sku, workbook: W, cin7: C, deltaPhysical: d.p, deltaBond: d.b, deltaAllocated: d.a, deltaUsable: d.u, explainedPhysical, residualPhysical: phys.residual, residualBond: bond.residual, refs: tx.map((t) => t.ref), status,
      physicalStatus: phys.status, bondStatus: bond.status, allocationStatus, usableStatus, sourceOnlyAllocation, residualUsable,
      cin7OperationalAvailable: C.usable, rwtsaPlanningAvailable: C.physical - C.bond - committed,
    });
  }
  const count = (s: RowStatus) => rows.filter((r) => r.status === s).length;
  const sum = (f: (r: ReconRow) => number) => rows.reduce((t, r) => t + f(r), 0);
  const by = <T extends string>(f: (r: ReconRow) => T, v: T) => rows.filter((r) => f(r) === v).length;
  const known = i.knownTransactions.filter((t) => cin.has(t.sku) || wb.has(t.sku));
  const unmatchedKnownTransactions = i.knownTransactions.length - known.length;
  const knownPhysical = known.reduce((t, x) => t + x.physicalDelta, 0), knownBond = known.reduce((t, x) => t + (x.bondDelta ?? 0), 0);
  return {
    rows,
    summary: {
      skus: rows.length, match: count("MATCH"), explained: count("EXPLAINED"), knownSourceOnlyAllocation: count("KNOWN_SOURCE_ONLY_ALLOCATION"), unexplained: count("UNEXPLAINED"), onlyInWorkbook: count("ONLY_IN_WORKBOOK"), onlyInCin7: count("ONLY_IN_CIN7"),
      sourceOnlyAllocationsAccepted: accept, unmatchedKnownTransactions,
      byDimension: {
        physical: { match: by((r) => r.physicalStatus, "MATCH"), explainedKnown: by((r) => r.physicalStatus, "EXPLAINED_KNOWN"), unexplained: by((r) => r.physicalStatus, "UNEXPLAINED") },
        bond: { match: by((r) => r.bondStatus, "MATCH"), explainedKnown: by((r) => r.bondStatus, "EXPLAINED_KNOWN"), unexplained: by((r) => r.bondStatus, "UNEXPLAINED") },
        allocation: { match: by((r) => r.allocationStatus, "MATCH"), sourceOnly: by((r) => r.allocationStatus, "SOURCE_ONLY_ALLOCATION"), unexplained: by((r) => r.allocationStatus, "UNEXPLAINED") },
        usable: { match: by((r) => r.usableStatus, "MATCH"), explained: by((r) => r.usableStatus, "EXPLAINED"), unexplained: by((r) => r.usableStatus, "UNEXPLAINED") },
      },
      totals: {
        workbookPhysical: sum((r) => r.workbook.physical), cin7Physical: sum((r) => r.cin7.physical), workbookBond: sum((r) => r.workbook.bond), cin7Bond: sum((r) => r.cin7.bond),
        workbookUsable: sum((r) => r.workbook.usable), cin7Usable: sum((r) => r.cin7.usable),
        knownPhysical, knownBond, knownNonBond: knownPhysical - knownBond,
        sourceOnlyAllocationUnits: sum((r) => r.sourceOnlyAllocation),
        unexplainedPhysicalUnits: sum((r) => Math.abs(r.residualPhysical)), unexplainedBondUnits: sum((r) => Math.abs(r.residualBond)), unexplainedUsableUnits: sum((r) => Math.abs(r.residualUsable)),
        cin7OperationalAvailable: sum((r) => r.cin7OperationalAvailable), rwtsaPlanningAvailable: sum((r) => r.rwtsaPlanningAvailable),
      },
    },
  };
}
