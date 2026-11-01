import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyExclusionForm } from "@/rwtsa-demo/state/exclusion-form";
import { ExclusionStoreError, loadExclusions, removeExclusions, saveExclusions } from "@/rwtsa-demo/state/exclusions-store";
import { parseSettings, settingsQuery } from "@/rwtsa-demo/state/red-flag-settings";
import { redFlagModel, suppliedCurveFor } from "@/rwtsa-demo/state/red-flag-model";
import { loadDemoState, type DemoState } from "@/rwtsa-demo/state/demo-state";
import { buildSyntheticWorkbook } from "@/rwtsa-demo/fixtures/synthetic";
import { makeDataset } from "./engine-fixture";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "rwtsa-excl-"));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("exclusion store (local state outside the repository)", () => {
  it("round-trips, keeps the reason, and is owner-only", () => {
    const d = tmp();
    saveExclusions(d, "synthetic:seed=1", [{ sku: "S1", month: "2026-08", reason: "  One-off tender " }], new Date("2026-11-01T00:00:00Z"));
    const got = loadExclusions(d, "synthetic:seed=1");
    expect(got).toEqual([{ sku: "S1", month: "2026-08", reason: "One-off tender", at: "2026-11-01T00:00:00.000Z" }]);
    const files = readdirSync(d);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^exclusions-[0-9a-f]{16}\.json$/); // the source label is hashed, never used as a file name
    expect(statSync(join(d, files[0])).mode & 0o777).toBe(0o600);
    expect(readdirSync(d).some((f) => f.endsWith(".tmp"))).toBe(false);
  });
  it("replaces the same SKU/month, reverses, and tolerates reversing what is not there", () => {
    const d = tmp();
    saveExclusions(d, "a", [{ sku: "S1", month: "2026-08", reason: "first" }]);
    saveExclusions(d, "a", [{ sku: "S1", month: "2026-08", reason: "second" }, { sku: "S2", month: "2026-08", reason: "x" }]);
    expect(loadExclusions(d, "a").map((e) => e.reason).sort()).toEqual(["second", "x"]);
    removeExclusions(d, "a", [{ sku: "S1", month: "2026-08" }, { sku: "NOPE", month: "2026-01" }]);
    expect(loadExclusions(d, "a").map((e) => e.sku)).toEqual(["S2"]);
  });
  it("keeps data sources apart", () => {
    const d = tmp();
    saveExclusions(d, "synthetic:seed=1", [{ sku: "S1", month: "2026-08", reason: "r" }]);
    expect(loadExclusions(d, "local-workbook:abc")).toEqual([]);
  });
  it("refuses an empty reason and a corrupt or foreign file, and never applies them silently", () => {
    const d = tmp();
    expect(() => saveExclusions(d, "a", [{ sku: "S1", month: "2026-08", reason: "  " }])).toThrow(ExclusionStoreError);
    expect(loadExclusions(d, "a")).toEqual([]);
    saveExclusions(d, "a", [{ sku: "S1", month: "2026-08", reason: "r" }]);
    const f = join(d, readdirSync(d)[0]);
    writeFileSync(f, "{not json");
    expect(() => loadExclusions(d, "a")).toThrow(/corrupt/);
    writeFileSync(f, JSON.stringify({ schemaVersion: 1, source: "other", exclusions: [] }));
    expect(() => loadExclusions(d, "a")).toThrow(/different data source/);
  });
  it("refuses a state directory inside a git working tree and creates nothing there", () => {
    const inside = join(process.cwd(), "rwtsa-state-must-not-exist");
    expect(() => saveExclusions(inside, "a", [{ sku: "S1", month: "2026-08", reason: "r" }])).toThrow(ExclusionStoreError);
    expect(existsSync(inside)).toBe(false);
  });
});

describe("exclusion form", () => {
  const ds = makeDataset({ skus: [{ sku: "S1", sales: [1, 1, 1, 1, 1, 1] }] });
  it("excludes with a reason, then reverses", () => {
    const d = tmp();
    expect(applyExclusionForm(d, "a", ds, { action: "exclude", skus: ["S1"], month: "2026-08", reason: "Tender" })).toBe("excluded");
    expect(loadExclusions(d, "a")).toHaveLength(1);
    expect(applyExclusionForm(d, "a", ds, { action: "reverse", skus: ["S1"], month: "2026-08", reason: null })).toBe("reversed");
    expect(loadExclusions(d, "a")).toHaveLength(0);
  });
  it("rejects a missing or blank reason and saves nothing", () => {
    const d = tmp();
    for (const reason of [null, "", "   "]) expect(applyExclusionForm(d, "a", ds, { action: "exclude", skus: ["S1"], month: "2026-08", reason })).toBe("reason");
    expect(loadExclusions(d, "a")).toHaveLength(0);
  });
  it("rejects unknown SKUs/months and malformed requests", () => {
    const d = tmp();
    expect(applyExclusionForm(d, "a", ds, { action: "exclude", skus: ["NOPE"], month: "2026-08", reason: "r" })).toBe("unknown");
    expect(applyExclusionForm(d, "a", ds, { action: "exclude", skus: ["S1"], month: "1999-01", reason: "r" })).toBe("unknown");
    expect(applyExclusionForm(d, "a", ds, { action: "drop-table", skus: ["S1"], month: "2026-08", reason: "r" })).toBe("invalid");
    expect(applyExclusionForm(d, "a", ds, { action: "exclude", skus: [], month: "2026-08", reason: "r" })).toBe("invalid");
    expect(applyExclusionForm(d, "a", ds, { action: "exclude", skus: ["S1"], month: "2026-08", reason: "x".repeat(501) })).toBe("invalid");
  });
  it("reports a store problem without throwing", () => {
    expect(applyExclusionForm(join(process.cwd(), "rwtsa-state-must-not-exist"), "a", ds, { action: "exclude", skus: ["S1"], month: "2026-08", reason: "r" })).toBe("store");
  });
});

describe("settings (URL controls)", () => {
  const none = { suppliedCurve: null };
  it("defaults to the brief's values", () => {
    const s = parseSettings({}, none);
    expect(s.config).toMatchObject({ forecastWindowMonths: 6, horizonWeeks: 13, historyAnchor: "last-available", overdueOnWater: "week-1", anomaly: { multiple: 5, floor: 40 }, sizeCurve: { kind: "none" } });
    expect(s.errors).toEqual([]);
    expect(s.view).toBe("sku");
  });
  it("accepts valid controls", () => {
    const s = parseSettings({ view: "style", window: "3", horizon: "26", anchor: "strict", overdue: "exclude", curve: "demand", mult: "6", floor: "50", style: "ST", only: "shortage", sel: "S1" }, none);
    expect(s).toMatchObject({ view: "style", style: "ST", shortageOnly: true, sel: "S1", curve: "demand" });
    expect(s.config).toMatchObject({ forecastWindowMonths: 3, horizonWeeks: 26, historyAnchor: "strict", overdueOnWater: "exclude", anomaly: { multiple: 6, floor: 50 }, sizeCurve: { kind: "demand-proportional" } });
  });
  it("replaces invalid values with defaults, reports them, and does not echo the raw value", () => {
    const s = parseSettings({ window: "0", horizon: "14", anchor: "<script>", mult: "-1", view: "x", curve: "supplied" }, none);
    expect(s.config).toMatchObject({ forecastWindowMonths: 6, horizonWeeks: 13, historyAnchor: "last-available" });
    expect(s.errors.length).toBeGreaterThanOrEqual(5);
    expect(s.errors.join(" ")).not.toContain("<script>");
    expect(parseSettings({ window: "37" }, none).errors).toHaveLength(1);
    expect(parseSettings({ window: "36" }, none).errors).toHaveLength(0);
    expect(parseSettings({ window: "6.5" }, none).errors).toHaveLength(1);
  });
  it("the supplied size curve is offered only when the source supplies one", () => {
    expect(parseSettings({}, { suppliedCurve: { M: 1 } }).config.sizeCurve).toEqual({ kind: "explicit", weights: { M: 1 } });
    expect(parseSettings({ curve: "supplied" }, none).config.sizeCurve).toEqual({ kind: "none" });
  });
  it("a query round-trip reproduces the settings", () => {
    const s = parseSettings({ view: "style", window: "4", horizon: "26", only: "shortage", style: "ST" }, none);
    const again = parseSettings(Object.fromEntries(new URLSearchParams(settingsQuery(s))), none);
    expect(again.config).toEqual(s.config);
    expect(again).toMatchObject({ view: "style", style: "ST", shortageOnly: true });
  });
});

describe("page model", () => {
  async function synth(): Promise<DemoState> {
    return loadDemoState({ source: "synthetic" });
  }
  const settings = (q: Record<string, string> = {}, state?: DemoState) => parseSettings(q, { suppliedCurve: state ? suppliedCurveFor(state) : null });

  it("synthetic: engine available, results present, provenance and readiness carried through", async () => {
    const st = await synth();
    const m = redFlagModel(st, settings({}, st), []);
    expect(m).toMatchObject({ provenance: "SYNTHETIC", engine: "AVAILABLE", structure: "PASS", basis: "ASSUMED" });
    expect(m.result).not.toBeNull();
    expect(m.rows.length).toBe(24);
    expect(m.chart?.balances).toHaveLength(13);
    expect(m.result?.summary.shortageSkus).toBeGreaterThan(0);
  });
  it("engine AVAILABLE is separate from READY: the readiness label comes only from the validator", async () => {
    const st = await synth();
    if (st.kind !== "validated") throw new Error("x");
    const forcedNotReady: DemoState = { ...st, summary: { ...st.summary, readiness: st.summary.readiness.map((r) => (r.scenario === "A" ? { ...r, ready: false, missingFields: ["Items.minLevel"] } : r)) } };
    const m = redFlagModel(forcedNotReady, settings({}, st), []);
    expect(m.engine).toBe("AVAILABLE");
    expect(m.readiness).toBe("NOT READY");
    expect(m.readinessReasons.join(" ")).toContain("Items.minLevel");
  });
  it("no data / config error / failed workbook: engine UNAVAILABLE, no rows, nothing substituted", async () => {
    const states: DemoState[] = [
      { kind: "not-loaded" },
      { kind: "config-error", message: "x" },
      { kind: "error", provenance: "LOCAL WORKBOOK", message: "x" },
    ];
    for (const st of states) {
      const m = redFlagModel(st, settings(), []);
      expect(m.engine).toBe("UNAVAILABLE");
      expect(m.rows).toEqual([]);
      expect(m.result).toBeNull();
      expect(m.readiness).toBe("NOT READY");
      expect(m.provenance).not.toBe("SYNTHETIC");
    }
    const failed = await loadDemoState({ workbookPath: join(tmpdir(), "rwtsa-missing-xyz.xlsx") });
    const m = redFlagModel(failed, settings(), []);
    expect(m.engine).toBe("UNAVAILABLE");
    expect(m.provenance).toBe("LOCAL WORKBOOK");
  });
  it("style view reconciles to the SKU view and the filters work", async () => {
    const st = await synth();
    const sku = redFlagModel(st, settings({ view: "sku" }, st), []);
    const style = redFlagModel(st, settings({ view: "style" }, st), []);
    expect(style.rows.length).toBe(3);
    const sum = (rows: readonly { proposedOrder: number }[]) => rows.reduce((a, r) => a + r.proposedOrder, 0);
    expect(sum(style.rows)).toBe(sum(sku.rows));
    const only = redFlagModel(st, settings({ only: "shortage" }, st), []);
    expect(only.rows.every((r) => r.shortfall > 0 && !r.tenderExempt)).toBe(true);
    const one = redFlagModel(st, settings({ style: "SYN-VEST-A" }, st), []);
    expect(one.rows.every((r) => r.style === "SYN-VEST-A")).toBe(true);
    expect(one.rows).toHaveLength(8);
  });
  it("exclusions flow through: shortages fall, the anomaly column changes, the chart follows the selection", async () => {
    const st = await synth();
    const before = redFlagModel(st, settings({}, st), []);
    const planted = buildSyntheticWorkbook().planted;
    const ex = before.result!.anomalies.map((a) => ({ sku: a.sku, month: a.month, reason: "Tender" }));
    const after = redFlagModel(st, settings({}, st), ex);
    expect(after.result!.summary.shortageSkus).toBeLessThan(before.result!.summary.shortageSkus);
    expect(before.rows.filter((r) => r.anomalyKind === "review").map((r) => r.style)).toEqual(Array(8).fill(planted.tenderSpike.styleCode));
    expect(after.rows.filter((r) => r.anomalyKind === "excluded")).toHaveLength(8);
    expect(redFlagModel(st, settings({ sel: "SYN-VEST-A-M" }, st), []).chart?.key).toBe("SYN-VEST-A-M");
  });
  it("an invalid exclusion in the store becomes an UNAVAILABLE engine with a fixed message, not an exception", async () => {
    const st = await synth();
    const m = redFlagModel(st, settings({}, st), [{ sku: "S1", month: "2026-08", reason: "" }]);
    expect(m.engine).toBe("UNAVAILABLE");
    expect(m.engineNote).toMatch(/reason/);
  });
});
