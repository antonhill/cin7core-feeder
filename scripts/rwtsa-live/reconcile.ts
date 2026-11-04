// OFFLINE reconciliation of a saved Cin7 snapshot against the protected workbook. No network. Report only.
//
//   npx tsx scripts/rwtsa-live/reconcile.ts --snapshot <snapshot.json> --workbook <protected workbook.xlsx> [--known <known-transactions.json>]
//
// Compares physical, Bond, allocated and usable stock. It never changes the workbook or any Scenario A-D input, and never forces
// the two sources to agree. A difference is "EXPLAINED" only by an owner-supplied known-transactions file, e.g.
//   [{ "ref": "PO-00002", "sku": "<sku>", "physicalDelta": 120 }, { "ref": "MO-00001", "sku": "<sku>", "physicalDelta": -4 }]
// Report: ~/rwtsa-local/cin7-snapshots/reconciliation-<hash>.json (0600). Terminal output is counts only.
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, writeSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { buildDataset } from "../../src/rwtsa-demo/workbook/build-dataset";
import { readWorkbookFile } from "../../src/rwtsa-demo/workbook/read";
import { reconcileSnapshot, type KnownTransaction } from "../../src/rwtsa-live/reconcile";
import { readSnapshotFile, snapshotDir } from "../../src/rwtsa-live/store";

const arg = (n: string): string | undefined => { const i = process.argv.indexOf(`--${n}`); const v = i >= 0 ? process.argv[i + 1] : undefined; if (i >= 0 && (!v || v.startsWith("--"))) throw new Error(`--${n} requires a value`); return v; };

async function main(): Promise<number> {
  const snapFile = arg("snapshot"), wbFile = arg("workbook");
  if (!snapFile || !wbFile) { console.error("Usage: --snapshot <file> --workbook <file> [--known <file>]"); return 2; }
  const snapshot = readSnapshotFile(snapFile);
  const built = buildDataset(await readWorkbookFile(wbFile), { provenance: "local-workbook", source: { label: "reconcile" } });
  if (!built.ok || !built.dataset) { console.error("The workbook did not load cleanly; nothing was reconciled."); return 1; }
  const known: KnownTransaction[] = arg("known") ? (JSON.parse(readFileSync(arg("known")!, "utf8")) as KnownTransaction[]) : [];
  const report = reconcileSnapshot({
    snapshotStock: snapshot.stock,
    workbook: built.dataset.tables.stock.map((s) => ({ sku: s.sku, jhb: s.jhb, durban: s.durban, capeTown: s.capeTown, factoryStore: s.factoryStore, bond: s.bond, committed: s.committed })),
    knownTransactions: known,
  });
  const out = { snapshotHash: snapshot.contentHash, snapshotTakenAt: snapshot.takenAt, snapshotCompleteness: snapshot.completeness.status, knownTransactionCount: known.length, ...report };
  const text = JSON.stringify(out, null, 2);
  const dir = snapshotDir(homedir()); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `reconciliation-${createHash("sha256").update(text).digest("hex").slice(0, 12)}.json`);
  const fd = openSync(file, "wx", 0o600); try { writeSync(fd, text); } finally { closeSync(fd); }
  const s = report.summary;
  console.log(`RECONCILIATION (snapshot ${snapshot.completeness.status}) · ${s.skus} SKUs · match ${s.match} · explained ${s.explained} · unexplained ${s.unexplained} · only in workbook ${s.onlyInWorkbook} · only in Cin7 ${s.onlyInCin7}`);
  console.log(`  known transactions supplied: ${known.length}${known.length === 0 ? " (every difference is therefore unexplained)" : ""}`);
  console.log(`  written: ${path.basename(file)} (in ~/rwtsa-local/cin7-snapshots)`);
  return 0;
}
main().then((c) => process.exit(c), () => { console.error("FAILED (details withheld)."); process.exit(1); });
