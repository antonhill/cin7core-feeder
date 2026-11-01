import { describe, expect, it } from "vitest";
import { mfgModel } from "@/rwtsa-demo/state/mfg-model";
import { parseMfgSettings } from "@/rwtsa-demo/state/mfg-settings";
import type { DemoState } from "@/rwtsa-demo/state/demo-state";
import { mfgDataset } from "./mfg-fixture";

/** The overhead / efficiency rule must withhold totals even when the engine COULD total some style (a different style lacks the values). */
const state = (provenance: "LOCAL WORKBOOK" | "SYNTHETIC"): DemoState => ({
  kind: "validated",
  provenance,
  summary: { structure: "PASS", tabs: {}, findings: [], readiness: [], scenariosReady: 0, readinessConfig: { forecastWindowMonths: 6 }, sourceLabel: "x" } as never,
  dataset: mfgDataset({
    items: [{ style: "A", size: "M", std: 10 }, { style: "B", size: "M", std: 10 }],
    bom: [{ style: "A", code: "F", type: "Fabric", qty: 1, cost: 10 }, { style: "B", code: "F", type: "Fabric", qty: 1, cost: 10 }],
    ops: [{ style: "A", op: "Sew", smv: 2, cpm: 1.5, overhead: 0.1, efficiency: 0.85 }, { style: "B", op: "Sew", smv: 2, cpm: 1.5, overhead: null, efficiency: null }],
  }),
});
const sizes = (m: ReturnType<typeof mfgModel>) => m.costing!.styles.flatMap((s) => s.sizes);

describe("Scenario B model: the open overhead rule hides every cost total and selling price", () => {
  it("LOCAL: a style the engine can total is still withheld while any routing line lacks overhead / efficiency", () => {
    const m = mfgModel(state("LOCAL WORKBOOK"), parseMfgSettings({ scale: "fraction" }, { suggestedScale: null }));
    expect(m.rules.map((r) => r.id)).toEqual(["overhead-efficiency-margin"]);
    expect(sizes(m).every((z) => z.totalCents === null && z.sellingCents === null && z.diffCents === null && z.status === "incomplete")).toBe(true);
    expect(m.size?.totalCents).toBeNull();
  });
  it("the same data as SYNTHETIC is untouched: the engine's own totals are shown", () => {
    const m = mfgModel(state("SYNTHETIC"), parseMfgSettings({ scale: "fraction", style: "A" }, { suggestedScale: "fraction" }));
    expect(m.rules).toEqual([]);
    expect(m.costing!.styles.find((s) => s.styleCode === "A")!.sizes[0].totalCents).not.toBeNull();
  });
});
