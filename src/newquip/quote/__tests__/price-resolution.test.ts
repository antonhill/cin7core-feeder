import { describe, expect, it } from "vitest";
import { stampPriceResolutions, type ResolutionMap } from "../price-resolution";
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

// A Rep is sent the REDACTED reason of a manual price (its evidence is internal) and saves the draft back with it. That must not read as a change, and a genuine change must still be refused.
describe("a Rep saving back the redacted manual-price reason (evidence redaction)", async () => {
  const { redactInternalFinancials } = await import("../margin");
  const { encodeManualReason } = await import("../estimator-workspace");
  const stored = encodeManualReason("No SKU exists for the FORTIS 1.2 yet", "Supplier quote SQ-9981, dated 12 Nov");
  const prior = (): ResolutionMap => ({ led_light: { unitPriceExVat: 881, reason: stored, by: "est@nq", at: "2026-11-10T08:00:00.000Z" } });
  const repView = (p: ResolutionMap): ResolutionMap => (redactInternalFinancials({ draft: { estimator: { priceResolutions: structuredClone(p) } }, accepted_baseline: null } as never, false) as unknown as { draft: { estimator: { priceResolutions: ResolutionMap } } }).draft.estimator.priceResolutions;
  const rep = new Set(["rep"]) as unknown as ReadonlySet<never>;
  const est = new Set(["estimator"]) as unknown as ReadonlySet<never>;

  it("the redacted draft goes back unchanged: no refusal, and the stored value and stamp are byte-for-byte the same (evidence included)", () => {
    const shown = repView(prior());
    expect(JSON.stringify(shown)).not.toMatch(/SQ-9981|EVIDENCE/);
    const before = JSON.stringify(prior());
    const out = stampPriceResolutions(shown, prior(), rep, "rep@nq", "2026-11-15T08:00:00.000Z");
    expect(JSON.stringify(out)).toBe(before);
    expect(out.led_light!.reason).toBe(stored);
  });
  it("a Rep who changes the price, the reason, adds a price or removes one is still refused", () => {
    const shown = repView(prior());
    expect(() => stampPriceResolutions({ led_light: { ...shown.led_light!, unitPriceExVat: 1 } }, prior(), rep, "r", "t")).toThrow(/Only an Estimator or Manager/);
    expect(() => stampPriceResolutions({ led_light: { ...shown.led_light!, reason: "a different reason" } }, prior(), rep, "r", "t")).toThrow(/Only an Estimator or Manager/);
    expect(() => stampPriceResolutions({ led_light: { ...shown.led_light!, reason: `${shown.led_light!.reason} edited` } }, prior(), rep, "r", "t")).toThrow(/Only an Estimator or Manager/);
    expect(() => stampPriceResolutions({ ...shown, cup_drinker: { unitPriceExVat: 5, reason: "x" } }, prior(), rep, "r", "t")).toThrow(/Only an Estimator or Manager/);
    expect(() => stampPriceResolutions({}, prior(), rep, "r", "t")).toThrow(/Only an Estimator or Manager can remove/);
  });
  it("a Rep cannot smuggle evidence in: submitting the full stored text for a changed price is still a change", () => {
    expect(() => stampPriceResolutions({ led_light: { unitPriceExVat: 1, reason: stored } }, prior(), rep, "r", "t")).toThrow(/Only an Estimator or Manager/);
  });
  it("an Estimator's path is unchanged: the redacted form is a CHANGE for them (stamped), the identical text is not", () => {
    const shown = repView(prior());
    const changed = stampPriceResolutions(shown, prior(), est, "est2@nq", "2026-11-15T08:00:00.000Z");
    expect(changed.led_light).toMatchObject({ by: "est2@nq", reason: shown.led_light!.reason });
    expect(stampPriceResolutions(prior(), prior(), est, "est2@nq", "t").led_light).toEqual(prior().led_light);
  });
  it("a legacy free-text reason round-trips for a Rep exactly as before, including wording the redaction rewrites", () => {
    for (const reason of ["Phoned the supplier", "Priced at landed cost (Cost × ROE × Freight) + 20% by the supplier"]) {
      const p: ResolutionMap = { led_light: { unitPriceExVat: 5, reason, by: "est@nq", at: "t0" } };
      const out = stampPriceResolutions(repView(p), p, rep, "rep@nq", "t1");
      expect(out).toEqual(p);
    }
  });
});
