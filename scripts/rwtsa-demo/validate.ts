// Local, read-only structural validation of the protected RWTSA demonstration workbook.
//
//   npx tsx scripts/rwtsa-demo/validate.ts --file "<path to workbook>" [--header-map "<json>"] [--out-dir "<dir>"] [--reconcile]
//
// - Reads the workbook locally. No network, no Supabase, no Cin7. Nothing is uploaded or written to the repo.
// - The workbook (and the header-map file, and the output directory) MUST be outside every git working tree;
//   the script refuses otherwise.
// - Terminal output is STRUCTURE ONLY: tab presence, parsed row COUNTS, missing canonical field names and
//   value-free findings. It never prints a cell value, a file name or a path.
// - Writes `validation-certificate.json` (pass/fail + the same structure-only detail) to the output
//   directory (default $RWTSA_LOCAL_DIR or ~/rwtsa-local). With --reconcile and a clean pass it also writes
//   `reconciliation.json` there: control totals for YOU to compare with the advisor's figures. Those totals
//   are derived from protected data: keep them local, never paste them into chat or commit them.
//
// Exit codes: 0 pass, 1 validation failed, 2 usage / safety refusal.
import { homedir } from "node:os";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { TAB_NAMES } from "../../src/rwtsa-demo/contracts/tabs";
import { RwtsaSafeError, toSafeMessage } from "../../src/rwtsa-demo/findings";
import { assertOutputDirAllowed } from "../../src/rwtsa-demo/workbook/path-guard";
import { loadHeaderOverrides, validateWorkbookFile } from "../../src/rwtsa-demo/workbook/validate-file";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const file = arg("file") ?? process.env.RWTSA_WORKBOOK_PATH;
  if (!file) {
    console.error('usage: npx tsx scripts/rwtsa-demo/validate.ts --file "<workbook.xlsx>" [--header-map "<json>"] [--out-dir "<dir>"] [--reconcile]');
    return 2;
  }
  const outDir = assertOutputDirAllowed(arg("out-dir") ?? process.env.RWTSA_LOCAL_DIR ?? path.join(homedir(), "rwtsa-local"));
  const headerMapFile = arg("header-map") ?? process.env.RWTSA_HEADER_MAP;
  const headerOverrides = headerMapFile ? loadHeaderOverrides(headerMapFile) : undefined;

  const { certificate, dataset } = await validateWorkbookFile(file, { headerOverrides });

  console.log(`RWTSA workbook structure validation: ${certificate.status.toUpperCase()}`);
  for (const tab of TAB_NAMES) {
    const t = certificate.tabs[tab];
    const missing = t.missingFields.length ? `  MISSING FIELDS: ${t.missingFields.join(", ")}` : "";
    console.log(`  ${tab.padEnd(18)} ${t.present ? "present" : "MISSING"}  parsed rows: ${t.rows ?? "-"}${missing}`);
  }
  if (certificate.findings.length > 0) {
    console.log("Findings (value-free):");
    for (const f of certificate.findings) {
      const where = [f.tab, f.field, f.reason, f.fields?.join("+")].filter(Boolean).join(" / ");
      const rows = f.rows?.length ? `  rows ${f.rows.join(",")}` : "";
      console.log(`  [${f.severity}] ${f.code}${where ? ` (${where})` : ""} x${f.count}${rows}`);
    }
  }

  console.log("Scenario readiness (separate from PASS/FAIL):");
  for (const r of certificate.readiness) {
    const gaps = [...r.missingTabs.map((t) => `empty/missing tab ${t}`), ...r.missingFields.map((f) => `absent column ${f}`)];
    console.log(`  ${r.scenario}: ${r.ready ? "READY" : "NOT READY"}${gaps.length ? `  (${gaps.join("; ")})` : ""}`);
  }

  writeFileSync(path.join(outDir, "validation-certificate.json"), JSON.stringify(certificate, null, 2));
  console.log("Certificate written to the local output directory.");

  if (process.argv.includes("--reconcile")) {
    if (dataset) {
      writeFileSync(path.join(outDir, "reconciliation.json"), JSON.stringify(dataset.reconciliation, null, 2));
      console.log("Reconciliation written to the local output directory. Compare it locally; do not paste or commit it.");
    } else {
      console.log("Reconciliation not written: the workbook did not pass validation.");
    }
  }
  return certificate.status === "pass" ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    // Only our own value-free errors keep their text; anything else is reduced to its error class.
    console.error(toSafeMessage(e));
    process.exit(e instanceof RwtsaSafeError ? 2 : 1);
  }
);
