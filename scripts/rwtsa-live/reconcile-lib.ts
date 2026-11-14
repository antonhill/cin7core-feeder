// Shared by reconcile.ts (CLI) and setup.ts. OFFLINE and report-only: no network, no change to the workbook or any Scenario A-D input.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildDataset } from "../../src/rwtsa-demo/workbook/build-dataset";
import { readWorkbookFile } from "../../src/rwtsa-demo/workbook/read";
import { assertReconcilable, parseKnownTransactions, reconcileSnapshot } from "../../src/rwtsa-live/reconcile";
import { readSnapshotFile, writeTextAtomic } from "../../src/rwtsa-live/store";
import { RwtsaLiveError } from "../../src/rwtsa-live/types";

/** Terminal lines for a reconciliation summary: counts and totals only, never a SKU or location name. */
export function summaryLines(s: ReturnType<typeof reconcileSnapshot>["summary"]): string[] {
  const d = s.byDimension, t = s.totals;
  return [
    `${s.skus} SKUs · match ${s.match} · explained by known transactions ${s.explained} · KNOWN SOURCE-ONLY ALLOCATION ${s.knownSourceOnlyAllocation}${s.sourceOnlyAllocationsAccepted ? " (owner-accepted)" : " (NOT accepted: such SKUs count as unexplained)"} · UNEXPLAINED ${s.unexplained} · only in workbook ${s.onlyInWorkbook} · only in Cin7 ${s.onlyInCin7}`,
    `  physical  : match ${d.physical.match} · explained ${d.physical.explainedKnown} · unexplained ${d.physical.unexplained} (${t.unexplainedPhysicalUnits} units) · workbook ${t.workbookPhysical} vs Cin7 ${t.cin7Physical} · known movements ${t.knownPhysical}`,
    `  Bond      : match ${d.bond.match} · explained ${d.bond.explainedKnown} · unexplained ${d.bond.unexplained} (${t.unexplainedBondUnits} units) · workbook ${t.workbookBond} vs Cin7 ${t.cin7Bond} · known movements ${t.knownBond}`,
    `  allocation: match ${d.allocation.match} · known source-only ${d.allocation.sourceOnly} (${t.sourceOnlyAllocationUnits} units, never added to Cin7 quantities) · unexplained ${d.allocation.unexplained}`,
    `  usable    : match ${d.usable.match} · explained ${d.usable.explained} · unexplained ${d.usable.unexplained} (${t.unexplainedUsableUnits} units) · workbook ${t.workbookUsable} vs Cin7 ${t.cin7Usable}`,
    `  availability: Cin7 operational ${t.cin7OperationalAvailable} · RWTSA planning (derived, source commitments applied) ${t.rwtsaPlanningAvailable}`,
  ];
}

export async function runReconcile(i: { snapshotFile: string; workbookFile: string; knownFile?: string; allowIncomplete: boolean; acceptSourceOnlyAllocations?: boolean }) {
  const snapshot = readSnapshotFile(i.snapshotFile);
  assertReconcilable(snapshot, i.allowIncomplete);
  const built = buildDataset(await readWorkbookFile(i.workbookFile), { provenance: "local-workbook", source: { label: "reconcile" } });
  if (!built.ok || !built.dataset) throw new RwtsaLiveError("STORE", "The workbook did not load cleanly; nothing was reconciled.");
  const known = i.knownFile ? parseKnownTransactions(JSON.parse(readFileSync(i.knownFile, "utf8"))) : [];
  const report = reconcileSnapshot({
    snapshotStock: snapshot.stock,
    workbook: built.dataset.tables.stock.map((s) => ({ sku: s.sku, jhb: s.jhb, durban: s.durban, capeTown: s.capeTown, factoryStore: s.factoryStore, bond: s.bond, committed: s.committed })),
    knownTransactions: known,
    acceptSourceOnlyAllocations: i.acceptSourceOnlyAllocations === true,
  });
  const out = { snapshotHash: snapshot.contentHash, snapshotTakenAt: snapshot.takenAt, snapshotCompleteness: snapshot.completeness.status, knownTransactionCount: known.length, ...report };
  const text = JSON.stringify(out, null, 2);
  const { file } = writeTextAtomic({ name: `reconciliation-${createHash("sha256").update(text).digest("hex").slice(0, 12)}.json`, text });
  return { file, summary: report.summary, snapshotCompleteness: snapshot.completeness.status, knownCount: known.length };
}
