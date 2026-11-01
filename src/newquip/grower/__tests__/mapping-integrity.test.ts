import { describe, expect, it } from "vitest";
import { evaluateDraft } from "../evaluate";
import { readyDraft } from "./golden";
import { testPriceSource } from "./test-snapshot";
import { readFileSync } from "node:fs";
import { changedMappings, mappedSkus, mappingError, mappingsChanged, normaliseMappings } from "../mapping-integrity";
import { expectedSkuFor } from "../quote-bridge";
import { GROWER_ITEM_KEYS, isOptionalItemKey, OPTIONAL_ITEM_KEYS } from "../types";

const draftWith = (mapping?: string, resolution?: { unitPriceExVat: number; reason: string }) => {
  const d = readyDraft();
  d.config.optionalEquipment = { ...d.config.optionalEquipment, controller: true };
  d.config.estimatorQuantities = { ...d.config.estimatorQuantities, controller: 2 };
  if (mapping) d.estimator.confirmedMappings.controller = mapping;
  if (resolution) d.estimator.priceResolutions.controller = resolution;
  return d;
};
const lineOf = (d: ReturnType<typeof draftWith>) => evaluateDraft(d, { priceSource: testPriceSource(), withholdCost: false }).budget!.lines.find((l) => l.itemKey === "controller")!;

describe("UAT-001 optional additional element mapping (GROWER-OPT-001 controller)", () => {
  it("without a chosen product the line says mapping is not confirmed (the state the owner saw)", () => {
    const l = lineOf(draftWith());
    expect(l.status).toBe("unmapped");
    expect(l.reason).toMatch(/mapping not yet confirmed/i);
  });
  it("a chosen Cin7 product becomes the line's SKU (no longer 'unmapped'); an unpriced SKU needs an explicit manual price, never a silent one", () => {
    const l = lineOf(draftWith("CTRL-CL1-X"));
    expect(l.sku).toBe("CTRL-CL1-X");
    expect(l.status).not.toBe("unmapped");
    expect(l.pricedBy).toBeNull(); // not in the price source: blocked until priced
  });
  it("with a recorded manual price the mapped line is priced and flagged as an estimator resolution", () => {
    const l = lineOf(draftWith("CTRL-CL1-X", { unitPriceExVat: 12_000, reason: "Supplier quote 2026-10-30 for the CL1 controller" }));
    expect(l.status).toBe("priced");
    expect(l.pricedBy).toBe("estimator_resolution");
    expect(l.sku).toBe("CTRL-CL1-X");
  });
  it("non-optional lines keep the strict expected-SKU rule (a wrong SKU for the bulk tank is still refused)", () => {
    const d = readyDraft();
    d.estimator.confirmedMappings.bulk_tank = "SOME-OTHER-SKU";
    const l = evaluateDraft(d, { priceSource: testPriceSource(), withholdCost: false }).budget!.lines.find((x) => x.itemKey === "bulk_tank")!;
    expect(l.status).toBe("unmapped");
  });
  it("the optional key list is exactly the seven additional elements", () => {
    expect([...OPTIONAL_ITEM_KEYS].sort()).toEqual(["cone_fans", "control_panel", "controller", "emergency_windows", "manure_plug", "pad_cooling", "silo_weighing"]);
    expect(isOptionalItemKey("controller")).toBe(true);
    expect(isOptionalItemKey("feeder")).toBe(false);
  });
});

describe("mapping verification against the catalogue (every item key)", () => {
  it("collects every mapping, trimmed, and skips blanks", () => {
    expect(mappedSkus({ controller: " C1 ", feeder: "PNQ082", pad_cooling: "" })).toEqual([{ itemKey: "controller", sku: "C1" }, { itemKey: "feeder", sku: "PNQ082" }]);
  });
  it("refuses a SKU that is not in the catalogue or is inactive; accepts an active one", () => {
    const m = [{ itemKey: "controller", sku: "C1" }];
    expect(mappingError(m, [])).toMatch(/not in the synced Cin7 catalogue/);
    expect(mappingError(m, [{ sku: "C1", active: false }])).toMatch(/inactive/);
    expect(mappingError(m, [{ sku: "C1", active: true }])).toBeNull();
    expect(mappingError(m, [{ sku: "C1", active: null }])).toBeNull();
  });
  it("a non-optional item must map to its source-backed SKU, even when that SKU is in the catalogue", () => {
    const exp = expectedSkuFor("bulk_tank")!;
    const cat = [{ sku: exp, active: true }, { sku: "OTHER", active: true }];
    expect(mappingError([{ itemKey: "bulk_tank", sku: "OTHER" }], cat)).toMatch(/not the source-backed product/);
    expect(mappingError([{ itemKey: "bulk_tank", sku: exp }], cat)).toBeNull();
  });
  it("the feeder follows its variant", () => {
    const win = expectedSkuFor("feeder", "WINDOW")!;
    const std = expectedSkuFor("feeder", "STANDARD")!;
    expect(win).not.toBe(std);
    const cat = [{ sku: win, active: true }, { sku: std, active: true }];
    expect(mappingError([{ itemKey: "feeder", sku: std }], cat, "WINDOW")).toMatch(/source-backed/);
    expect(mappingError([{ itemKey: "feeder", sku: win }], cat, "WINDOW")).toBeNull();
  });
  it("pvc_door is the estimator's free choice but still needs an active catalogue product", () => {
    expect(mappingError([{ itemKey: "pvc_door", sku: "DOOR-X" }], [{ sku: "DOOR-X", active: true }])).toBeNull();
    expect(mappingError([{ itemKey: "pvc_door", sku: "DOOR-X" }], [{ sku: "DOOR-X", active: false }])).toMatch(/inactive/);
  });
  it("an unknown item key is refused", () => {
    expect(mappingError([{ itemKey: "made_up", sku: "A" }], [{ sku: "A", active: true }])).toMatch(/not a product slot/);
  });
  it("the item key list covers every optional key", () => {
    for (const k of OPTIONAL_ITEM_KEYS) expect(GROWER_ITEM_KEYS).toContain(k);
    expect(new Set(GROWER_ITEM_KEYS).size).toBe(GROWER_ITEM_KEYS.length);
  });
});

describe("mapping changes are authorised and normalised on the server", () => {
  it("detects a change to ANY mapping (add, change, remove), optional or not, and ignores formatting", () => {
    expect(mappingsChanged({}, { controller: "C1" })).toBe(true);
    expect(mappingsChanged({ controller: "C1" }, { controller: "C2" })).toBe(true);
    expect(mappingsChanged({ controller: "C1" }, {})).toBe(true);
    expect(mappingsChanged({ pvc_door: "A" }, { pvc_door: "B" })).toBe(true);
    expect(mappingsChanged({ feeder: "A" }, { feeder: "B" })).toBe(true);
    expect(mappingsChanged({ feeder: "A" }, { feeder: " A " })).toBe(false);
    expect(mappingsChanged({ feeder: "A" }, { feeder: "A", controller: "" })).toBe(false);
  });
  it("changedMappings returns only new or different entries (so an unchanged stale SKU does not block a save)", () => {
    expect(changedMappings({ pvc_door: "A", feeder: "F" }, { pvc_door: "A", feeder: "G", controller: "C" })).toEqual([{ itemKey: "feeder", sku: "G" }, { itemKey: "controller", sku: "C" }]);
    expect(changedMappings({ pvc_door: "A" }, { pvc_door: "A" })).toEqual([]);
  });
  it("trims mappings and drops non-strings, blanks and unknown keys, so the verified value is the stored value", () => {
    const d = { estimator: { confirmedMappings: { controller: " REAL ", pad_cooling: 123 as never, cone_fans: "  ", feeder: "PNQ082", made_up: "X" } } };
    expect(normaliseMappings(d).estimator.confirmedMappings).toEqual({ controller: "REAL", feeder: "PNQ082" });
  });
  it("BOTH routes that store a client-supplied draft (create and save) go through the same sanitising step, which enforces authority before storing", () => {
    const src = readFileSync(new URL("../../../app/newquip-grower/actions.ts", import.meta.url), "utf8");
    const helper = src.indexOf("async function sanitiseSubmittedDraft(");
    expect(helper).toBeGreaterThan(0);
    const body = src.slice(helper, src.indexOf("\n}\n", helper));
    expect(body).toMatch(/mappingsChanged\(prior\?\.estimator\.confirmedMappings/);
    expect(body).toMatch(/!hasAny\(a\.roles, \["estimator", "manager"\]\)\) throw/);
    expect(body).toMatch(/await verifyMappings\(db, a\.orgId, changedMappings\(/);
    expect(body).toMatch(/stampPriceResolutions\(/);
    expect(body).toMatch(/stampCostOverrides\(/);
    const create = src.slice(src.indexOf("export async function createGrowerQuoteAction("), src.indexOf("export async function getGrowerQuoteAction("));
    expect(create).toMatch(/await sanitiseSubmittedDraft\(a, db, draft, undefined\)/);
    const save = src.slice(src.indexOf("export async function saveGrowerDraftAction("));
    expect(save.slice(0, 900)).toMatch(/await sanitiseSubmittedDraft\(a, db, draft, prior\?\.draft\)/);
  });
  it("estimator sign-off re-verifies EVERY mapped SKU against the catalogue before stamping (not only at draft save)", () => {
    const src = readFileSync(new URL("../../../lib/newquip-quotes/quote-store.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("export async function estimatorSignOff("), src.indexOf("export async function managerApprove("));
    const verify = fn.indexOf("verifyMappings(db, orgId, mappedSkus(q.draft.estimator.confirmedMappings)");
    expect(verify).toBeGreaterThan(0);
    expect(verify).toBeLessThan(fn.indexOf('.update({ estimator_signoff_hash'));
    expect(fn).toMatch(/Cannot sign off/);
  });
});
