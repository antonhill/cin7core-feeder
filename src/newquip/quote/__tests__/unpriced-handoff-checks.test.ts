import { describe, expect, it } from "vitest";
import { checkApproval, checkHandoff, checkSignOff, checkUnpricedHandoff, NO_CUSTOMER_PRICE_AT_SIGNOFF, AMOUNT_CHANGED_AT_SIGNOFF } from "../workflow";
import type { Readiness } from "../../grower/readiness";

// Pure rules for the initial Rep handoff that carries no customer price. Readiness is synthetic: only the owner-split reasons and the state matter to these checks.
const rd = (over: Partial<Pick<Readiness, "state" | "reasons" | "repReasons" | "estimatorReasons">> = {}): Readiness =>
  ({ state: "BLOCKED", reasons: ["Estimator product choice needed: Bulk feed tank"], repReasons: [], estimatorReasons: ["Estimator product choice needed: Bulk feed tank"], ...over }) as unknown as Readiness;
const ok = { readiness: rd(), totalExVatCents: 0, acknowledgedUnpriced: true, hasChargeableProduct: true };

describe("checkUnpricedHandoff", () => {
  it("allows a complete Rep configuration with an included product, Estimator-owned pricing left, and the acknowledgement (total 0 or unavailable)", () => {
    expect(checkUnpricedHandoff(ok)).toEqual({ ok: true });
    expect(checkUnpricedHandoff({ ...ok, totalExVatCents: null })).toEqual({ ok: true });
  });
  it("is refused without the acknowledgement", () => {
    expect(checkUnpricedHandoff({ ...ok, acknowledgedUnpriced: false })).toMatchObject({ ok: false, error: expect.stringMatching(/Acknowledge/) });
  });
  it("is refused while any Rep-owned reason remains (customer, site, configuration, missing charge)", () => {
    expect(checkUnpricedHandoff({ ...ok, readiness: rd({ repReasons: ["Delivery: enter the amount"] }) })).toMatchObject({ ok: false, error: expect.stringMatching(/Delivery/) });
  });
  it("is refused when no chargeable product is included, and when nothing is left for the Estimator", () => {
    expect(checkUnpricedHandoff({ ...ok, hasChargeableProduct: false })).toMatchObject({ ok: false, error: expect.stringMatching(/No chargeable product/) });
    expect(checkUnpricedHandoff({ ...ok, readiness: rd({ estimatorReasons: [], reasons: [], state: "READY" }) })).toMatchObject({ ok: false, error: expect.stringMatching(/no commercial amount/) });
  });
  it("is structurally unavailable once ANY positive indicative price exists (even with the acknowledgement)", () => {
    expect(checkUnpricedHandoff({ ...ok, totalExVatCents: 1 })).toMatchObject({ ok: false, error: expect.stringMatching(/indicative price exists/) });
    expect(checkUnpricedHandoff({ ...ok, totalExVatCents: 123_456_00 })).toMatchObject({ ok: false });
  });
});

describe("the existing confirmation controls are unchanged", () => {
  const h = { readiness: rd(), totalExVatCents: 10_000, confirmedAmountCents: 10_000, confirmedBy: "Joe" };
  it("checkHandoff still refuses a zero total (R0 is never a confirmable amount) and a mismatch, and accepts the matching amount", () => {
    expect(checkHandoff({ ...h, totalExVatCents: 0, confirmedAmountCents: 0 })).toMatchObject({ ok: false, error: expect.stringMatching(/No amount can be confirmed yet/) });
    expect(checkHandoff({ ...h, confirmedAmountCents: 9_999 })).toMatchObject({ ok: false, error: expect.stringMatching(/must equal/) });
    expect(checkHandoff(h)).toEqual({ ok: true });
  });
  const ready = rd({ state: "READY", reasons: [], estimatorReasons: [] });
  const costing = { complete: true, reasons: [] };
  it("sign-off: a NULL confirmation gets the explicit no-customer-price message; a different amount keeps the amount-changed message; zero value is refused", () => {
    expect(checkSignOff({ readiness: ready, totalExVatCents: 10_000, customerConfirmedCents: null, costing })).toEqual({ ok: false, error: NO_CUSTOMER_PRICE_AT_SIGNOFF });
    expect(NO_CUSTOMER_PRICE_AT_SIGNOFF).toBe("No customer price has been confirmed yet - return it to the Rep to confirm the calculated amount.");
    expect(checkSignOff({ readiness: ready, totalExVatCents: 10_000, customerConfirmedCents: 400, costing })).toEqual({ ok: false, error: AMOUNT_CHANGED_AT_SIGNOFF });
    expect(checkSignOff({ readiness: ready, totalExVatCents: 0, customerConfirmedCents: 0, costing })).toMatchObject({ ok: false });
    expect(checkSignOff({ readiness: ready, totalExVatCents: 10_000, customerConfirmedCents: 10_000, costing })).toEqual({ ok: true });
  });
  it("approval: zero total, null confirmation and unsigned content are each refused", () => {
    const a = { readiness: ready, totalExVatCents: 10_000, customerConfirmedCents: 10_000, signoffHash: "h", currentDraftHash: "h", costing };
    expect(checkApproval({ ...a, totalExVatCents: 0, customerConfirmedCents: 0 })).toMatchObject({ ok: false, error: expect.stringMatching(/no contract value/) });
    expect(checkApproval({ ...a, customerConfirmedCents: null })).toMatchObject({ ok: false, error: expect.stringMatching(/never recorded/) });
    expect(checkApproval({ ...a, signoffHash: null })).toMatchObject({ ok: false });
    expect(checkApproval(a)).toEqual({ ok: true });
  });
});
