import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { TAB_CONTRACTS, TAB_NAMES, type TabName } from "@/rwtsa-demo/contracts/tabs";
import type { ReadinessConfig, RwtsaDataset, ScenarioReadiness } from "@/rwtsa-demo/dataset";
import { RwtsaSafeError, type Finding } from "@/rwtsa-demo/findings";
import { buildDataset, type HeaderOverrides } from "@/rwtsa-demo/workbook/build-dataset";
import { assertWorkbookPathAllowed } from "@/rwtsa-demo/workbook/path-guard";
import { readWorkbookFile } from "@/rwtsa-demo/workbook/read";

/**
 * Local structural validation of the protected workbook. The certificate is the ONLY basis on which a screen
 * may claim "live data validated": it records pass/fail, per-tab presence, row counts, missing canonical
 * header names and value-free findings. It contains no cell value, no file name and no path.
 */

export interface TabValidation {
  readonly present: boolean;
  readonly rows: number | null;
  /** Our canonical field keys that no workbook header matched. */
  readonly missingFields: readonly string[];
}

/**
 * Written when a run fails BEFORE a verdict exists (unreadable path, bad header map, bad option, ...). It carries the
 * same `runId` discipline as a real certificate so that no artefact from an earlier run can be mistaken for this one.
 */
export interface ErrorCertificate {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly status: "error";
  readonly validatedAt: string;
  /** A value-free message (a static string from this code base or an error class name). */
  readonly message: string;
}

export interface ValidationCertificate {
  readonly schemaVersion: 1;
  /** Identifies this validation run. reconciliation.json from the same run carries the same id; none from another run can remain. */
  readonly runId: string;
  readonly provenance: "local-workbook";
  readonly validatedAt: string;
  readonly status: "pass" | "fail";
  readonly fileSha256: string;
  readonly sizeBytes: number;
  readonly tabs: Readonly<Record<TabName, TabValidation>>;
  readonly findings: readonly Finding[];
  /**
   * Per-scenario readiness, SEPARATE from `status`: `status: "pass"` means the workbook is structurally valid and
   * complete in its core tabs; a scenario is `ready` only if, in addition, its own record tabs have data and the
   * optional columns its calculations need are present.
   */
  readonly readiness: readonly ScenarioReadiness[];
  /** How many of the 4 scenarios are READY. `status: "pass"` with 0 ready is legitimate and never means "demonstration ready". */
  readonly scenariosReady: number;
  readonly readinessConfig: ReadinessConfig;
  /** Content hash of the validated data (null on fail). Irreversible; for matching a later run to this one. */
  readonly controlHash: string | null;
}

const overridesSchema = z.record(z.string(), z.record(z.string(), z.string().min(1)));

/**
 * Loads a LOCAL header-map file: { "<Tab>": { "<canonicalFieldKey>": "<real header text>" } }.
 * It must live outside every git working tree. Errors never echo the file's content.
 */
export function loadHeaderOverrides(file: string): HeaderOverrides {
  const real = assertWorkbookPathAllowed(file);
  let parsed: z.infer<typeof overridesSchema>;
  try {
    parsed = overridesSchema.parse(JSON.parse(readFileSync(real, "utf8")));
  } catch {
    throw new RwtsaSafeError("not_a_workbook", "The header-map file is not valid JSON of the form { Tab: { fieldKey: headerText } }.");
  }
  const out: HeaderOverrides = {};
  let unknown = 0;
  for (const [tab, map] of Object.entries(parsed)) {
    if (!(TAB_NAMES as readonly string[]).includes(tab)) {
      unknown++;
      continue;
    }
    const allowed = new Set(TAB_CONTRACTS[tab as TabName].fields.map((f) => f.key));
    const kept: Record<string, string> = {};
    for (const [field, header] of Object.entries(map)) {
      if (allowed.has(field)) kept[field] = header;
      else unknown++;
    }
    out[tab as TabName] = kept;
  }
  if (unknown > 0) throw new RwtsaSafeError("unknown_column", `The header-map file names ${unknown} tab(s) or field(s) that are not in the contract.`);
  return out;
}

export async function validateWorkbookFile(
  file: string,
  opts: { headerOverrides?: HeaderOverrides; now?: Date; runId?: string; readiness?: Partial<ReadinessConfig> } = {}
): Promise<{ certificate: ValidationCertificate; dataset: RwtsaDataset | null }> {
  const read = await readWorkbookFile(file);
  const built = buildDataset(read, {
    provenance: "local-workbook",
    source: { label: `local-workbook:${read.sha256.slice(0, 12)}`, sha256: read.sha256, sizeBytes: read.sizeBytes },
    headerOverrides: opts.headerOverrides,
    readiness: opts.readiness,
  });

  const tabs = {} as Record<TabName, TabValidation>;
  for (const tab of TAB_NAMES) {
    tabs[tab] = {
      present: Boolean(read.tables[tab]),
      rows: built.parsedRowCounts[tab] ?? null,
      missingFields: built.findings.filter((f) => f.tab === tab && f.code === "missing_header" && f.field).map((f) => f.field!),
    };
  }

  const certificate: ValidationCertificate = {
    schemaVersion: 1,
    runId: opts.runId ?? randomUUID(),
    provenance: "local-workbook",
    validatedAt: (opts.now ?? new Date()).toISOString(),
    status: built.ok ? "pass" : "fail",
    fileSha256: read.sha256,
    sizeBytes: read.sizeBytes,
    tabs,
    findings: built.findings,
    readiness: built.readiness,
    scenariosReady: built.readiness.filter((r) => r.ready).length,
    readinessConfig: built.readinessConfig,
    controlHash: built.dataset?.reconciliation.controlHash ?? null,
  };
  return { certificate, dataset: built.dataset };
}
