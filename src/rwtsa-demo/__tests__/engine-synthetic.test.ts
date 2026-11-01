import { describe, expect, it } from "vitest";
import { buildSyntheticWorkbook, SYNTHETIC_SIZE_CURVE } from "@/rwtsa-demo/fixtures/synthetic";
import { runRedFlag, type Exclusion } from "@/rwtsa-demo/engine";
import type { RwtsaDataset } from "@/rwtsa-demo/dataset";
import { buildSynth } from "./helpers";

/** The Red Flag engine on the SYNTHETIC workbook, end to end through the real adapter. */

async function dataset(): Promise<RwtsaDataset> {
  const built = await buildSynth();
  if (!built.dataset) throw new Error("synthetic dataset did not build");
  return built.dataset;
}
const cfg = { sizeCurve: { kind: "explicit" as const, weights: SYNTHETIC_SIZE_CURVE } };
const planted = buildSyntheticWorkbook().planted;

describe("Red Flag engine on the synthetic workbook", () => {
  it("detects the planted tender spike on exactly the spike style, inside the forecast window", async () => {
    const r = runRedFlag(await dataset(), cfg, []);
    const mine = r.anomalies.filter((a) => a.inWindow);
    expect(mine.length).toBe(8);
    expect(new Set(mine.map((a) => a.styleCode))).toEqual(new Set([planted.tenderSpike.styleCode]));
    expect(new Set(mine.map((a) => a.month))).toEqual(new Set([planted.tenderSpike.month]));
    expect(r.summary.anomaliesToReview).toBe(8);
    expect(r.window.months).toContain(planted.tenderSpike.month);
  });

  it("the spike causes false stock-outs and excluding it (with a reason) removes them", async () => {
    const ds = await dataset();
    const before = runRedFlag(ds, cfg, []);
    const exclusions: Exclusion[] = before.anomalies.map((a) => ({ sku: a.sku, month: a.month, reason: "One-off tender order, not standing demand" }));
    const after = runRedFlag(ds, cfg, exclusions);
    const spikeStyle = planted.tenderSpike.styleCode;
    const pick = (r: typeof before) => r.skus.filter((s) => s.styleCode === spikeStyle);
    const falseBefore = pick(before).filter((s) => s.shortfall > 0);
    expect(falseBefore.length).toBeGreaterThanOrEqual(4);
    expect(pick(after).filter((s) => s.shortfall > 0)).toEqual([]);
    expect(pick(after).every((s) => s.proposedOrder === 0 && s.firstBreachWeek === null)).toBe(true);
    expect(after.summary.totalProposedOrder).toBeLessThan(before.summary.totalProposedOrder);
    expect(after.summary.anomaliesToReview).toBe(0);
    expect(after.summary.anomaliesExcluded).toBe(8);
    // Other styles are untouched by the exclusions.
    const others = (r: typeof before) => r.skus.filter((s) => s.styleCode !== spikeStyle).map((s) => [s.sku, s.proposedOrder, s.firstBreachWeek]);
    expect(others(after)).toEqual(others(before));
  });

  it("exposes the planted overdue on-water PO as the week-1 assumption, and the tender SKU as exempt", async () => {
    const r = runRedFlag(await dataset(), cfg, []);
    expect(r.inbound.overdueAssumedWeek1Units).toBe(1200);
    expect(r.assumptions.map((a) => a.id)).toEqual(expect.arrayContaining(["overdue-on-water", "history-gap"]));
    const t = r.skus.find((s) => s.sku === planted.tenderSku)!;
    expect(t.tenderExempt).toBe(true);
    expect(t.proposedOrder).toBe(0);
    expect(r.summary.tenderExemptSkus).toBe(1);
    expect(r.inbound.unallocatedStyleUnits).toBe(0);
  });

  it("history ends before the stock date: the gap is visible and strict anchoring refuses to forecast", async () => {
    const ds = await dataset();
    expect(ds.months[ds.months.length - 1]).toBe("2026-08");
    const lenient = runRedFlag(ds, cfg, []);
    expect(lenient.window.gapMonths).toEqual(["2026-09", "2026-10"]);
    expect(lenient.summary.skusWithoutForecast).toBe(0);
    const strict = runRedFlag(ds, { ...cfg, historyAnchor: "strict" }, []);
    expect(strict.summary.skusWithoutForecast).toBe(strict.summary.skuCount);
    expect(strict.summary.shortageSkus).toBe(0);
    expect(strict.limitations.join(" ")).toMatch(/2026-09, 2026-10/);
  });

  it("without a size curve, style-level synthetic POs are held unallocated and reported", async () => {
    const r = runRedFlag(await dataset(), {}, []);
    expect(r.inbound.unallocatedStyleUnits).toBe(1200 + 900 + 700 + 1500);
  });

  it("computed Available agrees with the workbook's Available on the synthetic data", async () => {
    expect(runRedFlag(await dataset(), cfg, []).summary.availableMismatchSkus).toBe(0);
  });

  it("is deterministic across runs", async () => {
    const ds = await dataset();
    expect(JSON.stringify(runRedFlag(ds, cfg, []))).toBe(JSON.stringify(runRedFlag(ds, cfg, [])));
  });
});
