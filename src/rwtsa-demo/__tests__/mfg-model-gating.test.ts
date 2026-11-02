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

describe("Scenario B model: the open overhead rule withholds fully loaded totals only", () => {
  it("LOCAL: a style whose total includes the per-operation percentages is withheld; a style on the base basis keeps its cost", () => {
    const m = mfgModel(state("LOCAL WORKBOOK"), parseMfgSettings({ scale: "fraction" }, { suggestedScale: null }));
    expect(m.rules.map((r) => r.id)).toEqual(["overhead-efficiency-margin"]);
    const A = m.costing!.styles.find((s) => s.styleCode === "A")!.sizes[0];
    const B = m.costing!.styles.find((s) => s.styleCode === "B")!.sizes[0];
    expect([A.totalCents, A.sellingCents, A.diffCents, A.status]).toEqual([null, null, null, "incomplete"]);
    expect(A.missing.join(" ")).toMatch(/fully loaded cost withheld/);
    expect(A.baseBomCents).not.toBeNull(); // the base basis is still known
    expect(B.status).toBe("complete");
    expect(B.totalCents).toBe(B.baseBomCents);
    expect(B.sellingCents).not.toBeNull();
    expect(m.costing!.checks).toEqual([]);
    expect(m.costing!.warnings.join(" ")).toMatch(/withheld/i);
  });
  it("the same data as SYNTHETIC is untouched: the engine's own totals are shown", () => {
    const m = mfgModel(state("SYNTHETIC"), parseMfgSettings({ scale: "fraction", style: "A" }, { suggestedScale: "fraction" }));
    expect(m.rules).toEqual([]);
    expect(m.costing!.styles.find((s) => s.styleCode === "A")!.sizes[0].totalCents).not.toBeNull();
  });
});
