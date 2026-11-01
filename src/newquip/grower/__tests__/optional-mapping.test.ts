import { describe, expect, it } from "vitest";
import { evaluateDraft } from "../evaluate";
import { readyDraft } from "./golden";
import { testPriceSource } from "./test-snapshot";
import { readFileSync } from "node:fs";
import { normaliseOptionalMappings, optionalMappedSkus, optionalMappingError, optionalMappingsChanged } from "../optional-mapping";
import { isOptionalItemKey, OPTIONAL_ITEM_KEYS } from "../types";

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

describe("optional mapping verification against the catalogue", () => {
  it("collects only optional mappings", () => {
    expect(optionalMappedSkus({ controller: " C1 ", feeder: "PNQ082", pad_cooling: "" })).toEqual([{ itemKey: "controller", sku: "C1" }]);
  });
  it("refuses a SKU that is not in the catalogue or is inactive; accepts an active one", () => {
    const m = [{ itemKey: "controller", sku: "C1" }];
    expect(optionalMappingError(m, [])).toMatch(/not in the synced Cin7 catalogue/);
    expect(optionalMappingError(m, [{ sku: "C1", active: false }])).toMatch(/inactive/);
    expect(optionalMappingError(m, [{ sku: "C1", active: true }])).toBeNull();
    expect(optionalMappingError(m, [{ sku: "C1", active: null }])).toBeNull();
  });
});

describe("review P1/P2: mapping changes are authorised and normalised on the server", () => {
  it("detects a change to an optional mapping (add, change, remove) and ignores unrelated keys", () => {
    expect(optionalMappingsChanged({}, { controller: "C1" })).toBe(true);
    expect(optionalMappingsChanged({ controller: "C1" }, { controller: "C2" })).toBe(true);
    expect(optionalMappingsChanged({ controller: "C1" }, {})).toBe(true);
    expect(optionalMappingsChanged({ controller: "C1", feeder: "A" }, { controller: "C1", feeder: "B" })).toBe(false);
  });
  it("trims mappings and drops non-strings and blanks, so the verified value is the stored value", () => {
    const d = { estimator: { confirmedMappings: { controller: " REAL ", pad_cooling: 123 as never, cone_fans: "  ", feeder: "PNQ082" } } };
    expect(normaliseOptionalMappings(d).estimator.confirmedMappings).toEqual({ controller: "REAL", feeder: "PNQ082" });
  });
  it("saveGrowerDraftAction refuses a mapping change from a caller without Estimator/Manager authority, before saving", () => {
    const src = readFileSync(new URL("../../../app/newquip-grower/actions.ts", import.meta.url), "utf8");
    const guard = src.indexOf("optionalMappingsChanged(prior0");
    expect(guard).toBeGreaterThan(0);
    expect(src.slice(guard, guard + 260)).toMatch(/hasAny\(a\.roles, \["estimator", "manager"\]\)/);
    expect(guard).toBeLessThan(src.indexOf("await saveDraft(db, a.orgId, a.roles, quoteId"));
  });
});
