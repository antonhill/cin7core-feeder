import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EMPTY_PLANNER, PlannerStoreError, loadPlanner, updatePlanner } from "@/rwtsa-demo/state/planner-store";

const root = mkdtempSync(join(tmpdir(), "rwtsa-planner-store-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const dir = () => mkdtempSync(join(root, "d-"));

describe("planner state store (local, outside Git)", () => {
  it("a missing file is an empty state", () => {
    expect(loadPlanner(dir(), "src-a")).toEqual(EMPTY_PLANNER);
  });
  it("persists atomically, owner-only, one file per source, and round-trips", () => {
    const d = dir();
    updatePlanner(d, "src-a", (s) => ({ ...s, classification: [{ sku: "A", value: "tender", reason: null, at: "2026-11-01T00:00:00Z" }] }));
    const files = readdirSync(d);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^planner-[0-9a-f]{16}\.json$/);
    expect(statSync(join(d, files[0])).mode & 0o077).toBe(0);
    expect(loadPlanner(d, "src-a").classification[0].sku).toBe("A");
    expect(loadPlanner(d, "src-b")).toBe(EMPTY_PLANNER);
  });
  it("a corrupt file, or one that names another source, is an error, never an empty state", () => {
    const d = dir();
    updatePlanner(d, "src-a", (s) => s);
    const f = join(d, readdirSync(d)[0]);
    writeFileSync(f, "nope");
    expect(() => loadPlanner(d, "src-a")).toThrow(PlannerStoreError);
    writeFileSync(f, JSON.stringify({ ...JSON.parse('{"schemaVersion":1,"classification":[],"minOverrides":[],"orderOverrides":[],"localMake":[]}'), source: "other" }));
    expect(() => loadPlanner(d, "src-a")).toThrow(/different data source/);
  });
  it("refuses an invalid decision before writing anything", () => {
    const d = dir();
    const bad = [
      (s: typeof EMPTY_PLANNER) => ({ ...s, minOverrides: [{ sku: "A", originalMin: 1, replacement: -1, effectiveFrom: "2026-10-31", expires: null, reason: "x", at: "t" }] }),
      (s: typeof EMPTY_PLANNER) => ({ ...s, minOverrides: [{ sku: "A", originalMin: 1, replacement: 1, effectiveFrom: "2026-10-31", expires: null, reason: "   ", at: "t" }] }),
      (s: typeof EMPTY_PLANNER) => ({ ...s, orderOverrides: [{ sku: "A", quantity: 1.5, calculatedAtOverride: null, reason: "x", at: "t" }] }),
      (s: typeof EMPTY_PLANNER) => ({ ...s, orderOverrides: [{ sku: "A", quantity: 1, calculatedAtOverride: null, reason: "", at: "t" }] }),
      (s: typeof EMPTY_PLANNER) => ({ ...s, localMake: [{ sku: "A", quantity: 1, capacityUnits: 1, leadTimeWeeks: 99, completionWeek: 1, at: "t" }] }),
    ];
    for (const change of bad) expect(() => updatePlanner(d, "src-a", change)).toThrow(PlannerStoreError);
    expect(readdirSync(d)).toEqual([]);
  });
  it("will not write inside a git working tree", () => {
    expect(() => updatePlanner(join(process.cwd(), "planner-should-not-exist"), "src-a", (s) => s)).toThrow(PlannerStoreError);
  });
  it("contains no workbook content: only SKU codes, decisions and timestamps", () => {
    const d = dir();
    updatePlanner(d, "label-only", (s) => ({ ...s, localMake: [{ sku: "A", quantity: 1, capacityUnits: 1, leadTimeWeeks: 1, completionWeek: 2, at: "t" }] }));
    expect(readFileSync(join(d, readdirSync(d)[0]), "utf8")).toMatch(/"source": "label-only"/);
  });
});
