import { runCosting, type CostingResult, type SizeCosting, type StyleCosting } from "@/rwtsa-demo/engine/bom-costing";
import { runProductionVariance, type GroupVariance, type VarianceResult } from "@/rwtsa-demo/engine/production-variance";
import { bannerOf, isScenarioReady, provenanceOf, reasonsFor, type Banner, type DemoState, type ProvenanceLabel, type ReadinessLabel } from "@/rwtsa-demo/state/demo-state";
import type { MfgSettings } from "@/rwtsa-demo/state/mfg-settings";
import type { PercentScale } from "@/rwtsa-demo/engine/bom-costing";
import { overheadRule, overheadUnresolved, rulesApply, type UnresolvedRule } from "@/rwtsa-demo/state/rules";

/** The synthetic source declares its own percentage scale (the fixture is known to use fractions). A local workbook declares none. */
export function suggestedScaleFor(state: DemoState): PercentScale | null {
  return state.kind === "validated" && state.provenance === "SYNTHETIC" ? "fraction" : null;
}

export interface MfgModel {
  readonly provenance: ProvenanceLabel;
  readonly banner: Banner;
  readonly structure: "PASS" | "FAIL" | "NO DATA" | "ERROR";
  readonly readiness: ReadinessLabel;
  readonly readinessReasons: readonly string[];
  readonly engine: "AVAILABLE" | "UNAVAILABLE";
  readonly engineNote: string | null;
  /** Only a validated local workbook can make real-data readiness VERIFIED; and then only structure, never units or scale. */
  readonly realWorkbook: "UNVERIFIED" | "STRUCTURE VALIDATED, UNITS AND SCALE UNVERIFIED";
  readonly settings: MfgSettings;
  readonly variance: VarianceResult | null;
  readonly costing: CostingResult | null;
  readonly groups: readonly GroupVariance[];
  readonly styles: readonly string[];
  readonly style: StyleCosting | null;
  readonly size: SizeCosting | null;
  /** Commercial rules the workbook does not establish (local workbook only). */
  readonly rules: readonly UnresolvedRule[];
}

export function mfgModel(state: DemoState, settings: MfgSettings): MfgModel {
  const ready = isScenarioReady(state, "B");
  const base = {
    provenance: provenanceOf(state),
    banner: bannerOf(state),
    structure: state.kind === "validated" ? state.summary.structure : state.kind === "not-loaded" ? ("NO DATA" as const) : ("ERROR" as const),
    readiness: (ready ? "READY" : "NOT READY") as ReadinessLabel,
    readinessReasons: ready ? [] : reasonsFor(state, "B"),
    realWorkbook: (state.kind === "validated" && state.provenance === "LOCAL WORKBOOK" && state.summary.structure === "PASS" ? "STRUCTURE VALIDATED, UNITS AND SCALE UNVERIFIED" : "UNVERIFIED") as MfgModel["realWorkbook"],
    settings,
    styles: [] as string[],
    rules: [] as UnresolvedRule[],
  };
  if (state.kind !== "validated" || state.dataset === null) {
    return { ...base, engine: "UNAVAILABLE", engineNote: "No validated dataset is available: the engines have nothing to calculate from. No other data was substituted.", variance: null, costing: null, groups: [], style: null, size: null };
  }
  try {
    const variance = runProductionVariance(state.dataset, { bracketBreaks: settings.bracketBreaks });
    const costing = runCosting(state.dataset, { percentScale: settings.percentScale, markup: settings.markup, sizeRule: settings.sizeRule });
    const styles = costing.styles.map((s) => s.styleCode);
    const style = costing.styles.find((s) => s.styleCode === settings.style) ?? costing.styles[0] ?? null;
    const size = style ? (style.sizes.find((z) => z.size === settings.size) ?? style.sizes.find((z) => z.size === "M") ?? style.sizes[0] ?? null) : null;
    const groups = settings.by === "line" ? variance.byLine : settings.by === "bracket" ? variance.byBracket : variance.byStyle;
    const rules: UnresolvedRule[] = rulesApply(state) && overheadUnresolved(state.dataset) ? [overheadRule()] : [];
    if (rules.length === 0) return { ...base, engine: "AVAILABLE", engineNote: null, variance, costing, groups, styles, style, size, rules };
    // While the overhead / efficiency rule is open no product cost total, selling price or reference difference may be shown,
    // whatever the engine could compute for a style whose routing happens to carry some values.
    const reason = "overhead / efficiency rule unresolved: product cost withheld";
    const hide = (z: SizeCosting): SizeCosting => ({ ...z, totalCents: null, sellingCents: null, diffCents: null, diffPct: null, deltaVsBaseCents: null, status: "incomplete", missing: z.missing.includes(reason) ? z.missing : [...z.missing, reason] });
    // The engine's own checks and warnings describe the totals that are now withheld, so they are not shown either.
    const hidden: CostingResult = { ...costing, checks: [], warnings: ["Cost totals and selling prices are withheld while the overhead / efficiency rule is unresolved."], styles: costing.styles.map((st) => ({ ...st, sizes: st.sizes.map(hide) })) };
    const hStyle = hidden.styles.find((s) => s.styleCode === style?.styleCode) ?? null;
    const hSize = hStyle ? (hStyle.sizes.find((z) => z.size === size?.size) ?? null) : null;
    return { ...base, engine: "AVAILABLE", engineNote: null, variance, costing: hidden, groups, styles, style: hStyle, size: hSize, rules };
  } catch {
    return { ...base, engine: "UNAVAILABLE", engineNote: "The engines could not run with these inputs.", variance: null, costing: null, groups: [], style: null, size: null };
  }
}
