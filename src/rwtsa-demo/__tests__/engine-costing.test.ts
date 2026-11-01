import { describe, expect, it } from "vitest";
import { fromCents } from "@/rwtsa-demo/engine/money";
import { detectPercentScale, runCosting, type CostingResult, type SizeCosting } from "@/rwtsa-demo/engine/bom-costing";
import { mfgDataset, type BomSpec, type ItemSpec, type OpSpec } from "./mfg-fixture";

const Z = fromCents;
// Hand-checked style: materials R66 fabric + R6 short zip + R3 thread + R4 print + R2.50 packaging;
// labour Cut 3.5, Sew 11, Trim 2.5 SMV at R1.50/min, efficiency 0.85, overhead 0.10.
const BOM: BomSpec[] = [
  { code: "FABRIC", name: "Reflective fabric", type: "Material", qty: 1.2, cost: 55 },
  { code: "ZIP-S", name: "Zip (short)", type: "Trim", qty: 1, cost: 6 },
  { code: "ZIP-L", name: "Zip (long)", type: "Trim", qty: 1, cost: 8.5, sizeFrom: "3XL" },
  { code: "THREAD", name: "Thread", type: "Thread", qty: 1, cost: 3 },
  { code: "PRINT", name: "Print", type: "Print", qty: 1, cost: 4 },
  { code: "PACK", name: "Packaging", type: "Packaging", qty: 1, cost: 2.5 },
];
const OPS: OpSpec[] = [{ op: "Cut", smv: 3.5 }, { op: "Sew", smv: 11 }, { op: "Trim and pack", smv: 2.5 }];
const SIZES: ItemSpec[] = ["S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"].map((size, i) => ({ size, std: 100 + i * 2 }));
const run = (o: { items?: ItemSpec[]; bom?: BomSpec[]; ops?: OpSpec[] } = {}, cfg: Parameters<typeof runCosting>[1] = { percentScale: "fraction" }): CostingResult =>
  runCosting(mfgDataset({ items: o.items ?? SIZES, bom: o.bom ?? BOM, ops: o.ops ?? OPS }), cfg);
const sz = (r: CostingResult, size: string, style = "ST"): SizeCosting => r.styles.find((s) => s.styleCode === style)!.sizes.find((x) => x.size === size)!;

describe("cost components for a size without substitution (M)", () => {
  const m = sz(run(), "M");
  it("fabric and materials = quantity x unit cost", () => expect(Z(m.groups.fabricMaterialsCents!)).toBe(66));
  it("trims and thread", () => expect(Z(m.groups.trimsThreadCents!)).toBe(9));
  it("printing and packaging", () => expect(Z(m.groups.printPackagingCents!)).toBe(6.5));
  it("labour = SMV x cost per minute, split into cut / make / trim", () => {
    expect(Z(m.cmt.cutCents!)).toBe(5.25);
    expect(Z(m.cmt.makeCents!)).toBe(16.5);
    expect(Z(m.cmt.trimCents!)).toBe(3.75);
    expect(Z(m.labourBaseCents!)).toBe(25.5);
  });
  it("efficiency allowance = labour / efficiency - labour (0.85 -> R4.50)", () => expect(Z(m.efficiencyAllowanceCents!)).toBe(4.5));
  it("overhead = overhead % of the efficiency-adjusted labour (R3.00)", () => expect(Z(m.overheadCents!)).toBe(3));
  it("total = materials + trims + print/pack + labour + allowance + overhead = R114.50", () => {
    expect(Z(m.totalCents!)).toBe(114.5);
    expect(m.status).toBe("complete");
  });
  it("selling price = cost x 1.6 = R183.20, and the markup is configurable", () => {
    expect(Z(m.sellingCents!)).toBe(183.2);
    expect(Z(sz(run({}, { percentScale: "fraction", markup: 2 }), "M").sellingCents!)).toBe(229);
    expect(() => run({}, { percentScale: "fraction", markup: 0.5 })).toThrow(/markup/i);
  });
  it("the components of the total add up to the total, to the cent", () => {
    const sum = m.lines.reduce((a, l) => a + l.cents, 0);
    expect(sum).toBe(m.totalCents);
  });
});

describe("size-dependent components (longer zip from 3XL)", () => {
  it("the long zip replaces the short zip from 3XL up, and only from 3XL", () => {
    const r = run();
    for (const s of ["S", "M", "L", "XL", "2XL"]) expect(Z(sz(r, s).groups.trimsThreadCents!), s).toBe(9);
    for (const s of ["3XL", "4XL", "5XL"]) expect(Z(sz(r, s).groups.trimsThreadCents!), s).toBe(11.5);
    expect(Z(sz(r, "3XL").totalCents!)).toBe(117);
  });
  it("lists the substitution so it is visible", () => {
    const x = sz(run(), "3XL");
    expect(x.substitutions).toEqual([{ replaced: "ZIP-S", by: "ZIP-L", group: "zip" }]);
    expect(sz(run(), "M").substitutions).toEqual([]);
    expect(run().assumptions.map((a) => a.id)).toContain("size-substitution");
  });
  it("shows the per-size cost difference against the smallest size", () => {
    const r = run();
    expect(Z(sz(r, "M").deltaVsBaseCents!)).toBe(0);
    expect(Z(sz(r, "3XL").deltaVsBaseCents!)).toBe(2.5);
  });
  it("an exact-size row applies to that size only", () => {
    const r = run({ bom: [...BOM, { code: "EXTRA", name: "Label", type: "Trim", qty: 1, cost: 1, size: "L" }] });
    expect(Z(sz(r, "L").groups.trimsThreadCents!)).toBe(10);
    for (const other of ["S", "M", "XL", "2XL"]) expect(Z(sz(r, other).groups.trimsThreadCents!), other).toBe(9);
    for (const other of ["3XL", "4XL", "5XL"]) expect(Z(sz(r, other).groups.trimsThreadCents!), other).toBe(11.5);
  });
  it("the 'add' rule keeps both zips instead of substituting", () => {
    const r = run({}, { percentScale: "fraction", sizeRule: "add" });
    expect(Z(sz(r, "3XL").groups.trimsThreadCents!)).toBe(17.5);
    expect(sz(r, "3XL").substitutions).toEqual([]);
  });
  it("a size-specific row with nothing to replace is added, and said so", () => {
    const r = run({ bom: [...BOM, { code: "BADGE", name: "Badge", type: "Trim", qty: 1, cost: 1, sizeFrom: "XL" }] });
    expect(Z(sz(r, "XL").groups.trimsThreadCents!)).toBe(10);
    expect(r.warnings.join(" ")).toMatch(/added/i);
  });
  it("an unknown size label cannot resolve a sizeFrom row: reported, not guessed", () => {
    const r = run({ items: [{ size: "XXXL", std: 1 }] });
    expect(sz(r, "XXXL").status).toBe("incomplete");
    expect(sz(r, "XXXL").missing.join(" ")).toMatch(/size/i);
  });
});

describe("percentage scale is never assumed", () => {
  const PCT_OPS: OpSpec[] = OPS.map((o) => ({ ...o, overhead: 10, efficiency: 85, margin: 20 }));
  it("with no scale chosen, the efficiency and overhead lines are unresolved and the cost is incomplete", () => {
    const m = sz(run({}, { percentScale: null }), "M");
    expect(m.status).toBe("incomplete");
    expect(m.totalCents).toBeNull();
    expect(m.missing.join(" ")).toMatch(/percentage scale/i);
    expect(Z(m.groups.fabricMaterialsCents!)).toBe(66); // components that need no percentage are still shown
    expect(Z(m.labourBaseCents!)).toBe(25.5);
  });
  it("10 / 85 as percent and 0.10 / 0.85 as fractions give the same cost", () => {
    const pct = sz(run({ ops: PCT_OPS }, { percentScale: "percent" }), "M");
    expect(Z(pct.totalCents!)).toBe(114.5);
  });
  it("85 read as a fraction is rejected, not silently used", () => {
    const m = sz(run({ ops: PCT_OPS }, { percentScale: "fraction" }), "M");
    expect(m.status).toBe("incomplete");
    expect(m.missing.join(" ")).toMatch(/efficiency/i);
  });
  it("0.85 read as a percent (0.85% efficiency) is implausible, so it is rejected rather than used", () => {
    const m = sz(run({}, { percentScale: "percent" }), "M");
    expect(m.status).toBe("incomplete");
    expect(m.totalCents).toBeNull();
    expect(m.missing.join(" ")).toMatch(/efficiency value out of range/i);
  });
  it("a chosen scale that contradicts what the values look like is warned about", () => {
    expect(run({}, { percentScale: "percent" }).warnings.join(" ")).toMatch(/all at or below 1/i);
    expect(run({}, { percentScale: "fraction" }).warnings.join(" ")).not.toMatch(/all at or below 1/i);
  });
  it("detects what the data looks like but never applies it", () => {
    expect(detectPercentScale([0.1, 0.15, 0.85]).hint).toBe("fraction-or-small-percent");
    expect(detectPercentScale([10, 15, 85]).hint).toBe("percent");
    expect(detectPercentScale([0.1, 15]).hint).toBe("mixed");
    expect(detectPercentScale([]).hint).toBe("none");
    expect(detectPercentScale([10, null, 85])).toMatchObject({ count: 2, min: 10, max: 85 });
    const r = run({}, { percentScale: null });
    expect(r.scaleObservation.hint).toBe("fraction-or-small-percent");
    expect(r.scale).toBeNull();
  });
  it("a missing efficiency or overhead value is reported, never treated as zero", () => {
    const m = sz(run({ ops: [{ op: "Cut", smv: 3.5, efficiency: null }, OPS[1]] }), "M");
    expect(m.status).toBe("incomplete");
    expect(m.missing.join(" ")).toMatch(/efficiency/i);
    const o = sz(run({ ops: [{ op: "Cut", smv: 3.5, overhead: null }, OPS[1]] }), "M");
    expect(o.missing.join(" ")).toMatch(/overhead/i);
  });
  it("the routing margin column is not used for the selling price (the 1.6 multiplier is)", () => {
    const a = sz(run({ ops: OPS.map((o) => ({ ...o, margin: 0.5 })) }), "M");
    expect(Z(a.sellingCents!)).toBe(183.2);
    expect(run().assumptions.map((x) => x.id)).toContain("selling-price");
  });
});

describe("missing data is exposed, never invented", () => {
  it("a missing component price names the component and withholds the total", () => {
    const r = run({ bom: BOM.map((b) => (b.code === "THREAD" ? { ...b, cost: null } : b)) });
    const m = sz(r, "M");
    expect(m.status).toBe("incomplete");
    expect(m.totalCents).toBeNull();
    expect(m.sellingCents).toBeNull();
    expect(m.missing).toContain("unit cost of THREAD");
    expect(m.groups.trimsThreadCents).toBeNull();
    expect(Z(m.groups.fabricMaterialsCents!)).toBe(66);
  });
  it("a style with no routing has no labour and an incomplete cost", () => {
    const m = sz(run({ ops: [] }), "M");
    expect(m.status).toBe("incomplete");
    expect(m.missing.join(" ")).toMatch(/routing/i);
    expect(m.labourBaseCents).toBeNull();
  });
  it("a style with no BOM is incomplete", () => {
    const m = sz(run({ bom: [] }), "M");
    expect(m.status).toBe("incomplete");
    expect(m.missing.join(" ")).toMatch(/bill of material/i);
  });
  it("an unclassified component type is included but flagged", () => {
    const r = run({ bom: [...BOM, { code: "MYSTERY", name: "Gizmo", type: "Widget", qty: 2, cost: 1.5 }] });
    expect(Z(sz(r, "M").groups.otherCents!)).toBe(3);
    expect(Z(sz(r, "M").totalCents!)).toBe(117.5);
    expect(r.warnings.join(" ")).toMatch(/unclassified/i);
  });
  it("a zero quantity or zero price component is valid, not missing", () => {
    const r = run({ bom: BOM.map((b) => (b.code === "PACK" ? { ...b, cost: 0 } : b)) });
    expect(sz(r, "M").status).toBe("complete");
    expect(Z(sz(r, "M").groups.printPackagingCents!)).toBe(4);
  });
  it("an empty Items tab gives an empty, honest result", () => {
    const r = run({ items: [] });
    expect(r.styles).toEqual([]);
  });
});

describe("reconciliation with the workbook's reference cost", () => {
  it("compares calculated cost with Items.standardCost, per style and size", () => {
    const r = run({ items: [{ size: "M", std: 100 }] });
    const m = sz(r, "M");
    expect(Z(m.referenceCents!)).toBe(100);
    expect(Z(m.diffCents!)).toBe(14.5);
    expect(m.diffPct).toBeCloseTo(14.5, 10);
  });
  it("matches exactly when the reference equals the calculation", () => {
    const m = sz(run({ items: [{ size: "M", std: 114.5 }] }), "M");
    expect(m.diffCents).toBe(0);
    expect(run({ items: [{ size: "M", std: 114.5 }] }).checks.find((c) => c.id === "reference")!.ok).toBe(true);
  });
  it("flags differences and withholds the comparison when the cost is incomplete", () => {
    expect(run({ items: [{ size: "M", std: 100 }] }).checks.find((c) => c.id === "reference")!.ok).toBe(false);
    const inc = sz(run({ items: [{ size: "M", std: 100 }] }, { percentScale: null }), "M");
    expect(inc.diffCents).toBeNull();
  });
  it("a zero reference cost gives no percentage difference", () => {
    expect(sz(run({ items: [{ size: "M", std: 0 }] }), "M").diffPct).toBeNull();
  });
  it("style and size totals reconcile: each size's lines sum to its total, and every size is accounted for", () => {
    const r = run();
    const st = r.styles[0];
    expect(st.sizes.map((s) => s.size)).toEqual(["S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"]);
    for (const s of st.sizes) expect(s.lines.reduce((a, l) => a + l.cents, 0)).toBe(s.totalCents);
    expect(r.checks.find((c) => c.id === "lines")!.ok).toBe(true);
    expect(r.checks.find((c) => c.id === "groups")!.ok).toBe(true);
  });
  it("two styles are costed independently", () => {
    const r = runCosting(
      mfgDataset({
        items: [{ style: "A", size: "M", std: 1 }, { style: "B", size: "M", std: 1 }],
        bom: [{ style: "A", code: "F", type: "Material", qty: 1, cost: 10 }, { style: "B", code: "F", type: "Material", qty: 1, cost: 20 }],
        ops: [{ style: "A", op: "Cut", smv: 1 }, { style: "B", op: "Cut", smv: 2 }],
      }),
      { percentScale: "fraction" }
    );
    expect(Z(sz(r, "M", "A").groups.fabricMaterialsCents!)).toBe(10);
    expect(Z(sz(r, "M", "B").groups.fabricMaterialsCents!)).toBe(20);
    expect(sz(r, "M", "B").labourBaseCents).toBe(300);
  });
  it("is deterministic and does not mutate its input", () => {
    const ds = mfgDataset({ items: SIZES, bom: BOM, ops: OPS });
    const before = JSON.stringify(ds);
    expect(JSON.stringify(runCosting(ds, { percentScale: "fraction" }))).toBe(JSON.stringify(runCosting(ds, { percentScale: "fraction" })));
    expect(JSON.stringify(ds)).toBe(before);
  });
});

describe("rounding is in whole cents and totals are exact", () => {
  it("efficiency and overhead are applied per operation in cents; the parts sum to the labour total exactly", () => {
    const m = sz(run(), "M");
    // adjusted per operation: 6.18 + 19.41 + 4.41 = 30.00; allowance 4.50; overhead 0.62 + 1.94 + 0.44 = 3.00
    expect(m.labourBaseCents! + m.efficiencyAllowanceCents!).toBe(3000);
    expect(m.overheadCents).toBe(300);
  });
  it("a fractional-cent component rounds half up per line", () => {
    const m = sz(run({ bom: [{ code: "F", type: "Material", qty: 1.2345, cost: 3.33 }], ops: [] }, { percentScale: "fraction" }), "M");
    expect(m.lines.find((l) => l.code === "F")!.cents).toBe(Math.round(1.2345 * 3.33 * 100)); // 411.0 cents
  });
});

describe("review hardening: substitutions and coverage", () => {
  const trimBom = (extra: BomSpec[]) => [{ code: "F", name: "Fabric", type: "Material", qty: 1, cost: 10 }, ...extra];
  it("two restricted rows of one group that both apply: the most specific wins, the other is flagged, nothing is double counted", () => {
    const r = run({
      items: [{ size: "5XL" }, { size: "3XL" }],
      bom: trimBom([
        { code: "Z-S", name: "Zip (short)", type: "Trim", qty: 1, cost: 6 },
        { code: "Z-L", name: "Zip (long)", type: "Trim", qty: 1, cost: 8, sizeFrom: "3XL" },
        { code: "Z-XL", name: "Zip (extra long)", type: "Trim", qty: 1, cost: 9, size: "5XL" },
      ]),
      ops: [],
    });
    expect(Z(sz(r, "5XL").groups.trimsThreadCents!)).toBe(9); // exact size beats size-from
    expect(Z(sz(r, "3XL").groups.trimsThreadCents!)).toBe(8);
    expect(r.warnings.join(" ")).toMatch(/superseded/i);
  });
  it("several base components sharing one name stem are not all dropped by one size-specific row: ambiguous, so added and flagged", () => {
    const r = run({
      items: [{ size: "3XL" }],
      bom: trimBom([
        { code: "T-B", name: "Thread (body)", type: "Thread", qty: 1, cost: 2 },
        { code: "T-O", name: "Thread (overlock)", type: "Thread", qty: 1, cost: 3 },
        { code: "T-X", name: "Thread (3XL)", type: "Thread", qty: 1, cost: 4, sizeFrom: "3XL" },
      ]),
      ops: [],
    });
    expect(Z(sz(r, "3XL").groups.trimsThreadCents!)).toBe(9); // all three kept
    expect(sz(r, "3XL").substitutions).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/ambiguous/i);
  });
  it("size labels match without regard to case or surrounding spaces", () => {
    const r = run({ items: [{ size: "3XL" }], bom: trimBom([{ code: "Z-L", name: "Zip", type: "Trim", qty: 1, cost: 8, size: " 3xl " }]), ops: [] });
    expect(Z(sz(r, "3XL").groups.trimsThreadCents!)).toBe(8);
  });
  it("a style present in the BOM, routing or production orders but not in Items is reported, not silently dropped", () => {
    const r = runCosting(
      mfgDataset({
        items: [{ style: "A", size: "M" }],
        bom: [{ style: "A", code: "F", type: "Material", qty: 1, cost: 1 }, { style: "GHOST", code: "F", type: "Material", qty: 1, cost: 1 }],
        ops: [{ style: "A", op: "Cut", smv: 1 }, { style: "PHANTOM", op: "Cut", smv: 1 }],
        orders: [{ no: "O", style: "SPECTRE" }],
      }),
      { percentScale: "fraction" }
    );
    expect(r.styles.map((x) => x.styleCode)).toEqual(["A"]);
    expect(r.warnings.join(" ")).toMatch(/3 style\(s\).*no Items rows/i);
    expect(r.checks.find((c) => c.id === "styles")!.ok).toBe(false);
    expect(run().checks.find((c) => c.id === "styles")!.ok).toBe(true);
  });
});
