// Shared by reconcile.ts (CLI) and setup.ts. OFFLINE and report-only: no network, no change to the workbook or any Scenario A-D input.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildDataset } from "../../src/rwtsa-demo/workbook/build-dataset";
import { readWorkbookFile } from "../../src/rwtsa-demo/workbook/read";
import { assertReconcilable, parseKnownTransactions, reconcileSnapshot } from "../../src/rwtsa-live/reconcile";
import { readSnapshotFile, writeTextAtomic } from "../../src/rwtsa-live/store";
import { RwtsaLiveError } from "../../src/rwtsa-live/types";

export async function runReconcile(i: { snapshotFile: string; workbookFile: string; knownFile?: string; allowIncomplete: boolean }) {
  const snapshot = readSnapshotFile(i.snapshotFile);
  assertReconcilable(snapshot, i.allowIncomplete);
  const built = buildDataset(await readWorkbookFile(i.workbookFile), { provenance: "local-workbook", source: { label: "reconcile" } });
  if (!built.ok || !built.dataset) throw new RwtsaLiveError("STORE", "The workbook did not load cleanly; nothing was reconciled.");
  const known = i.knownFile ? parseKnownTransactions(JSON.parse(readFileSync(i.knownFile, "utf8"))) : [];
  const report = reconcileSnapshot({
    snapshotStock: snapshot.stock,
    workbook: built.dataset.tables.stock.map((s) => ({ sku: s.sku, jhb: s.jhb, durban: s.durban, capeTown: s.capeTown, factoryStore: s.factoryStore, bond: s.bond, committed: s.committed })),
    knownTransactions: known,
  });
  const out = { snapshotHash: snapshot.contentHash, snapshotTakenAt: snapshot.takenAt, snapshotCompleteness: snapshot.completeness.status, knownTransactionCount: known.length, ...report };
  const text = JSON.stringify(out, null, 2);
  const { file } = writeTextAtomic({ name: `reconciliation-${createHash("sha256").update(text).digest("hex").slice(0, 12)}.json`, text });
  return { file, summary: report.summary, snapshotCompleteness: snapshot.completeness.status, knownCount: known.length };
}
