import { describe, expect, it } from "vitest";
import { LEGACY_RULE_VERSION, micro, type Viewer } from "../../model";
import { applyPricingSubmission, applyRateAttestation, mayAttestRate, normaliseSubmission, pricingFinality, rateInputHash, rateStateOf, submissionFrom, type EstimatorPricing, type StoredForwardCover } from "..";
import { AT, EST, REVIEWER, equivalentInputs, evalOf, withPricing } from "./helpers";

// INDEPENDENT FORWARD-COVER RATE ATTESTATION (NQ-008B P2-E): a person can never attest their own rate; spot rates are not attested.
const roles = (...r: Array<"rep" | "estimator" | "manager">): Viewer["roles"] => new Set(r);
const MGR: Viewer = { roles: roles("rep", "estimator", "manager"), canSeeCost: true };
const EST_V: Viewer = { roles: roles("rep", "estimator"), canSeeCost: true };
const RULES = LEGACY_RULE_VERSION;
const NOW = "2026-11-12T10:00:00.000Z";
const fc = (over: Partial<StoredForwardCover> = {}): StoredForwardCover => ({ rateMicro: micro("19"), coverDays: 90, reference: "FEC-1001", validFrom: "2026-11-01", validUntil: "2026-12-31", reason: "90-day contract with the bank", by: EST, at: AT, ...over });
const withFc = (eur: StoredForwardCover | undefined = fc(), usd?: StoredForwardCover): EstimatorPricing => equivalentInputs({ forwardCover: { ...(eur ? { EUR: eur } : {}), ...(usd ? { USD: usd } : {}) } });
const hashOf = (p: EstimatorPricing, cur = "EUR") => rateInputHash(cur, p.forwardCover[cur]!);
const items = (p: EstimatorPricing, curs: string[] = ["EUR"]) => curs.map((currency) => ({ currency, rateHash: p.forwardCover[currency] ? hashOf(p, currency) : "unknown" }));
const attested = (p: EstimatorPricing, by = "mgr@example.test"): EstimatorPricing => { const r = applyRateAttestation(p, items(p), MGR, by, NOW, "FEC-1001 confirmation", RULES); if (!r.ok) throw new Error(r.errors.join()); return r.next; };

describe("the rate state is DERIVED from an independent attestation of exactly this rate", () => {
  it("missing / undocumented / unattested / attested / outdated after a change / self-attested", () => {
    const p = withFc();
    expect(rateStateOf("EUR", undefined, RULES)).toBe("missing");
    expect(rateStateOf("EUR", p.forwardCover.EUR, RULES)).toBe("unattested");
    expect(rateStateOf("EUR", fc({ reference: undefined }), RULES)).toBe("undocumented");
    expect(rateStateOf("EUR", fc({ validUntil: undefined }), RULES)).toBe("undocumented");
    const ok = attested(p);
    expect(rateStateOf("EUR", ok.forwardCover.EUR, RULES)).toBe("attested");
    for (const change of [{ rateMicro: micro("19.1") }, { coverDays: 60 }, { reference: "FEC-2" }, { validFrom: "2026-11-02" }, { validUntil: "2026-12-30" }, { reason: "changed reason" }] as Array<Partial<StoredForwardCover>>) {
      expect(rateStateOf("EUR", { ...ok.forwardCover.EUR!, ...change }, RULES)).toBe("attestation_outdated");
    }
    const self = structuredClone(p); self.forwardCover.EUR!.review = { by: EST.toUpperCase(), at: AT, evidence: "mine", inputHash: hashOf(p) };
    expect(rateStateOf("EUR", self.forwardCover.EUR, RULES)).toBe("self_attested");
  });
  it("attribution (by / at) and the review itself are not part of the rate hash; the currency is", () => {
    const p = withFc();
    expect(rateInputHash("EUR", fc({ by: "other", at: "2030-01-01T00:00:00.000Z" }))).toBe(hashOf(p));
    expect(rateInputHash("USD", p.forwardCover.EUR!)).not.toBe(hashOf(p));
  });
  it("a forged attestation hash is never trusted", () => {
    const p = withFc(); p.forwardCover.EUR!.review = { by: REVIEWER, at: AT, evidence: "forged", inputHash: "0".repeat(64) };
    expect(rateStateOf("EUR", p.forwardCover.EUR, RULES)).toBe("attestation_outdated");
  });
});

describe("who may attest, and what is refused", () => {
  it("only a reviewer role who can see costs, and never the person who entered / last changed the rate (any case)", () => {
    const p = withFc();
    expect(applyRateAttestation(p, items(p), EST_V, "other@example.test", NOW, "FEC-1001", RULES)).toMatchObject({ ok: false, errors: [expect.stringMatching(/Only manager who can see costs/)] });
    expect(applyRateAttestation(p, items(p), { roles: roles("manager"), canSeeCost: false }, "m@example.test", NOW, "FEC-1001", RULES)).toMatchObject({ ok: false });
    expect(applyRateAttestation(p, items(p), MGR, EST, NOW, "FEC-1001", RULES)).toMatchObject({ ok: false, errors: [expect.stringMatching(/you entered or last changed this rate/)] });
    expect(applyRateAttestation(p, items(p), MGR, `  ${EST.toUpperCase()} `, NOW, "FEC-1001", RULES)).toMatchObject({ ok: false });
    expect(mayAttestRate(MGR, EST, "EUR", p.forwardCover.EUR, RULES)).toBe(false);
    expect(mayAttestRate(MGR, "mgr@example.test", "EUR", p.forwardCover.EUR, RULES)).toBe(true);
    expect(mayAttestRate(EST_V, "x@example.test", "EUR", p.forwardCover.EUR, RULES)).toBe(false);
  });
  it("needs 3 to 500 characters of evidence, a known currency, something to attest, and refuses the WHOLE request if any part is refused", () => {
    const p = withFc();
    for (const ev of ["", "  ", "ab", "x".repeat(501), 5 as unknown as string]) expect(applyRateAttestation(p, items(p), MGR, "m@x", NOW, ev, RULES)).toMatchObject({ ok: false });
    expect(applyRateAttestation(p, [], MGR, "m@x", NOW, "FEC-1001", RULES)).toMatchObject({ ok: false });
    expect(applyRateAttestation(p, items(p, ["EUR", "USD"]), MGR, "m@x", NOW, "FEC-1001", RULES)).toMatchObject({ ok: false, errors: [expect.stringMatching(/USD: there is no forward-cover rate to attest/)] });
    expect(applyRateAttestation(p, [{ currency: "constructor", rateHash: "x" }, { currency: "__proto__", rateHash: "x" }], MGR, "m@x", NOW, "FEC-1001", RULES)).toMatchObject({ ok: false });
    expect(applyRateAttestation(undefined, [{ currency: "EUR", rateHash: "x" }], MGR, "m@x", NOW, "FEC-1001", RULES)).toMatchObject({ ok: false });
    const done = attested(p);
    expect(applyRateAttestation(done, items(done), MGR, "n@x", NOW, "again", RULES)).toMatchObject({ ok: false, errors: [expect.stringMatching(/already attested/)] });
  });
  it("a rate without its contract reference or validity dates cannot be attested", () => {
    for (const bad of [fc({ reference: undefined }), fc({ validFrom: undefined }), fc({ validUntil: undefined })]) {
      const p = withFc(bad);
      expect(applyRateAttestation(p, items(p), MGR, "m@x", NOW, "FEC-1001", RULES)).toMatchObject({ ok: false, errors: [expect.stringMatching(/EUR: record .* before the rate can be attested/)] });
    }
  });
  it("is bound to the rate the reviewer SAW: a rate that changed since is refused, never silently covered", () => {
    const p = withFc(); const seen = items(p);
    const moved = structuredClone(p); moved.forwardCover.EUR!.rateMicro += 1;
    expect(applyRateAttestation(moved, seen, MGR, "m@x", NOW, "FEC-1001", RULES)).toMatchObject({ ok: false, errors: [expect.stringMatching(/EUR: the rate changed after you opened it/)] });
    expect(applyRateAttestation(p, [{ currency: "EUR", rateHash: "0".repeat(64) }], MGR, "m@x", NOW, "FEC-1001", RULES)).toMatchObject({ ok: false });
    expect(applyRateAttestation(moved, items(moved), MGR, "m@x", NOW, "FEC-1001", RULES)).toMatchObject({ ok: true });
  });
  it("attesting changes NO price and not the pricing date; it bumps the revision and records who / when / evidence / which rate", () => {
    const p = withFc();
    const before = evalOf(withPricing(p)).budget!.totals.subtotalExTax;
    const r = applyRateAttestation(p, items(p), MGR, "mgr@example.test", NOW, " FEC-1001 confirmation ", RULES);
    if (!r.ok) throw new Error("setup");
    expect(r.next.pricingDate).toBe(p.pricingDate);
    expect(r.next.revision).toBe(p.revision + 1);
    expect(evalOf(withPricing(r.next)).budget!.totals.subtotalExTax).toBe(before);
    expect(r.next.forwardCover.EUR!.review).toEqual({ by: "mgr@example.test", at: NOW, evidence: "FEC-1001 confirmation", inputHash: hashOf(p) });
    expect(r.changes.map((c) => c.path).sort()).toEqual(["forwardCover.EUR.review.at", "forwardCover.EUR.review.by", "forwardCover.EUR.review.evidence", "forwardCover.EUR.review.inputHash"]);
    expect(p.forwardCover.EUR!.review).toBeUndefined(); // the prior is never mutated
  });
});

describe("a pricing save keeps an attestation only for an UNCHANGED rate", () => {
  const save = (p: EstimatorPricing, edit: (s: ReturnType<typeof submissionFrom>) => void, email: string) => {
    const s = structuredClone(submissionFrom(p)); edit(s);
    return applyPricingSubmission(p, s, { roles: roles("estimator"), canSeeCost: true }, email, "2026-11-12T11:00:00.000Z", "Change", "project");
  };
  it("an unchanged rate keeps its attestation and its original who/when, whatever the client sent", () => {
    const p = attested(withFc());
    const r = save(p, (s) => { s.projectMarkup = { markupBps: 2500, reason: "markup" }; (s.forwardCover.EUR as unknown as Record<string, unknown>).by = "forged@x"; }, "est2@example.test");
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.next!.forwardCover.EUR).toEqual(p.forwardCover.EUR);
  });
  it("ANY change to the rate, cover, contract, dates or reason drops the attestation and re-stamps who changed it", () => {
    const p = attested(withFc());
    for (const edit of [(f: StoredForwardCover) => { f.rateMicro += 1; }, (f: StoredForwardCover) => { f.coverDays = 60; }, (f: StoredForwardCover) => { f.reference = "FEC-2"; }, (f: StoredForwardCover) => { f.validUntil = "2026-12-30"; }, (f: StoredForwardCover) => { f.reason = "new reason"; }]) {
      const r = save(p, (s) => edit(s.forwardCover.EUR as StoredForwardCover), "est2@example.test");
      if (!r.ok) throw new Error(r.errors.join());
      expect(r.next!.forwardCover.EUR!.review).toBeUndefined();
      expect(r.next!.forwardCover.EUR!.by).toBe("est2@example.test");
    }
  });
  it("the form never submits a review: submissionFrom strips it and the strict shape ignores one a client adds", () => {
    const p = attested(withFc());
    const s = submissionFrom(p);
    expect(JSON.stringify(s)).not.toMatch(/review|FEC-1001 confirmation/);
    const forged = structuredClone(s) as unknown as Record<string, Record<string, Record<string, unknown>>>;
    forged.forwardCover.EUR.review = { by: "mgr@x", at: NOW, evidence: "forged", inputHash: "0".repeat(64) };
    const n = normaliseSubmission(forged, NOW);
    expect(n.ok && JSON.stringify(n.value)).not.toMatch(/review|forged/);
  });
});

describe("finality: a forward-cover rate that is not attested is indicative only", () => {
  const reasons = (p: EstimatorPricing, now = NOW) => { const d = withPricing(p); return pricingFinality(d.estimator.pricing, evalOf(d).budget, now); };
  const FC_USED = (p: EstimatorPricing) => ({ ...p, forwardCover: { EUR: fc(), USD: fc({ reference: "FEC-USD" }) } });
  it("final once every used forward-cover rate is attested by someone else; blocked, naming the currency only, until then", () => {
    const p = FC_USED(withFc());
    const r = reasons(p);
    expect(r.final).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/The EUR forward-cover rate: the forward-cover rate has not been independently attested/);
    expect(r.reasons.join(" ")).toMatch(/The USD forward-cover rate/);
    expect(r.reasons.every((x) => x.endsWith("This cannot be waived by the incomplete-costing exception."))).toBe(true);
    expect(r.reasons.join(" ")).not.toMatch(/19|FEC-|90 day/); // no rate, no contract detail
    let q = attested(p); q = { ...q, forwardCover: { ...q.forwardCover, USD: q.forwardCover.USD } };
    const both = applyRateAttestation(q, items(q, ["USD"]), MGR, "mgr@example.test", NOW, "FEC-USD confirmation", RULES);
    if (!both.ok) throw new Error(both.errors.join());
    expect(reasons(both.next)).toEqual({ final: true, reasons: [] });
  });
  it("a self-attested, outdated, or undocumented rate blocks; the incomplete-costing exception cannot waive any of it", () => {
    const p = withFc();
    const self = structuredClone(p); self.forwardCover.EUR!.review = { by: EST, at: AT, evidence: "mine", inputHash: hashOf(p) };
    expect(reasons({ ...self, forwardCover: { EUR: self.forwardCover.EUR, USD: fc() } }).reasons.join(" ")).toMatch(/EUR forward-cover rate: the forward-cover rate was attested by the person who entered it/);
    const out = attested(p); out.forwardCover.EUR!.rateMicro += 1;
    expect(reasons(out).reasons.join(" ")).toMatch(/EUR forward-cover rate: the forward-cover rate changed after it was attested/);
    const undoc = withFc(fc({ reference: undefined }));
    // (the Phase 1 model already refuses to PRICE a line on an undocumented forward-cover rate, so the quotation is incomplete before the finality gate is reached)
    expect(evalOf(withPricing(undoc)).budget!.incomplete).toBe(true);
    const d = withPricing(out); expect(d.estimator.costBasis?.incompleteAccepted).toBeDefined(); // the fixture draft HAS the exception accepted
    expect(reasons(out).final).toBe(false);
  });
  it("SPOT rates are unaffected: no attestation is needed, and they keep the freshness limit", () => {
    const p = equivalentInputs();
    expect(reasons(p, AT)).toEqual({ final: true, reasons: [] });
    expect(reasons(p, "2026-11-13T09:00:00.000Z").reasons.join(" ")).toMatch(/spot rate is older than 24 hours/);
    expect(reasons(p, "2026-11-13T09:00:00.000Z").reasons.join(" ")).not.toMatch(/attest/);
  });
  it("a forward-cover rate for a currency no priced SKU uses does not block", () => {
    const p = equivalentInputs({ forwardCover: { GBP: fc() } });
    expect(reasons(p, AT)).toEqual({ final: true, reasons: [] });
  });
});
