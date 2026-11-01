import { SYNTHETIC_SIZE_CURVE } from "@/rwtsa-demo/fixtures/synthetic";
import { runRedFlag, type Exclusion, type RedFlagResult, type SkuResult, type StyleResult } from "@/rwtsa-demo/engine";
import { bannerOf, isScenarioReady, provenanceOf, reasonsFor, type Banner, type DemoState, type ProvenanceLabel, type ReadinessLabel } from "@/rwtsa-demo/state/demo-state";
import type { RedFlagSettings } from "@/rwtsa-demo/state/red-flag-settings";

/** The size curve supplied with the SYNTHETIC source only. A local workbook has none until one is supplied. */
export function suppliedCurveFor(state: DemoState): Readonly<Record<string, number>> | null {
  return state.kind === "validated" && state.provenance === "SYNTHETIC" ? SYNTHETIC_SIZE_CURVE : null;
}

export type EngineStatus = "AVAILABLE" | "UNAVAILABLE";
export type ForecastBasis = "ANCHORED" | "ASSUMED" | "LIMITED" | "NONE";

export interface ResultRow {
  readonly key: string;
  readonly sku: string | null;
  readonly style: string;
  readonly size: string | null;
  readonly tenderExempt: boolean;
  readonly available: number | null;
  readonly inbound: number;
  readonly weeklyForecast: number | null;
  readonly firstBreachWeek: number | null;
  readonly shortfall: number;
  readonly monthsOfCover: number | null;
  readonly anomaly: string;
  readonly anomalyKind: "none" | "review" | "excluded";
  readonly proposedOrder: number;
  readonly limitation: string | null;
}

export interface ChartSeries {
  readonly key: string;
  readonly title: string;
  /** Opening Available (week 0), then the closing balance of weeks 1..H. */
  readonly opening: number | null;
  readonly balances: readonly number[];
  readonly minLevel: number | null;
  readonly firstBreachWeek: number | null;
  readonly horizon: number;
  readonly note: string | null;
}

export interface RedFlagModel {
  readonly provenance: ProvenanceLabel;
  readonly banner: Banner;
  readonly structure: "PASS" | "FAIL" | "NO DATA" | "ERROR";
  readonly readiness: ReadinessLabel;
  readonly readinessReasons: readonly string[];
  readonly engine: EngineStatus;
  readonly engineNote: string | null;
  readonly basis: ForecastBasis;
  readonly settings: RedFlagSettings;
  readonly sourceLabel: string | null;
  readonly result: RedFlagResult | null;
  readonly rows: readonly ResultRow[];
  readonly chart: ChartSeries | null;
  readonly styles: readonly string[];
  readonly exclusions: readonly Exclusion[];
  readonly stateError: string | null;
}

function skuAnomalyText(s: SkuResult, r: RedFlagResult): { text: string; kind: "none" | "review" | "excluded" } {
  const mine = r.anomalies.filter((a) => a.sku === s.sku && a.inWindow);
  if (mine.length === 0) return { text: "-", kind: "none" };
  const pending = mine.filter((a) => !a.excluded);
  if (pending.length > 0) return { text: `REVIEW ${pending.map((a) => `${a.month} (${a.qty} vs median ${a.median})`).join("; ")}`, kind: "review" };
  return { text: `EXCLUDED ${mine.map((a) => a.month).join(", ")}`, kind: "excluded" };
}

function styleAnomalyText(st: StyleResult): { text: string; kind: "none" | "review" | "excluded" } {
  if (st.anomaliesToReview > 0) return { text: `REVIEW ${st.anomaliesToReview} SKU month(s)${st.anomaliesExcluded > 0 ? `, ${st.anomaliesExcluded} excluded` : ""}`, kind: "review" };
  if (st.anomaliesExcluded > 0) return { text: `EXCLUDED ${st.anomaliesExcluded} SKU month(s)`, kind: "excluded" };
  return { text: "-", kind: "none" };
}

export function redFlagModel(state: DemoState, settings: RedFlagSettings, exclusions: readonly Exclusion[], stateError: string | null = null): RedFlagModel {
  const ready = isScenarioReady(state, "A");
  const base = {
    provenance: provenanceOf(state),
    banner: bannerOf(state),
    readiness: (ready ? "READY" : "NOT READY") as ReadinessLabel,
    readinessReasons: ready ? [] : reasonsFor(state, "A"),
    settings,
    sourceLabel: state.kind === "validated" ? state.summary.sourceLabel : null,
    styles: [] as string[],
    exclusions,
    stateError,
  };
  const structure = state.kind === "validated" ? state.summary.structure : state.kind === "not-loaded" ? ("NO DATA" as const) : ("ERROR" as const);
  if (stateError !== null && state.kind === "validated") {
    return { ...base, structure, engine: "UNAVAILABLE", engineNote: "The saved exclusions could not be read, so no figures are shown: they could include distorted, unreviewed demand.", basis: "NONE", result: null, rows: [], chart: null };
  }
  if (state.kind !== "validated" || state.dataset === null) {
    return { ...base, structure, engine: "UNAVAILABLE", engineNote: "No validated dataset is available: the engine has nothing to calculate from. No other data was substituted.", basis: "NONE", result: null, rows: [], chart: null };
  }

  let result: RedFlagResult;
  try {
    result = runRedFlag(state.dataset, settings.config, exclusions);
  } catch (e) {
    const message = e instanceof Error && /^(An exclusion|Exclusion|Invalid)/.test(e.message) ? e.message : "The engine could not run with these inputs.";
    return { ...base, structure, engine: "UNAVAILABLE", engineNote: message, basis: "NONE", result: null, rows: [], chart: null };
  }

  const styleNames = [...new Set(result.skus.map((s) => s.styleCode))].sort();
  const shortOnly = settings.shortageOnly;
  const styleOk = (code: string) => settings.style === null || settings.style === code;

  let rows: ResultRow[];
  if (settings.view === "sku") {
    rows = result.skus
      .filter((s) => styleOk(s.styleCode) && (!shortOnly || (!s.tenderExempt && s.shortfall > 0)))
      .map((s) => {
        const a = skuAnomalyText(s, result);
        return { key: s.sku, sku: s.sku, style: s.styleCode, size: s.size, tenderExempt: s.tenderExempt, available: s.available, inbound: s.inboundTotal, weeklyForecast: s.weeklyForecast, firstBreachWeek: s.firstBreachWeek, shortfall: s.shortfall, monthsOfCover: s.monthsOfCover, anomaly: a.text, anomalyKind: a.kind, proposedOrder: s.proposedOrder, limitation: s.limitation };
      });
  } else {
    rows = result.styles
      .filter((st) => styleOk(st.styleCode) && (!shortOnly || st.shortageSkus > 0))
      .map((st) => {
        const a = styleAnomalyText(st);
        const limit = st.skusWithoutForecast > 0 ? `${st.skusWithoutForecast} SKU(s) have no forecast and are left out of cover and shortage.` : null;
        return { key: st.styleCode, sku: null, style: st.styleCode, size: null, tenderExempt: st.tenderExemptSkus === st.skuCount, available: st.available, inbound: st.inboundTotal, weeklyForecast: st.weeklyForecast, firstBreachWeek: st.firstBreachWeek, shortfall: st.shortfall, monthsOfCover: st.monthsOfCover, anomaly: a.text, anomalyKind: a.kind, proposedOrder: st.proposedOrder, limitation: limit };
      });
  }

  const selected = rows.find((r) => r.key === settings.sel) ?? rows.find((r) => r.shortfall > 0 && !r.tenderExempt) ?? rows[0];
  let chart: ChartSeries | null = null;
  if (selected) {
    if (settings.view === "sku") {
      const s = result.skus.find((x) => x.sku === selected.key) as SkuResult;
      chart = { key: s.sku, title: `${s.sku} (${s.styleCode}, ${s.size})`, opening: s.available, balances: s.balances, minLevel: s.minLevel, firstBreachWeek: s.firstBreachWeek, horizon: result.config.horizonWeeks, note: s.balances.length === 0 ? (s.limitation ?? "Cannot be projected.") : null };
    } else {
      const st = result.styles.find((x) => x.styleCode === selected.key) as StyleResult;
      chart = { key: st.styleCode, title: `${st.styleCode} (sum of its SKUs)`, opening: st.projectedOpening, balances: st.balances, minLevel: st.minLevel, firstBreachWeek: st.firstBreachWeek, horizon: result.config.horizonWeeks, note: "Style balance is the sum of its SKU balances; sizes are not netted for ordering." };
    }
  }

  const w = result.window;
  const basis: ForecastBasis =
    result.config.historyAnchor === "strict"
      ? w.missingMonths.length > 0 ? "LIMITED" : "ANCHORED"
      : w.gapMonths.length > 0 ? "ASSUMED" : "ANCHORED";

  return { ...base, structure, engine: "AVAILABLE", engineNote: null, basis, result, rows, chart, styles: styleNames };
}
