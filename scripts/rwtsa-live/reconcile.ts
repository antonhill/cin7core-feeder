// OFFLINE reconciliation of a saved Cin7 snapshot against the protected workbook. No network. Report only.
//
//   npx tsx scripts/rwtsa-live/reconcile.ts --snapshot <snapshot.json> --workbook <protected workbook.xlsx> [--known <known-transactions.json>] [--allow-incomplete]
//
// Never changes the workbook or any Scenario A-D input, never forces agreement, and refuses a snapshot whose account identity is not VERIFIED.
// A difference is "EXPLAINED" only by an owner-supplied known-transactions file. Terminal output is counts only.
import path from "node:path";
import { RwtsaLiveError } from "../../src/rwtsa-live/types";
import { runReconcile } from "./reconcile-lib";

const arg = (n: string): string | undefined => { const i = process.argv.indexOf(`--${n}`); const v = i >= 0 ? process.argv[i + 1] : undefined; if (i >= 0 && (!v || v.startsWith("--"))) throw new Error(`--${n} requires a value`); return v; };

async function main(): Promise<number> {
  const snapshotFile = arg("snapshot"), workbookFile = arg("workbook");
  if (!snapshotFile || !workbookFile) { console.error("Usage: --snapshot <file> --workbook <file> [--known <file>] [--allow-incomplete]"); return 2; }
  const r = await runReconcile({ snapshotFile, workbookFile, knownFile: arg("known"), allowIncomplete: process.argv.includes("--allow-incomplete") });
  const s = r.summary;
  console.log(`RECONCILIATION (snapshot ${r.snapshotCompleteness}) · ${s.skus} SKUs · match ${s.match} · explained ${s.explained} · unexplained ${s.unexplained} · only in workbook ${s.onlyInWorkbook} · only in Cin7 ${s.onlyInCin7}`);
  console.log(`  known transactions supplied: ${r.knownCount}${r.knownCount === 0 ? " (every difference is therefore unexplained)" : ""}`);
  console.log(`  written: ${path.basename(r.file)} (in ~/rwtsa-local/cin7-snapshots)`);
  return 0;
}
main().then((c) => process.exit(c), (e) => { console.error(e instanceof RwtsaLiveError ? `FAILED [${e.code}] ${e.message}` : "FAILED (details withheld)."); process.exit(1); });
