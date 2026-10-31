import type { ScenarioId } from "@/rwtsa-demo/contracts/fields";
import { SCENARIO_TABS, TAB_NAMES, type TabName } from "@/rwtsa-demo/contracts/tabs";
import { DEFAULT_FORECAST_WINDOW_MONTHS, type ReadinessConfig, type ScenarioReadiness } from "@/rwtsa-demo/dataset";
import { toSafeMessage, type Finding } from "@/rwtsa-demo/findings";
import { buildSyntheticWorkbook } from "@/rwtsa-demo/fixtures/synthetic";
import { SCENARIOS, scenarioById, type Assumption, type Capability, type ScenarioMeta } from "@/rwtsa-demo/state/layers";
import { buildDataset } from "@/rwtsa-demo/workbook/build-dataset";
import { normaliseReadinessConfig, parseForecastWindowText } from "@/rwtsa-demo/workbook/readiness";
import { readWorkbookBuffer } from "@/rwtsa-demo/workbook/read";
import { loadHeaderOverrides, summariseTabs, validateWorkbookFile, type TabValidation } from "@/rwtsa-demo/workbook/validate-file";

/**
 * The demonstration shell's state: what data (if any) is loaded, where it came from, how it validated, and, derived ONLY
 * from the validator's per-scenario flags, which scenarios are READY.
 *
 * Rules (owner direction for PR-2):
 *  - Synthetic data is used ONLY when explicitly selected (RWTSA_SOURCE=synthetic). It is never a fallback.
 *  - A local workbook that is missing, unreadable or invalid yields NOT READY everywhere. It never falls back to
 *    synthetic data, and selecting both sources at once is a configuration error.
 *  - STRUCTURE PASS is never presented as readiness; READY comes only from `ScenarioReadiness.ready`.
 *  - Everything surfaced is value-free (tab names, canonical field keys, counts, reason classes).
 */

export type ProvenanceLabel = "SYNTHETIC" | "LOCAL WORKBOOK" | "NO DATA";

/** Raw configuration text (the app reads RWTSA_* environment variables and passes them in; this module reads none). */
export interface DemoConfig {
  readonly source?: string;
  readonly workbookPath?: string;
  readonly headerMapPath?: string;
  readonly forecastWindow?: string;
  readonly syntheticSeed?: number;
  /**
   * True when running under `next dev`. Next.js's development server fetches the npm registry (its update indicator) and
   * offers no switch to stop it, so a local workbook is only ever served in production mode (`next build` then `next start`),
   * which makes no outbound calls. Synthetic data may still be shown in dev.
   */
  readonly devServer?: boolean;
}

export interface ValidationSummary {
  readonly structure: "PASS" | "FAIL";
  readonly tabs: Readonly<Record<TabName, TabValidation>>;
  readonly findings: readonly Finding[];
  readonly readiness: readonly ScenarioReadiness[];
  readonly scenariosReady: number;
  readonly readinessConfig: ReadinessConfig;
  /** `synthetic:seed=N` or `local-workbook:<sha256 prefix>`. Never a file name or path. */
  readonly sourceLabel: string;
}

export type DemoState =
  | { readonly kind: "not-loaded" }
  | { readonly kind: "config-error"; readonly message: string }
  | { readonly kind: "error"; readonly provenance: "LOCAL WORKBOOK"; readonly message: string }
  | { readonly kind: "validated"; readonly provenance: "SYNTHETIC" | "LOCAL WORKBOOK"; readonly summary: ValidationSummary };

export const DEFAULT_SYNTHETIC_SEED = 20261031;

function configError(message: string): DemoState {
  return { kind: "config-error", message };
}

export async function loadDemoState(config: DemoConfig): Promise<DemoState> {
  const source = config.source?.trim() ?? "";
  const workbookPath = config.workbookPath?.trim() ?? "";
  if (source !== "" && source !== "synthetic") return configError("RWTSA_SOURCE must be unset or exactly 'synthetic'.");
  if (source === "synthetic" && workbookPath !== "") {
    return configError("Both the synthetic source and a local workbook are selected. Choose exactly one; nothing was loaded.");
  }

  if (config.devServer === true && workbookPath !== "") {
    return configError(
      "A local workbook is only served in production mode (npm run build, then npm run start): Next.js's development server contacts the npm registry, and this shell must make no outbound calls. Nothing was loaded."
    );
  }

  let readiness: ReadinessConfig;
  try {
    readiness = normaliseReadinessConfig({
      forecastWindowMonths: config.forecastWindow === undefined || config.forecastWindow === "" ? DEFAULT_FORECAST_WINDOW_MONTHS : parseForecastWindowText(config.forecastWindow),
    });
  } catch (e) {
    return configError(toSafeMessage(e));
  }

  if (source === "synthetic") {
    const seed = config.syntheticSeed ?? DEFAULT_SYNTHETIC_SEED;
    const synth = buildSyntheticWorkbook({ seed });
    const read = await readWorkbookBuffer(Buffer.from(await synth.workbook.xlsx.writeBuffer()));
    const label = `synthetic:seed=${seed}`;
    const built = buildDataset(read, { provenance: "synthetic", source: { label }, readiness });
    const summary: ValidationSummary = {
      structure: built.ok ? "PASS" : "FAIL",
      tabs: summariseTabs(read, built),
      findings: built.findings,
      readiness: built.readiness,
      scenariosReady: built.readiness.filter((r) => r.ready).length,
      readinessConfig: built.readinessConfig,
      sourceLabel: label,
    };
    return { kind: "validated", provenance: "SYNTHETIC", summary };
  }

  if (workbookPath === "") return { kind: "not-loaded" };

  try {
    const headerOverrides = config.headerMapPath && config.headerMapPath.trim() !== "" ? loadHeaderOverrides(config.headerMapPath.trim()) : undefined;
    const { certificate } = await validateWorkbookFile(workbookPath, { headerOverrides, readiness });
    return {
      kind: "validated",
      provenance: "LOCAL WORKBOOK",
      summary: {
        structure: certificate.status === "pass" ? "PASS" : "FAIL",
        tabs: certificate.tabs,
        findings: certificate.findings,
        readiness: certificate.readiness,
        scenariosReady: certificate.scenariosReady,
        readinessConfig: certificate.readinessConfig,
        sourceLabel: `local-workbook:${certificate.fileSha256.slice(0, 12)}`,
      },
    };
  } catch (e) {
    // Missing path, a path inside a git working tree, not an .xlsx, bad header map ... Value-free by construction.
    // Deliberately NOT a fallback to synthetic data.
    return { kind: "error", provenance: "LOCAL WORKBOOK", message: toSafeMessage(e) };
  }
}

// ---------------------------------------------------------------------------------------------------- views

export type ReadinessLabel = "READY" | "NOT READY";
export type BannerTone = "warning" | "info" | "danger" | "neutral";

export interface Banner {
  readonly tone: BannerTone;
  readonly text: string;
}

export function provenanceOf(state: DemoState): ProvenanceLabel {
  return state.kind === "validated" || state.kind === "error" ? state.provenance : "NO DATA";
}

export function bannerOf(state: DemoState): Banner {
  switch (state.kind) {
    case "not-loaded":
      return { tone: "neutral", text: "NO DATA LOADED. Select the synthetic source (RWTSA_SOURCE=synthetic) or a local workbook (RWTSA_WORKBOOK_PATH)." };
    case "config-error":
      return { tone: "danger", text: `CONFIGURATION ERROR. ${state.message}` };
    case "error":
      return { tone: "danger", text: "LOCAL WORKBOOK COULD NOT BE LOADED. Nothing is READY, and no other data was substituted." };
    case "validated":
      if (state.provenance === "SYNTHETIC") return { tone: "warning", text: "SYNTHETIC TEST DATA. NOT THE ADVISOR'S WORKBOOK." };
      return state.summary.structure === "PASS"
        ? { tone: "info", text: "LOCAL WORKBOOK. Structure validated on this machine; nothing was uploaded." }
        : { tone: "danger", text: "LOCAL WORKBOOK FAILED STRUCTURAL VALIDATION. Nothing is READY, and no other data was substituted." };
  }
}

/** The ONLY place READY is decided: a validated state whose structure passed and whose validator flag for this scenario is true. */
export function isScenarioReady(state: DemoState, id: ScenarioId): boolean {
  if (state.kind !== "validated" || state.summary.structure !== "PASS") return false;
  return state.summary.readiness.find((r) => r.scenario === id)?.ready === true;
}

export interface InputRow {
  readonly tab: TabName;
  readonly present: boolean;
  readonly rows: number | null;
}

export interface ScenarioView {
  readonly meta: ScenarioMeta;
  readonly provenance: ProvenanceLabel;
  readonly banner: Banner;
  readonly readiness: ReadinessLabel;
  /** Why it is NOT READY, in value-free words (empty when READY). */
  readonly reasons: readonly string[];
  readonly inputs: readonly InputRow[];
  readonly detail: ScenarioReadiness | null;
  readonly capabilities: readonly Capability[];
  readonly assumptions: readonly Assumption[];
  readonly engineImplemented: false;
}

export function reasonsFor(state: DemoState, id: ScenarioId): string[] {
  switch (state.kind) {
    case "not-loaded":
      return ["No data is loaded."];
    case "config-error":
      return ["The demonstration is misconfigured; nothing was loaded."];
    case "error":
      return ["The local workbook could not be loaded: " + state.message];
    case "validated": {
      const out: string[] = [];
      if (state.summary.structure !== "PASS") out.push("The workbook structure is invalid (see Validation).");
      const r = state.summary.readiness.find((x) => x.scenario === id);
      if (r) {
        out.push(...r.missingTabs.map((t) => `Tab ${t} is empty or missing.`));
        out.push(...r.missingFields.map((f) => `Column ${f} is absent.`));
        out.push(...r.unpopulatedFields.map((u) => `Column ${u.field} is present but ${u.missing} row(s) that need a value have none.`));
        if (r.salesWindow && (r.salesWindow.skusIncomplete > 0 || r.salesWindow.availableMonths < r.salesWindow.requiredMonths)) {
          out.push(
            `Sales history needs ${r.salesWindow.requiredMonths} valid months per SKU: ${r.salesWindow.skusIncomplete} SKU(s) incomplete; ${r.salesWindow.availableMonths} month column(s) available.`
          );
        }
      }
      return out;
    }
  }
}

export function scenarioView(state: DemoState, id: ScenarioId): ScenarioView {
  const meta = scenarioById(id);
  const ready = isScenarioReady(state, id);
  const needed = SCENARIO_TABS[id];
  const inputs: InputRow[] = needed.map((tab) => {
    if (state.kind !== "validated") return { tab, present: false, rows: null };
    const t = state.summary.tabs[tab];
    return { tab, present: t.present, rows: t.rows };
  });
  return {
    meta,
    provenance: provenanceOf(state),
    banner: bannerOf(state),
    readiness: ready ? "READY" : "NOT READY",
    reasons: ready ? [] : reasonsFor(state, id),
    inputs,
    detail: state.kind === "validated" ? (state.summary.readiness.find((r) => r.scenario === id) ?? null) : null,
    capabilities: meta.capabilities,
    assumptions: meta.assumptions,
    engineImplemented: false,
  };
}

export interface OverviewView {
  readonly provenance: ProvenanceLabel;
  readonly banner: Banner;
  /** e.g. `STRUCTURE PASS · 4 of 4 scenarios READY`. */
  readonly headline: string;
  readonly scenariosReady: number;
  readonly scenarios: readonly { readonly id: ScenarioId; readonly slug: string; readonly title: string; readonly readiness: ReadinessLabel }[];
  readonly notices: readonly string[];
}

export function overviewView(state: DemoState): OverviewView {
  const scenarios = SCENARIOS.map((s) => ({ id: s.id, slug: s.slug, title: s.title, readiness: (isScenarioReady(state, s.id) ? "READY" : "NOT READY") as ReadinessLabel }));
  const scenariosReady = scenarios.filter((s) => s.readiness === "READY").length;
  const head =
    state.kind === "validated" ? `STRUCTURE ${state.summary.structure}` : state.kind === "not-loaded" ? "NO DATA LOADED" : state.kind === "error" ? "LOAD ERROR" : "CONFIGURATION ERROR";
  const notices = [
    "STRUCTURE PASS means the workbook is structurally valid. It does not mean any scenario is ready: only the READY flags below do.",
    "Calculation engines are not implemented in this build. No scenario shows results, forecasts or findings.",
    ...(state.kind === "validated" && state.provenance === "SYNTHETIC" ? ["Synthetic data is for development only and must not be presented as the advisor's workbook."] : []),
  ];
  return { provenance: provenanceOf(state), banner: bannerOf(state), headline: `${head} · ${scenariosReady} of ${scenarios.length} scenarios READY`, scenariosReady, scenarios, notices };
}

export interface ValidationView {
  readonly provenance: ProvenanceLabel;
  readonly banner: Banner;
  readonly structure: "PASS" | "FAIL" | "NO DATA" | "ERROR";
  readonly sourceLabel: string | null;
  readonly forecastWindowMonths: number | null;
  readonly tabs: readonly { readonly tab: TabName; readonly present: boolean; readonly rows: number | null; readonly missingFields: readonly string[] }[];
  readonly findings: readonly Finding[];
  readonly readiness: readonly { readonly scenario: ScenarioId; readonly label: ReadinessLabel; readonly reasons: readonly string[] }[];
  readonly message: string | null;
}

export function validationView(state: DemoState): ValidationView {
  const readiness = SCENARIOS.map((s) => ({ scenario: s.id, label: (isScenarioReady(state, s.id) ? "READY" : "NOT READY") as ReadinessLabel, reasons: isScenarioReady(state, s.id) ? [] : reasonsFor(state, s.id) }));
  if (state.kind !== "validated") {
    return {
      provenance: provenanceOf(state),
      banner: bannerOf(state),
      structure: state.kind === "not-loaded" ? "NO DATA" : "ERROR",
      sourceLabel: null,
      forecastWindowMonths: null,
      tabs: [],
      findings: [],
      readiness,
      message: state.kind === "not-loaded" ? null : state.message,
    };
  }
  return {
    provenance: state.provenance,
    banner: bannerOf(state),
    structure: state.summary.structure,
    sourceLabel: state.summary.sourceLabel,
    forecastWindowMonths: state.summary.readinessConfig.forecastWindowMonths,
    tabs: TAB_NAMES.map((tab) => ({ tab, ...state.summary.tabs[tab] })),
    findings: state.summary.findings,
    readiness,
    message: null,
  };
}
