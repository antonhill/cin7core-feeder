import { describe, expect, it } from "vitest";
import { fromCents } from "@/rwtsa-demo/engine/money";
import { runCosting } from "@/rwtsa-demo/engine/bom-costing";
import { runProductionVariance } from "@/rwtsa-demo/engine/production-variance";
import type { RwtsaDataset } from "@/rwtsa-demo/dataset";
import { buildSynth } from "./helpers";

/** The Scenario B engines on the SYNTHETIC workbook, end to end through the real adapter. */

async function dataset(): Promise<RwtsaDataset> {
  const built = await buildSynth();
  if (!built.dataset) throw new Error("synthetic dataset did not build");
  return built.dataset;
}
const Z = fromCents;

describe("costing on the synthetic workbook", () => {
  it("costs every style and size, with the longer zip from 3XL", async () => {
    const r = runCosting(await dataset(), { percentScale: "fraction" });
    expect(r.styles.map((s) => s.styleCode)).toEqual(["SYN-VEST-A", "SYN-VEST-B", "SYN-VEST-TT"]);
    const a = r.styles[0];
    expect(a.sizes).toHaveLength(8);
    const by = (size: string) => a.sizes.find((s) => s.size === size)!;
    expect(Z(by("M").totalCents!)).toBe(114.5); // 66 + 9 + 6.5 + 25.5 + 4.5 + 3.0
    expect(Z(by("3XL").totalCents!)).toBe(117);
    expect(Z(by("3XL").groups.trimsThreadCents!)).toBe(11.5);
    expect(by("3XL").substitutions).toEqual([{ replaced: "ZIP-SHORT", by: "ZIP-LONG", group: "zip" }]);
    expect(Z(by("M").sellingCents!)).toBe(183.2);
    expect(Z(by("3XL").sellingCents!)).toBe(187.2);
    expect(by("M").status).toBe("complete");
  });
  it("the two-tone style carries the contrast fabric (0.4 m x R48 = R19.20)", async () => {
    const r = runCosting(await dataset(), { percentScale: "fraction" });
    const tt = r.styles.find((s) => s.styleCode === "SYN-VEST-TT")!.sizes.find((s) => s.size === "M")!;
    expect(Z(tt.groups.fabricMaterialsCents!)).toBe(85.2);
    expect(Z(tt.totalCents!)).toBe(133.7);
  });
  it("compares with the reference costs and the differences are shown, not hidden", async () => {
    const r = runCosting(await dataset(), { percentScale: "fraction" });
    const a = r.styles[0].sizes;
    expect(Z(a.find((s) => s.size === "M")!.referenceCents!)).toBe(102);
    expect(Z(a.find((s) => s.size === "M")!.diffCents!)).toBe(12.5);
    expect(Z(a.find((s) => s.size === "3XL")!.diffCents!)).toBe(7);
    expect(r.checks.find((c) => c.id === "reference")!.ok).toBe(false);
    expect(r.checks.find((c) => c.id === "lines")!.ok).toBe(true);
    expect(r.checks.find((c) => c.id === "groups")!.ok).toBe(true);
  });
  it("without a chosen percentage scale every cost is incomplete and says why; the synthetic columns look like fractions", async () => {
    const r = runCosting(await dataset(), { percentScale: null });
    expect(r.styles.flatMap((s) => s.sizes).every((s) => s.status === "incomplete" && s.totalCents === null)).toBe(true);
    expect(r.scaleObservation.hint).toBe("fraction-or-small-percent");
    expect(r.styles[0].sizes[0].missing.join(" ")).toMatch(/percentage scale/);
  });
  it("the per-size difference against the smallest size is shown", async () => {
    const r = runCosting(await dataset(), { percentScale: "fraction" });
    const a = r.styles[0].sizes;
    expect(a.map((s) => Z(s.deltaVsBaseCents!))).toEqual([0, 0, 0, 0, 0, 2.5, 2.5, 2.5]);
  });
});

describe("production variance on the synthetic workbook", () => {
  it("groups the twelve orders by style, line and bracket, and every grouping reconciles to the total", async () => {
    const r = runProductionVariance(await dataset(), {});
    expect(r.orders).toHaveLength(12);
    expect(r.total.orders).toBe(12);
    expect(r.total.plannedMinutes).toBe(17 * 12200);
    expect(r.byLine.map((g) => g.key)).toEqual(["Line 1", "Line 2"]);
    expect(r.byStyle.map((g) => g.key)).toEqual(["SYN-VEST-A", "SYN-VEST-B", "SYN-VEST-TT"]);
    expect(r.byBracket.map((g) => [g.key, g.orders])).toEqual([["0-99", 2], ["100-249", 2], ["250-499", 2], ["500-999", 1], ["1000-2499", 3], ["2500+", 2]]);
    for (const gs of [r.byStyle, r.byLine, r.byBracket]) {
      expect(gs.reduce((a, g) => a + g.labourVarianceCents, 0)).toBe(r.total.labourVarianceCents);
      expect(gs.reduce((a, g) => a + g.usageVarianceCents, 0)).toBe(r.total.usageVarianceCents);
      expect(gs.reduce((a, g) => a + g.priceVarianceCents, 0)).toBe(r.total.priceVarianceCents);
    }
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });
  it("short runs recover less labour than long runs (the planted pattern), using weighted recovery", async () => {
    const r = runProductionVariance(await dataset(), {});
    const short = r.byBracket.find((g) => g.key === "0-99")!;
    const long = r.byBracket.find((g) => g.key === "2500+")!;
    expect(short.labourRecoveryPct!).toBeLessThan(long.labourRecoveryPct!);
    expect(short.labourRecoveryPct!).toBeCloseTo((short.plannedMinutes / short.actualMinutes) * 100, 4);
    expect(r.total.labourRecoveryPct!).toBeCloseTo((r.total.plannedMinutes / r.total.actualMinutes) * 100, 4);
  });
  it("labour variance = (actual - planned minutes) x R1.50 on the synthetic routing", async () => {
    const r = runProductionVariance(await dataset(), {});
    expect(r.orders.every((o) => o.costPerMinute === 1.5)).toBe(true);
    const o = r.orders[0];
    expect(Z(o.labourVarianceCents!)).toBeCloseTo((o.actualMinutes - o.plannedMinutes) * 1.5, 2);
  });
  it("the synthetic workbook has standard and actual prices, so every variance is available", async () => {
    const r = runProductionVariance(await dataset(), {});
    expect(r.total.complete).toBe(true);
    expect(r.total.usageIncluded).toBe(12);
  });
});
