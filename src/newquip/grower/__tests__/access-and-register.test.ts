import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isNewquipPocOrg, NEWQUIP_POC_ORG_IDS } from "@/newquip/access";
import { GROWER_RULES, DERIVED_RULES } from "../rules";

describe("visibility", () => {
  it("only the NewQuip POC org passes", () => {
    expect(NEWQUIP_POC_ORG_IDS).toHaveLength(1);
    expect(isNewquipPocOrg("e1aea782-d095-47ad-90fb-4fa65c9bf855")).toBe(true);
    expect(isNewquipPocOrg("0242e481-0f2b-4bd9-a8ef-2d4a9554bc09")).toBe(false);
    expect(isNewquipPocOrg("")).toBe(false);
  });
});

describe("rule register stays in sync with the code", () => {
  const doc = readFileSync(path.resolve(__dirname, "../../../../docs/newquip-grower-poc-rule-register.md"), "utf8");
  const ids = [...GROWER_RULES.map((r) => r.id), DERIVED_RULES.floorArea.id, DERIVED_RULES.roomMultiplier.id];
  it("lists every rule id exactly in the register", () => {
    for (const id of ids) expect(doc).toContain(id);
  });
  it("rule ids are unique", () => expect(new Set(ids).size).toBe(ids.length));
  it("only the rules Sean's final feedback CONFIRMED are classified verified: lighting minimum and penning rates", () => {
    expect(GROWER_RULES.filter((r) => r.classification === "verified").map((r) => r.itemKey).sort()).toEqual(["led_light", "penning_package"]);
  });
  it("every quantity decision names how it is made (treatment) — manual-by-design is explicit, not unfinished", () => {
    for (const r of GROWER_RULES) expect(r.treatment).toBeTruthy();
    for (const k of ["flex_auger", "concrete_slat", "pvc_door", "bulk_tank"] as const) {
      expect(GROWER_RULES.find((r) => r.itemKey === k)!.treatment).toBe("estimator_input");
    }
  });
  it("no rule names a Cin7 SKU", () => {
    expect(JSON.stringify(GROWER_RULES.map((r) => ({ ...r, hypothesis: undefined, verifiedCompute: undefined })))).not.toMatch(/"sku"/i);
  });
});
