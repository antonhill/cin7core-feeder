import { describe, expect, it } from "vitest";
import { hashOf } from "../../quote/baseline";
import { readyDraft } from "../../grower/__tests__/golden";
import { cloneDraft } from "./helpers";
import { changeStampLabel, stampChanges, stampsSince, trackedValues } from "../change-stamps";

const ctx = (over: Partial<Parameters<typeof stampChanges>[2]> = {}) => ({ state: "ESTIMATOR_REVIEW" as const, revision: 1, email: "est@x", nowIso: "2026-11-12T08:00:00.000Z", ...over });

describe("server-owned change stamps", () => {
  it("a draft nobody changed gets NO changeStamps key, so it hashes exactly as before (existing sign-offs stay valid)", () => {
    const prior = readyDraft();
    const next = stampChanges(structuredClone(prior), prior, ctx());
    expect("changeStamps" in next.estimator).toBe(false);
    expect(hashOf(next)).toBe(hashOf(prior));
  });
  it("a change while the quotation is with the Estimator is stamped with the actor, time and revision; unchanged inputs are not", () => {
    const prior = readyDraft();
    const submitted = cloneDraft((d) => { d.estimator.charges.installation = 500_000; }, prior);
    const out = stampChanges(submitted, prior, ctx());
    expect(out.estimator.changeStamps).toEqual({ "charges.installation": { by: "est@x", at: "2026-11-12T08:00:00.000Z", rev: 1 } });
  });
  it("a change while it is still the Rep's draft is NOT stamped (there is no handoff to be adjusted from)", () => {
    const prior = readyDraft();
    const out = stampChanges(cloneDraft((d) => { d.estimator.charges.installation = 1; }, prior), prior, ctx({ state: "REP_DRAFT" }));
    expect("changeStamps" in out.estimator).toBe(false);
  });
  it("whatever stamps a client submits are discarded; the stored stamps are kept and only a real change adds one", () => {
    const prior = cloneDraft((d) => { d.estimator.changeStamps = { "charges.delivery": { by: "first@x", at: "2026-11-12T07:00:00.000Z", rev: 1 } }; });
    const forged = cloneDraft((d) => { d.estimator.changeStamps = { "charges.delivery": { by: "someone-else@x", at: "2020-01-01T00:00:00.000Z", rev: 1 }, "unitPrices.flex_auger": { by: "forged@x", at: "2020-01-01T00:00:00.000Z", rev: 1 } }; }, prior);
    const out = stampChanges(forged, prior, ctx());
    expect(out.estimator.changeStamps).toEqual({ "charges.delivery": { by: "first@x", at: "2026-11-12T07:00:00.000Z", rev: 1 } });
  });
  it("a second change to the same input replaces its stamp (latest actor wins); a different input keeps the first", () => {
    const p0 = readyDraft();
    const d1 = stampChanges(cloneDraft((d) => { d.estimator.charges.installation = 1_000_000; }, p0), p0, ctx({ email: "a@x", nowIso: "2026-11-12T08:00:00.000Z" }));
    const d2 = stampChanges(cloneDraft((d) => { d.estimator.charges.installation = 2_000_000; d.estimator.charges.delivery = 9; }, d1), d1, ctx({ email: "b@x", nowIso: "2026-11-12T09:00:00.000Z" }));
    expect(d2.estimator.changeStamps!["charges.installation"].by).toBe("b@x");
    expect(d2.estimator.changeStamps!["charges.delivery"].by).toBe("b@x");
    expect(Object.keys(d2.estimator.changeStamps!).sort()).toEqual(["charges.delivery", "charges.installation"]);
  });
  it("tracks mappings, quantities, overrides, exclusions, optional equipment, penning, feeder variant, quotation type and layout", () => {
    const prior = readyDraft();
    const next = cloneDraft((d) => {
      d.estimator.confirmedMappings.feeder = "PNQ082-WINDOW"; d.config.estimatorQuantities!.feeder = 15; d.config.quantityOverrides!.led_light = 3; d.config.exclusions!.pvc_door = "customer supplies";
      d.config.optionalEquipment.pad_cooling = true; d.config.penningPigSize = "LARGE"; d.config.feederVariant = "WINDOW"; d.quoteType = "day_to_day"; d.config.lengthM += 1;
    }, prior);
    const keys = Object.keys(stampChanges(next, prior, ctx()).estimator.changeStamps!).sort();
    expect(keys).toEqual(["confirmedMappings.feeder", "estimatorQuantities.feeder", "exclusions.pvc_door", "feederVariant", "layout", "optionalEquipment.pad_cooling", "penningPigSize", "quantityOverrides.led_light", "quoteType"]);
    expect(Object.keys(trackedValues(prior))).toContain("layout");
  });
  it("labels are readable and stamps apply only to the revision and time they were made in", () => {
    expect(changeStampLabel("charges.installation")).toBe("Charge: installation");
    expect(changeStampLabel("layout")).toMatch(/layout/i);
    const stamps = { a: { by: "x", at: "2026-11-12T08:00:00.000Z", rev: 1 }, b: { by: "x", at: "2026-11-12T08:00:00.000Z", rev: 2 }, c: { by: "x", at: "2026-11-12T06:00:00.000Z", rev: 1 } };
    // the database formats its timestamps differently from the server: compared as instants, not as strings
    expect(Object.keys(stampsSince(stamps, 1, "2026-11-12T07:00:00.123456+00:00"))).toEqual(["a"]);
  });
});
