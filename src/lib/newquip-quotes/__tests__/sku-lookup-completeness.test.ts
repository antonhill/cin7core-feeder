// LOOKUP COMPLETENESS GUARD (2026-11-26). The defect: a selectable option's product was never requested from Cin7 because the "needs" list was built from a different evaluation than the one that prices the line. This test makes that class
// of defect impossible to reintroduce silently, for EVERY option and not just the ones a fixture happens to contain:
//   (A) For a systematic matrix of configurations (all 128 optional-equipment subsets, both feeder variants, both door sizes and none, cooling 0.6/3/3.01/20/20.01/25/200 m, window and fan counts, plug counts), every SKU the Budget
//       evaluation LOOKS UP in its price source is in the needs list that automatic pricing sends to Cin7.
//   (B) Across the matrix, the union of needs covers EVERY SKU the commercial mappings reference, except a short, documented list of references that are by design never priced from Cin7.
import { describe, expect, it, vi } from "vitest";
import type { QuoteDraft } from "@/newquip/grower/draft";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";
import type { PriceSource } from "@/newquip/grower/pricing-source";
import { referencedSkus, EXCLUDED_SKUS } from "@/newquip/grower/commercial";
import { coolingBom } from "@/newquip/grower/cooling-bom";
import { OPTIONAL_ITEM_KEYS } from "@/newquip/grower/types";
import { nqQ0002 } from "@/newquip/grower/__tests__/nq-q-0002-fixture";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/projects/latest-cost-adapter", () => ({ listCin7Suppliers: vi.fn(), readRawProductsForSurvey: vi.fn() }));
const { evaluationContext } = await import("../context");

const BASE = createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT);
const spy = (seen: Set<string>): PriceSource => ({ ...BASE, descriptor: BASE.descriptor, priceFor: (sku, qt) => { seen.add(sku); return BASE.priceFor(sku, qt); }, has: BASE.has });

interface Cfg { opts: string[]; feeder: "STANDARD" | "WINDOW"; door: "2.1x1.2" | "2.1x1.0" | null; len: number | null; q: Record<string, number> }
const draftFor = (c: Cfg): QuoteDraft => {
  const d = structuredClone(nqQ0002()) as QuoteDraft & { config: Record<string, unknown> };
  const on: Record<string, boolean> = {}; for (const k of OPTIONAL_ITEM_KEYS) on[k] = c.opts.includes(k);
  d.config.optionalEquipment = on; d.config.feederVariant = c.feeder; d.config.doorSize = c.door; d.config.coolingSystemLengthM = c.len;
  d.config.estimatorQuantities = { ...(d.config.estimatorQuantities as object), pvc_door: 2, ...c.q };
  d.estimator.pricing = undefined as never; // the Budget price source is the one consulted, so every lookup is observable
  return d;
};
const { budgetSkuNeeds } = await import("../sku-needs");
const needsOf = (d: QuoteDraft): Set<string> => new Set(budgetSkuNeeds(d).map((n) => n.sku)); // the SERVICE's own function
const lookupsOf = (d: QuoteDraft): Set<string> => { const seen = new Set<string>(); evaluateDraft(d, { ...evaluationContext(true), priceSource: spy(seen), provisionalPackages: true }); return seen; };

const SUBSETS: string[][] = Array.from({ length: 1 << OPTIONAL_ITEM_KEYS.length }, (_, m) => OPTIONAL_ITEM_KEYS.filter((_, i) => m & (1 << i)));
const LENGTHS = [0.6, 3, 3.01, 20, 20.01, 25, 200];
const matrix: Cfg[] = [];
SUBSETS.forEach((opts, i) => matrix.push({ opts, feeder: i % 2 ? "WINDOW" : "STANDARD", door: ([null, "2.1x1.2", "2.1x1.0"] as const)[i % 3], len: LENGTHS[i % LENGTHS.length], q: { controller: 1, silo_weighing: 1, control_panel: 1, emergency_windows: 1 + (i % 7), cone_fans: 1 + (i % 4), manure_plug: 1 + (i % 25), pad_cooling: 1 } }));
// every cooling boundary and every window count with ONLY that item selected (so a lookup can never hide behind another option)
for (const len of LENGTHS) matrix.push({ opts: ["pad_cooling"], feeder: "STANDARD", door: null, len, q: { pad_cooling: 1 } });
for (let n = 1; n <= 9; n++) matrix.push({ opts: ["emergency_windows"], feeder: "STANDARD", door: null, len: null, q: { emergency_windows: n } });

describe("every SKU the Budget looks up is in the list automatic pricing sends to Cin7", () => {
  it(`(A) ${matrix.length} systematic configurations: lookups are a subset of needs`, () => {
    const missing: string[] = [];
    for (const c of matrix) { const d = draftFor(c); const need = needsOf(d); for (const s of lookupsOf(d)) if (!need.has(s)) missing.push(`${s} [${c.opts.join("+") || "standard"}]`); }
    expect(missing.slice(0, 10)).toEqual([]);
  });
  it("(A2) each Budget default product and each package component appears in the needs as soon as ITS option is selected, alone", () => {
    const only = (k: string, q = 1): Set<string> => needsOf(draftFor({ opts: [k], feeder: "STANDARD", door: null, len: 12, q: { [k]: q } }));
    expect(only("controller")).toContain("HO05084000");
    expect(only("silo_weighing")).toContain("HO05084507");
    expect(only("cone_fans")).toContain("MUG4D14A1M10238");
    for (const s of ["ERT003", "HO08990730", "HO08020800", "RID503117", "RID507450", "RID507220", "RID590008", "NQPP1017", "NQ1060", "NQ3401", "NQ1088"]) expect(only("emergency_windows"), s).toContain(s);
    for (const s of ["MNQ039", "MNQ040", "MNQ041"]) expect(only("manure_plug"), s).toContain(s);
    for (const l of coolingBom(25).lines) expect(needsOf(draftFor({ opts: ["pad_cooling"], feeder: "STANDARD", door: null, len: 25, q: { pad_cooling: 1 } })), l.sku).toContain(l.sku);
  });
  it("(B) the union of needs covers every SKU the commercial mappings reference, except the documented never-priced-from-Cin7 references", () => {
    const union = new Set<string>(); for (const c of matrix) for (const s of needsOf(draftFor(c))) union.add(s);
    // By design NOT looked up in Cin7 for the Budget: the M75 reference parts (the Rep enters the price per system), the PVC door choices (priced from the Budget basis, or by an Estimator-confirmed product), the feeder alternative (an Estimator choice).
    const BY_DESIGN = new Set(["NQ1163", "NQ1223", "NQ1764", "NQ1227", "NQ1942", "NQ.TUBE.63", "NQ.TUBE.75", "T3750001", "TSA3750505", "T3000365", "NQ3132", "KNQ050-900", "KNQ160", "NQ3444", "NQ3444-B", "NQ2161", "NQ2281", "PNQ002"]);
    const unrequested = referencedSkus().filter((s) => !union.has(s) && !BY_DESIGN.has(s) && !(s in EXCLUDED_SKUS));
    expect(unrequested).toEqual([]);
  });
});
