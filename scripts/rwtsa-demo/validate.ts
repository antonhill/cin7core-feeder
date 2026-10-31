// Local, read-only structural validation of the protected RWTSA demonstration workbook.
//
//   npx tsx scripts/rwtsa-demo/validate.ts --file "<path to workbook>" [--header-map "<json>"] [--out-dir "<dir>"]
//                                          [--forecast-window <months, default 6>] [--reconcile]
//
// - Reads the workbook locally. No network, no Supabase, no Cin7. Nothing is uploaded or written to the repo.
// - The workbook (and the header-map file, and the output directory) MUST be outside every git working tree;
//   the script refuses otherwise.
// - Terminal output is STRUCTURE ONLY: tab presence, parsed row COUNTS, missing canonical field names and
//   value-free findings. It never prints a cell value, a file name or a path.
// - The first line is `STRUCTURE PASS|FAIL · N of 4 scenarios READY`. STRUCTURE PASS means the workbook is
//   structurally valid and its core tabs are populated. It NEVER means "ready to demonstrate": only a scenario
//   reported READY has the records, columns, populated values and (scenario A) recent sales history it needs.
// - ARTEFACTS (in the output directory, default $RWTSA_LOCAL_DIR or ~/rwtsa-local): every run first deletes the
//   previous run's `validation-certificate.json` and `reconciliation.json`, then writes this run's certificate
//   (a pass/fail certificate, or an `error` certificate if the run failed before a verdict). With --reconcile and
//   a clean pass it also writes `reconciliation.json` (control totals for YOU to compare with the advisor's
//   figures). Both files carry the same `runId`, so a reconciliation from an earlier successful run can never sit
//   beside a later failed one. Files are written atomically. The totals are derived from protected data: keep them
//   local, never paste them into chat or commit them.
//
// Exit codes: 0 structure PASS (regardless of how many scenarios are ready), 1 validation FAILED or unexpected
// error, 2 usage / safety refusal.
import { randomUUID } from "node:crypto";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { TAB_NAMES } from "../../src/rwtsa-demo/contracts/tabs";
import { DEFAULT_FORECAST_WINDOW_MONTHS } from "../../src/rwtsa-demo/dataset";
import { RwtsaSafeError, toSafeMessage } from "../../src/rwtsa-demo/findings";
import { assertOutputDirAllowed } from "../../src/rwtsa-demo/workbook/path-guard";
import { normaliseReadinessConfig, parseForecastWindowText } from "../../src/rwtsa-demo/workbook/readiness";
import { loadHeaderOverrides, validateWorkbookFile, type ErrorCertificate } from "../../src/rwtsa-demo/workbook/validate-file";

const CERTIFICATE = "validation-certificate.json";
const RECONCILIATION = "reconciliation.json";

/**
 * Value of `--name`, or undefined if the flag is absent. A flag that is present WITHOUT its value (last argument, or
 * followed by another `--flag`) is an error, never a silent fall-back to a default. The message names only our own flag.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith("--")) throw new RwtsaSafeError("invalid_cell", `--${name} requires a value.`);
  return value;
}

function writeArtefact(dir: string, name: string, value: unknown): void {
  const tmp = path.join(dir, `.${name}.${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path.join(dir, name));
}

function clearArtefacts(dir: string): void {
  for (const name of [CERTIFICATE, RECONCILIATION]) {
    const f = path.join(dir, name);
    if (existsSync(f)) rmSync(f);
  }
}

async function main(runId: string): Promise<{ code: number; outDir: string | null }> {
  // 1. Output directory first (guarded: outside every git working tree). Nothing is touched if this is refused.
  const outDir = assertOutputDirAllowed(arg("out-dir") ?? process.env.RWTSA_LOCAL_DIR ?? path.join(homedir(), "rwtsa-local"));
  // 2. From here on this invocation owns the directory: remove the previous run's artefacts so they cannot be
  //    mistaken for this run's, whatever happens next (usage error, early exception, failed validation).
  clearArtefacts(outDir);

  try {
    const file = arg("file") ?? process.env.RWTSA_WORKBOOK_PATH;
    if (!file) {
      console.error('usage: npx tsx scripts/rwtsa-demo/validate.ts --file "<workbook.xlsx>" [--header-map "<json>"] [--out-dir "<dir>"] [--forecast-window <months>] [--reconcile]');
      throw new RwtsaSafeError("not_a_workbook", "No workbook path was given (--file or RWTSA_WORKBOOK_PATH).");
    }
    const windowArg = arg("forecast-window");
    const readiness = normaliseReadinessConfig({ forecastWindowMonths: windowArg === undefined ? DEFAULT_FORECAST_WINDOW_MONTHS : parseForecastWindowText(windowArg) });
    const headerMapFile = arg("header-map") ?? process.env.RWTSA_HEADER_MAP;
    const headerOverrides = headerMapFile ? loadHeaderOverrides(headerMapFile) : undefined;

    const { certificate, dataset } = await validateWorkbookFile(file, { headerOverrides, runId, readiness });

    console.log(`STRUCTURE ${certificate.status.toUpperCase()} · ${certificate.scenariosReady} of ${certificate.readiness.length} scenarios READY`);
    console.log(
      certificate.status === "pass"
        ? "  (Structure is valid. That alone does not mean ready to demonstrate: only a scenario marked READY below has what it needs.)"
        : "  (The workbook structure is invalid, so no scenario can be READY.)"
    );
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

    console.log(`Scenario readiness (forecast window: ${certificate.readinessConfig.forecastWindowMonths} months):`);
    for (const r of certificate.readiness) {
      const gaps = [
        ...r.missingTabs.map((t) => `empty/missing tab ${t}`),
        ...r.missingFields.map((f) => `absent column ${f}`),
        ...r.unpopulatedFields.map((u) => `unpopulated ${u.field} (${u.missing} rows lack a value)`),
        ...(r.salesWindow && (r.salesWindow.skusIncomplete > 0 || r.salesWindow.availableMonths < r.salesWindow.requiredMonths)
          ? [`sales window needs ${r.salesWindow.requiredMonths} valid months per SKU: ${r.salesWindow.skusIncomplete} SKUs incomplete, ${r.salesWindow.availableMonths} month columns available`]
          : []),
        ...(certificate.status === "fail" ? ["workbook structure invalid"] : []),
      ];
      console.log(`  ${r.scenario}: ${r.ready ? "READY" : "NOT READY"}${gaps.length ? `  (${gaps.join("; ")})` : ""}`);
    }

    writeArtefact(outDir, CERTIFICATE, certificate);
    console.log("Certificate written to the local output directory.");

    if (process.argv.includes("--reconcile")) {
      if (dataset) {
        writeArtefact(outDir, RECONCILIATION, { runId, fileSha256: certificate.fileSha256, reconciliation: dataset.reconciliation });
        console.log("Reconciliation written to the local output directory. Compare it locally; do not paste or commit it.");
      } else {
        console.log("Reconciliation not written: the workbook did not pass validation.");
      }
    }
    return { code: certificate.status === "pass" ? 0 : 1, outDir };
  } catch (e) {
    // Early failure: record it for THIS run so nothing from an earlier run is left standing, then re-throw to the
    // top-level handler, which prints the value-free message and sets the exit code.
    const errorCertificate: ErrorCertificate = { schemaVersion: 1, runId, status: "error", validatedAt: new Date().toISOString(), message: toSafeMessage(e) };
    writeArtefact(outDir, CERTIFICATE, errorCertificate);
    throw e;
  }
}

main(randomUUID()).then(
  ({ code }) => process.exit(code),
  (e) => {
    // Only our own value-free errors keep their text; anything else is reduced to its error class.
    console.error(toSafeMessage(e));
    process.exit(e instanceof RwtsaSafeError ? 2 : 1);
  }
);
