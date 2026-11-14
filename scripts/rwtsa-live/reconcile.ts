// OFFLINE reconciliation of a saved Cin7 snapshot against the protected workbook. No network. Report only.
//
//   npx tsx scripts/rwtsa-live/reconcile.ts --snapshot <snapshot.json> --workbook <protected workbook.xlsx> [--known <known-transactions.json>] [--allow-incomplete] [--accept-source-only-allocations]
//
// Never changes the workbook or any Scenario A-D input, never forces agreement, and refuses a snapshot whose account identity is not VERIFIED.
// Separate verdicts for physical, Bond, allocation and usable stock. A difference is "EXPLAINED" only by an owner-supplied known-transactions file.
// --accept-source-only-allocations records the owner's decision that workbook commitments Cin7 has no allocation for are a KNOWN planning-versus-operational
// difference; without it they stay UNEXPLAINED. Terminal output is counts only.
import path from "node:path";
import { RwtsaLiveError } from "../../src/rwtsa-live/types";
import { runReconcile, summaryLines } from "./reconcile-lib";

const arg = (n: string): string | undefined => { const i = process.argv.indexOf(`--${n}`); const v = i >= 0 ? process.argv[i + 1] : undefined; if (i >= 0 && (!v || v.startsWith("--"))) throw new Error(`--${n} requires a value`); return v; };

async function main(): Promise<number> {
  const snapshotFile = arg("snapshot"), workbookFile = arg("workbook");
  if (!snapshotFile || !workbookFile) { console.error("Usage: --snapshot <file> --workbook <file> [--known <file>] [--allow-incomplete] [--accept-source-only-allocations]"); return 2; }
  const r = await runReconcile({ snapshotFile, workbookFile, knownFile: arg("known"), allowIncomplete: process.argv.includes("--allow-incomplete"), acceptSourceOnlyAllocations: process.argv.includes("--accept-source-only-allocations") });
  console.log(`RECONCILIATION (snapshot ${r.snapshotCompleteness})`);
  summaryLines(r.summary).forEach((l) => console.log(l));
  console.log(`  known transactions supplied: ${r.knownCount}${r.knownCount === 0 ? " (every difference is therefore unexplained)" : ""}`);
  console.log(`  written: ${path.basename(r.file)} (in ~/rwtsa-local/cin7-snapshots)`);
  return 0;
}
main().then((c) => process.exit(c), (e) => { console.error(e instanceof RwtsaLiveError ? `FAILED [${e.code}] ${e.message}` : "FAILED (details withheld)."); process.exit(1); });
