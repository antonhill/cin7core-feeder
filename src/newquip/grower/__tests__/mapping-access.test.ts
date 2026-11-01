import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canMapProducts, mappingControlFor } from "../mapping-access";
import { OPTIONAL_ITEM_KEYS } from "../types";

// UAT-001 regression (combined Preview a93a109): the Thomas-CL1 controller line (GROWER-OPT-001) said "Product mapping not yet confirmed" in the Line decisions
// table, but the Cin7 product chooser lived in a separate panel further down, so the Estimator saw no way to choose a product. The chooser now sits in the same row.
const estimator = new Set(["rep", "estimator"]);
const manager = new Set(["rep", "estimator", "manager"]);
const rep = new Set(["rep"]);

describe("who is offered the Cin7 product chooser", () => {
  it("an Estimator and a Manager can map products; a Rep cannot", () => {
    expect(canMapProducts(estimator)).toBe(true);
    expect(canMapProducts(manager)).toBe(true);
    expect(canMapProducts(rep)).toBe(false);
  });
  it("every optional element that is in the quotation gets the chooser for an Estimator (including the Thomas-CL1 controller)", () => {
    expect(OPTIONAL_ITEM_KEYS).toContain("controller");
    for (const k of OPTIONAL_ITEM_KEYS) expect(mappingControlFor(k, "estimator_entry", estimator, true), k).toBe("chooser");
    expect(mappingControlFor("controller", "estimator_entry", manager, true)).toBe("chooser");
  });
  it("a Rep is not offered the chooser; the row says an Estimator must choose", () => {
    for (const k of OPTIONAL_ITEM_KEYS) expect(mappingControlFor(k, "estimator_entry", rep, true), k).toBe("waiting_for_estimator");
  });
  it("a read-only view (accepted quote) never offers it, even to an Estimator", () => {
    expect(mappingControlFor("controller", "estimator_entry", estimator, false)).toBe("waiting_for_estimator");
  });
  it("an optional element that is not selected, and every non-optional item, get no chooser", () => {
    expect(mappingControlFor("controller", "not_selected", estimator, true)).toBe("none");
    for (const k of ["feeder", "pvc_door", "bulk_tank", "led_light"]) expect(mappingControlFor(k, "per_feeder", estimator, true), k).toBe("none");
  });
});

describe("the page wires the chooser into the Line decisions row", () => {
  const src = readFileSync(new URL("../../../app/newquip-grower/[id]/page.tsx", import.meta.url), "utf8");
  it("the Line decisions table renders the chooser through mappingControlFor, before the Product mappings panel", () => {
    const table = src.indexOf("Line decisions (per room");
    const panel = src.indexOf("<PanelTitle>Product mappings</PanelTitle>");
    const chooser = src.indexOf("<ProductMappingPicker");
    expect(table).toBeGreaterThan(0);
    expect(chooser).toBeGreaterThan(table);
    expect(chooser).toBeLessThan(panel);
    expect(src).toContain("mappingControlFor(l.itemKey, l.basis, roles, editable)");
    expect((src.match(/<ProductMappingPicker/g) ?? []).length).toBe(1);
  });
});
