import { describe, expect, it } from "vitest";
import { calculatePricing, LEGACY_RULE_VERSION, micro, type PricingScenario } from "../../model";
import { baseScenario, FIXTURE_ACTOR, FIXTURE_PRICING_DATE as PD } from "../../model/fixtures";
import { applyPricingSubmission, pricingFinality, rateInputHash, submissionFrom, type PricingSubmission } from "..";
import { AT, equivalentInputs, evalOf, withPricing } from "./helpers";

// EXCHANGE-RATE FRESHNESS (NQ-008B hardening): spot rates expire (proposed default 24 hours, subject to NewQuip's confirmation), forward cover is a DOCUMENTED rate with validity dates,
// an expired or unsupported rate fails safe (the line is not priced; it never falls back to an older rate or to zero), and nothing is repriced silently.
const by = { by: FIXTURE_ACTOR, at: PD };
const H = 3_600_000;
const at = (hoursBefore: number) => new Date(Date.parse(PD) - hoursBefore * H).toISOString();
const scenario = (hoursOld: number, over: Partial<PricingScenario> = {}): PricingScenario => baseScenario({
  fxQuotes: { EUR: { rateMicro: micro("20"), source: "Fixture spot", asOf: at(hoursOld) }, USD: { rateMicro: micro("18.5"), source: "Fixture spot", asOf: at(hoursOld) } }, ...over,
});
const fc = (over: Record<string, unknown> = {}) => ({ rateMicro: micro("19"), coverDays: 90, reference: "FEC-1", validFrom: "2026-11-01", validUntil: "2026-12-31", reason: "booked", ...by, ...over });
const R = (s: PricingScenario, rules = LEGACY_RULE_VERSION) => calculatePricing(s, rules);

describe("spot-rate freshness (default 24 hours)", () => {
  it("the proposed default is 24 hours and configurable by rule version", () => expect(LEGACY_RULE_VERSION.spotRateMaxAgeHours).toBe(24));
  it("a rate up to 24 hours old prices; 24h 1min does not: the lines are NOT priced, never zero, never taken from an older rate", () => {
    expect(R(scenario(24)).priceCompleteness).not.toBe("incomplete");
    const r = R(scenario(24.02));
    const eur = r.lines.find((l) => l.currency === "EUR")!;
    expect(eur).toMatchObject({ status: "not_priced", unitPriceCents: null, rate: null });
    expect(eur.issues.map((i) => i.code)).toEqual(["rate_expired"]);
    expect(r.totalExVatCents).toBeNull();
    expect(r.lines.find((l) => l.currency === "ZAR")!.status).toBe("priced"); // rand lines need no rate
  });
  it("a different freshness rule (48 hours) is just data", () => {
    expect(R(scenario(30), { ...LEGACY_RULE_VERSION, spotRateMaxAgeHours: 48 }).priceCompleteness).not.toBe("incomplete");
    expect(R(scenario(30), { ...LEGACY_RULE_VERSION, spotRateMaxAgeHours: null }).priceCompleteness).not.toBe("incomplete");
  });
  it("a rate dated after the pricing date, with no source, or an invalid date is refused as an unsupported rate", () => {
    const bad = (q: { rateMicro: number; source: string; asOf: string }) => { try { R(scenario(1, { fxQuotes: { EUR: q, USD: q } })); return ""; } catch (e) { return (e as Error).message; } };
    expect(bad({ rateMicro: micro("20"), source: "Fixture", asOf: new Date(Date.parse(PD) + 2 * H).toISOString() })).toMatch(/cannot be dated after the pricing date/);
    expect(bad({ rateMicro: micro("20"), source: " ", asOf: at(1) })).toMatch(/needs a source/);
    expect(bad({ rateMicro: micro("20"), source: "Fixture", asOf: "not a date" })).toMatch(/no valid date/);
  });
});

describe("documented forward cover with validity", () => {
  const withFc = (f: ReturnType<typeof fc>, hours = 1) => scenario(hours, { forwardCover: { EUR: f } });
  it("applies inside its validity dates (inclusive of the last day) and records its reference", () => {
    const r = R(withFc(fc()));
    expect(r.lines.find((l) => l.currency === "EUR")!.rate).toMatchObject({ kind: "forward_cover", rateMicro: 19_000_000 });
    expect(R(withFc(fc({ validUntil: "2026-11-12" }))).lines.find((l) => l.currency === "EUR")!.status).toBe("priced"); // valid through the end of 12 Nov
  });
  it("expired or not yet valid: the line is NOT priced and does NOT fall back to the spot rate", () => {
    const exp = R(withFc(fc({ validUntil: "2026-11-11" })));
    expect(exp.lines.find((l) => l.currency === "EUR")).toMatchObject({ status: "not_priced", rate: null });
    expect(exp.issues.map((i) => i.code)).toContain("forward_cover_expired");
    const early = R(withFc(fc({ validFrom: "2026-11-13", validUntil: "2026-12-31" })));
    expect(early.issues.map((i) => i.code)).toContain("forward_cover_not_yet_valid");
    expect(early.lines.find((l) => l.currency === "EUR")!.status).toBe("not_priced");
  });
  it("a forward-cover rate without a contract reference or without validity dates is undocumented and unusable; dates must be valid and ordered", () => {
    for (const f of [fc({ reference: "" }), fc({ validFrom: undefined }), fc({ validUntil: undefined })]) {
      const r = R(withFc(f as ReturnType<typeof fc>));
      expect(r.issues.map((i) => i.code)).toContain("forward_cover_undocumented");
      expect(r.lines.find((l) => l.currency === "EUR")!.status).toBe("not_priced");
    }
    const err = (f: ReturnType<typeof fc>) => { try { R(withFc(f)); return ""; } catch (e) { return (e as Error).message; } };
    expect(err(fc({ validFrom: "2026-12-31", validUntil: "2026-11-01" }))).toMatch(/ends before it starts/);
    expect(err(fc({ validUntil: "never" }))).toMatch(/not valid dates/);
  });
  it("an expired SPOT rate does not matter while a valid forward cover covers that currency (and vice versa the forward cover never rescues USD)", () => {
    const r = R(scenario(48, { forwardCover: { EUR: fc() } }));
    expect(r.lines.find((l) => l.currency === "EUR")!.status).toBe("priced");
    expect(r.lines.find((l) => l.currency === "USD")!.status).toBe("not_priced");
  });
});

describe("freshness at sign-off / approval is a GATE, never a silent repricing", () => {
  const priced = (hours: number) => { const p = equivalentInputs({ pricingDate: AT, fxQuotes: { EUR: { rateMicro: micro("20"), source: "Fixture spot", asOf: AT }, USD: { rateMicro: micro("20"), source: "Fixture spot", asOf: AT } } }, "verified"); void hours; return p; };
  const later = (h: number) => new Date(Date.parse(AT) + h * H).toISOString();
  it("the evaluation (and so every total, snapshot and baseline) does not change as time passes; only the gate does", () => {
    const d = withPricing(priced(0));
    const total = evalOf(d).budget!.totals.subtotalExTax;
    expect(pricingFinality(d.estimator.pricing, evalOf(d).budget, later(23)).final).toBe(true);
    const stale = pricingFinality(d.estimator.pricing, evalOf(d).budget, later(25));
    expect(stale.final).toBe(false);
    expect(stale.reasons.join(" ")).toMatch(/The (EUR|USD) spot rate is older than 24 hours\. Record a current rate \(nothing is repriced until you save one\)/);
    expect(evalOf(d).budget!.totals.subtotalExTax).toBe(total); // identical: no silent repricing
  });
  it("an expired forward-cover contract blocks too, with its date", () => {
    const d = withPricing(priced(0));
    const base = (cur: string) => ({ rateMicro: micro("19"), coverDays: 90, reference: `FEC-${cur}`, validFrom: "2026-11-01", validUntil: "2026-11-20", reason: "r", by: "x", at: AT });
    // (an attested rate: an independent reviewer, so only expiry can fail)
    const fcov = (cur: string) => ({ ...base(cur), review: { by: "reviewer@example.test", at: AT, evidence: "FEC confirmation", inputHash: rateInputHash(cur, base(cur)) } });
    d.estimator.pricing!.forwardCover = { EUR: fcov("EUR"), USD: (() => { const u = { ...base("USD"), validUntil: "2026-12-31" }; return { ...u, review: { by: "reviewer@example.test", at: AT, evidence: "FEC confirmation", inputHash: rateInputHash("USD", u) } }; })() }; // (a valid USD contract, so only the EUR one can fail)
    expect(pricingFinality(d.estimator.pricing, evalOf(d).budget, "2026-11-20T23:00:00.000Z").final).toBe(true);
    expect(pricingFinality(d.estimator.pricing, evalOf(d).budget, "2026-11-21T00:30:00.000Z").reasons.join(" ")).toMatch(/EUR forward-cover rate expired on 2026-11-20/);
  });
  it("saving a NEW rate is what reprices (and sets a fresh pricing date): a stale quotation is refreshed by an explicit, attributed revision", () => {
    const p = priced(0);
    const sub: PricingSubmission = structuredClone(submissionFrom(p));
    sub.fxQuotes.EUR = { rateMicro: micro("20.5"), source: "Fixture spot", asOf: later(26) };
    const r = applyPricingSubmission(p, sub, { roles: new Set(["estimator"]), canSeeCost: true }, "est@x", later(26), "Refresh the EUR rate", "project");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.next!.pricingDate).toBe(later(26));
  });
});
