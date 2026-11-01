import { runFxExposure, type ExposureResult } from "@/rwtsa-demo/engine/fx-exposure";
import { runLandedCost, type LandedLine, type LandedResult } from "@/rwtsa-demo/engine/landed-cost";
import { bannerOf, isScenarioReady, provenanceOf, reasonsFor, type Banner, type DemoState, type ProvenanceLabel, type ReadinessLabel } from "@/rwtsa-demo/state/demo-state";
import type { LandedSettings } from "@/rwtsa-demo/state/landed-settings";

export interface LandedModel {
  readonly provenance: ProvenanceLabel;
  readonly banner: Banner;
  readonly structure: "PASS" | "FAIL" | "NO DATA" | "ERROR";
  readonly readiness: ReadinessLabel;
  readonly readinessReasons: readonly string[];
  readonly engine: "AVAILABLE" | "UNAVAILABLE";
  readonly engineNote: string | null;
  readonly settings: LandedSettings;
  readonly landed: LandedResult | null;
  readonly exposure: ExposureResult | null;
  readonly shipmentRefs: readonly string[];
  /** Lines after the shipment / issues filters. */
  readonly lines: readonly LandedLine[];
}

export function landedModel(state: DemoState, settings: LandedSettings): LandedModel {
  const ready = isScenarioReady(state, "C");
  const base = {
    provenance: provenanceOf(state),
    banner: bannerOf(state),
    structure: state.kind === "validated" ? state.summary.structure : state.kind === "not-loaded" ? ("NO DATA" as const) : ("ERROR" as const),
    readiness: (ready ? "READY" : "NOT READY") as ReadinessLabel,
    readinessReasons: ready ? [] : reasonsFor(state, "C"),
    settings,
    shipmentRefs: [] as string[],
    lines: [] as LandedLine[],
  };
  if (state.kind !== "validated" || state.dataset === null) {
    return { ...base, engine: "UNAVAILABLE", engineNote: "No validated dataset is available: the engines have nothing to calculate from. No other data was substituted.", landed: null, exposure: null };
  }
  try {
    const landed = runLandedCost(state.dataset, { dutyRatePct: settings.dutyRatePct });
    const exposure = runFxExposure(state.dataset, { asOf: settings.asOf, bucket: settings.bucket });
    const shipmentRefs = landed.shipments.map((s) => s.shipmentRef);
    const lines = landed.lines.filter((l) => (settings.shipment === null || l.shipmentRef === settings.shipment) && (!settings.issuesOnly || l.status === "incomplete" || !l.comparisonAvailable || (l.freightDiffCents ?? 0) !== 0));
    return { ...base, engine: "AVAILABLE", engineNote: null, landed, exposure, shipmentRefs, lines };
  } catch {
    return { ...base, engine: "UNAVAILABLE", engineNote: "The engines could not run with these inputs.", landed: null, exposure: null };
  }
}
