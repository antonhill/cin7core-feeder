import { describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { applyResolution, buildMappedLines, effectiveScope, type ScopeItem } from "../product-scope";
import { resolveScopeItem } from "../scope-store";

const item = (over: Partial<ScopeItem> = {}): ScopeItem => ({
  id: "pen", sku: null, description: "PP penning", quantity: 120, unit: "m", productType: "FINISHED_GOOD",
  origin: { lineRef: "pen", label: "PP penning", packageKey: "pp", section: "Penning", source: "QUOTE" }, scope: "BASE", sellingUnitCents: 130_000, mapping: { status: "UNMAPPED", reason: "Package has no authoritative SKU list" }, ...over,
});
const at = "2026-10-28T10:00:00Z";

describe("multi-SKU package mapping", () => {
  it("resolves one quoted package into several real SKUs with quantity conversion (120 m -> 6 rolls + 40 posts)", () => {
    const r = applyResolution([item()], { itemId: "pen", kind: "MAP_LINES", lines: [{ sku: "FENCE-ROLL-20M", factor: 0.05, unit: "roll" }, { sku: "POST-2M", factor: 1 / 3, unit: "each" }], reason: "per BOM sheet", by: "m@x", at });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const eff = effectiveScope(r.items);
    expect(eff.blockers).toEqual([]);
    expect(eff.lines.map((l) => [l.sku, l.quantity])).toEqual([["FENCE-ROLL-20M", 6], ["POST-2M", 40]]);
    expect(eff.lines[0].sources).toEqual(["pen"]); // traceable to the quoted package
    expect(r.items[0].origin).toMatchObject({ packageKey: "pp", section: "Penning" }); // origin preserved
  });
  it("keeps BOM components as reference only: never a Sale line, never double counted", () => {
    const r = applyResolution([item()], { itemId: "pen", kind: "MAP_LINES", lines: [{ sku: "PEN-KIT", factor: 1 }, { sku: "BOLT", factor: 8, role: "BOM_COMPONENT" }], reason: "kit", by: "m@x", at });
    if (!r.ok) throw new Error(r.error);
    const eff = effectiveScope(r.items);
    expect(eff.lines.map((l) => l.sku)).toEqual(["PEN-KIT"]);
    expect(eff.referenceOnly).toEqual([{ id: "pen", sku: "BOLT", quantity: 960, description: "PP penning" }]);
    // the same SKU sold elsewhere as a Sale line AND a component here would double count -> blocked
    const other = item({ id: "bolts", description: "Bolt pack", sku: "BOLT", quantity: 10, mapping: { status: "MAPPED" } });
    expect(effectiveScope([...r.items, other]).blockers.join()).toMatch(/double count/);
  });
  it("sums a SKU that also appears on another mapped item (one line per SKU)", () => {
    const r = applyResolution([item(), item({ id: "x", description: "Extra", sku: "PEN-KIT", quantity: 2, mapping: { status: "MAPPED" } })], { itemId: "pen", kind: "MAP_LINES", lines: [{ sku: "PEN-KIT", factor: 1 }], reason: "r", by: "m", at });
    if (!r.ok) throw new Error(r.error);
    expect(effectiveScope(r.items).lines).toEqual([{ sku: "PEN-KIT", quantity: 122, description: "PP penning", sources: ["pen", "x"] }]);
  });
  it("refuses empty, duplicate, non-positive, quantity-less and no-finished-good mappings, and needs a reason", () => {
    const bad = (lines: Array<{ sku: string; factor: number; role?: "BOM_COMPONENT" }>, q: number | null = 120) => buildMappedLines(q, lines);
    expect(bad([])).toMatchObject({ ok: false });
    expect(bad([{ sku: "A", factor: 1 }, { sku: "A", factor: 2 }])).toMatchObject({ ok: false, error: expect.stringMatching(/twice/) });
    expect(bad([{ sku: "A", factor: 0 }])).toMatchObject({ ok: false });
    expect(bad([{ sku: " ", factor: 1 }])).toMatchObject({ ok: false });
    expect(bad([{ sku: "A", factor: 1 }], null)).toMatchObject({ ok: false, error: expect.stringMatching(/no usable quantity/) });
    expect(bad([{ sku: "A", factor: 1, role: "BOM_COMPONENT" }])).toMatchObject({ ok: false, error: expect.stringMatching(/finished good/) });
    expect(applyResolution([item()], { itemId: "pen", kind: "MAP_LINES", lines: [{ sku: "A", factor: 1 }], reason: " ", by: "m", at })).toMatchObject({ ok: false });
  });
  it("only resolves an UNMAPPED, unresolved item", () => {
    expect(applyResolution([item({ mapping: { status: "MAPPED" }, sku: "A" })], { itemId: "pen", kind: "MAP_LINES", lines: [{ sku: "A", factor: 1 }], reason: "r", by: "m", at })).toMatchObject({ ok: false });
    const once = applyResolution([item()], { itemId: "pen", kind: "MAP_LINES", lines: [{ sku: "A", factor: 1 }], reason: "r", by: "m", at });
    if (!once.ok) throw new Error("x");
    expect(applyResolution(once.items, { itemId: "pen", kind: "EXCLUDE", reason: "r", by: "m", at })).toMatchObject({ ok: false });
  });
  it("an explicit, audited exclusion still works for an item that is not on the Sales Order", () => {
    const r = applyResolution([item()], { itemId: "pen", kind: "EXCLUDE", reason: "customer supplies penning", by: "m@x", at });
    if (!r.ok) throw new Error(r.error);
    expect(effectiveScope(r.items)).toMatchObject({ lines: [], blockers: [], excluded: [{ id: "pen", reason: "customer supplies penning" }] });
  });

  describe("store: verified in Cin7, only before a claim or Sale, only by a manager; baseline otherwise untouched", () => {
    const PID = "p1", ORG = "o1";
    const seed = (extra: Record<string, unknown> = {}) => {
      const db = new FakeDb();
      db.rows("projects").push({ id: PID, org_id: ORG, status: "ACTIVE", baseline_snapshot: { contractCents: 100, physicalScope: [item()], lines: [] }, ...extra });
      return db;
    };
    const port = (missing: string[] = []) => ({ resolveProducts: async () => ({ ids: new Map<string, string>(), missing }) });
    const input = { orgId: ORG, projectId: PID, itemId: "pen", kind: "MAP_LINES" as const, lines: [{ sku: "FENCE-ROLL-20M", factor: 0.05 }, { sku: "POST-2M", factor: 1 / 3 }], reason: "BOM sheet" };

    it("saves the resolution into the snapshot and leaves everything else in it alone", async () => {
      const db = seed();
      await resolveScopeItem(db as never, port(), { isManager: true }, "m@x", input);
      const snap = db.rows("projects")[0].baseline_snapshot as { contractCents: number; physicalScope: ScopeItem[] };
      expect(snap.contractCents).toBe(100);
      expect(snap.physicalScope[0].resolution).toMatchObject({ kind: "MAP_LINES", by: "m@x", reason: "BOM sheet" });
    });
    it("refuses a non-manager, a SKU missing in Cin7, a project with a claim, and a project with a Sale", async () => {
      const err = (db: FakeDb, gates = { isManager: true }, p = port()) => resolveScopeItem(db as never, p, gates, "m@x", input).then(() => "ok", (e: Error) => e.message);
      expect(await err(seed(), { isManager: false })).toMatch(/Only a manager/);
      expect(await err(seed(), { isManager: true }, port(["POST-2M"]))).toMatch(/POST-2M does not exist in Cin7/);
      const claimed = seed(); claimed.rows("project_claims").push({ id: "c", org_id: ORG, project_id: PID });
      expect(await err(claimed)).toMatch(/already has a claim/);
      const sold = seed(); sold.rows("project_cin7_sale_links").push({ id: "l", org_id: ORG, project_id: PID });
      expect(await err(sold)).toMatch(/Sale already exists/);
      const unchanged = seed(); await err(unchanged, { isManager: true }, port(["POST-2M"]));
      expect((unchanged.rows("projects")[0].baseline_snapshot as { physicalScope: ScopeItem[] }).physicalScope[0].resolution).toBeUndefined();
    });
  });
});
