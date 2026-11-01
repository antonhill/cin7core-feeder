import { describe, expect, it } from "vitest";
import { stampPriceResolutions } from "../price-resolution";
import { rolesFor } from "../roles";

const NOW = "2026-11-01T10:00:00Z";
const est = rolesFor("member"); const none = new Set<never>(); const mgr = rolesFor("admin");
const r = (p: number, reason = "Supplier quote 2026-10-30") => ({ unitPriceExVat: p, reason });

describe("UAT-002 manual quotation price provenance and permission", () => {
  it("a new manual price is stamped by the server with who and when (client-supplied by/at are ignored)", () => {
    const out = stampPriceResolutions({ led_light: { ...r(900), by: "forged@x", at: "1999" } }, undefined, est, "est@x", NOW);
    expect(out.led_light).toEqual({ unitPriceExVat: 900, reason: "Supplier quote 2026-10-30", by: "est@x", at: NOW });
  });
  it("an unchanged price keeps its earlier stamp; a changed price or reason is re-stamped", () => {
    const prior = { led_light: { ...r(900), by: "a@x", at: "T0" } };
    expect(stampPriceResolutions({ led_light: r(900) }, prior, est, "b@x", NOW).led_light).toMatchObject({ by: "a@x", at: "T0" });
    expect(stampPriceResolutions({ led_light: r(950) }, prior, est, "b@x", NOW).led_light).toMatchObject({ by: "b@x", at: NOW, unitPriceExVat: 950 });
    expect(stampPriceResolutions({ led_light: r(900, "New reason here") }, prior, mgr, "m@x", NOW).led_light).toMatchObject({ by: "m@x" });
  });
  it("a caller with neither Estimator nor Manager authority cannot add, change or remove one, but can save a draft that leaves them untouched", () => {
    const prior = { led_light: { ...r(900), by: "a@x", at: "T0" } };
    expect(() => stampPriceResolutions({ led_light: r(1) }, prior, none, "rep@x", NOW)).toThrow(/Estimator or Manager/);
    expect(() => stampPriceResolutions({ led_light: r(900), controller: r(5) }, prior, none, "rep@x", NOW)).toThrow();
    expect(() => stampPriceResolutions({}, prior, none, "rep@x", NOW)).toThrow(/remove/);
    expect(stampPriceResolutions({ led_light: r(900) }, prior, none, "rep@x", NOW).led_light).toMatchObject({ by: "a@x" });
  });
});
