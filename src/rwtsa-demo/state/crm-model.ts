import { runQuoteConversion, type QuoteRecord, type QuoteResult } from "@/rwtsa-demo/engine/quote-conversion";
import { bannerOf, isScenarioReady, provenanceOf, reasonsFor, type Banner, type DemoState, type ProvenanceLabel, type ReadinessLabel } from "@/rwtsa-demo/state/demo-state";
import type { CrmSettings } from "@/rwtsa-demo/state/crm-settings";

export interface CrmModel {
  readonly provenance: ProvenanceLabel;
  readonly banner: Banner;
  readonly structure: "PASS" | "FAIL" | "NO DATA" | "ERROR";
  readonly readiness: ReadinessLabel;
  readonly readinessReasons: readonly string[];
  readonly engine: "AVAILABLE" | "UNAVAILABLE";
  readonly engineNote: string | null;
  /** Only a validated local workbook can pass structure; its units and values are never verified here. */
  readonly realWorkbook: "UNVERIFIED" | "STRUCTURE VALIDATED, UNITS AND SCALE UNVERIFIED";
  /** The settings actually applied: a filter naming something not in the loaded data is dropped and reported. */
  readonly settings: CrmSettings;
  readonly result: QuoteResult | null;
  /** The quote list: the analytics' quotes, narrowed by the status filter only. */
  readonly detail: readonly QuoteRecord[];
}

export function crmModel(state: DemoState, requested: CrmSettings): CrmModel {
  const ready = isScenarioReady(state, "D");
  const base = {
    provenance: provenanceOf(state),
    banner: bannerOf(state),
    structure: state.kind === "validated" ? state.summary.structure : state.kind === "not-loaded" ? ("NO DATA" as const) : ("ERROR" as const),
    readiness: (ready ? "READY" : "NOT READY") as ReadinessLabel,
    readinessReasons: ready ? [] : reasonsFor(state, "D"),
    realWorkbook: (state.kind === "validated" && state.provenance === "LOCAL WORKBOOK" && state.summary.structure === "PASS" ? "STRUCTURE VALIDATED, UNITS AND SCALE UNVERIFIED" : "UNVERIFIED") as CrmModel["realWorkbook"],
  };
  if (state.kind !== "validated" || state.dataset === null) {
    return { ...base, engine: "UNAVAILABLE", engineNote: "No validated dataset is available: the engine has nothing to calculate from. No other data was substituted.", settings: requested, result: null, detail: [] };
  }
  try {
    // A filter must name something that is in the loaded data; otherwise it is dropped (and reported), never silently empty.
    const options = runQuoteConversion(state.dataset).options;
    const errors = [...requested.errors];
    const known = (v: string | null, list: readonly string[], label: string): string | null => {
      if (v === null) return null;
      if (list.some((x) => x.toLowerCase() === v.toLowerCase())) return v;
      errors.push(`${label}: not in the loaded data, so the filter was not applied.`);
      return null;
    };
    const rep = known(requested.rep, options.reps, "Sales representative");
    const customer = known(requested.customer, options.customers, "Customer");
    const product = known(requested.product, options.products, "Product");
    const settings: CrmSettings = { ...requested, rep, customer, product, values: { ...requested.values, rep: rep ?? "", customer: customer ?? "", product: product ?? "" }, errors };
    const result = runQuoteConversion(state.dataset, { from: settings.from, to: settings.to, rep, customer, product, grain: settings.grain });
    const detail = settings.status === "ALL" ? result.records : result.records.filter((q) => q.status === settings.status);
    return { ...base, engine: "AVAILABLE", engineNote: null, settings, result, detail };
  } catch {
    return { ...base, engine: "UNAVAILABLE", engineNote: "The engine could not run with these inputs.", settings: requested, result: null, detail: [] };
  }
}
