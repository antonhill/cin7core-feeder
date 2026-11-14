import { describe, expect, it } from "vitest";
import { evaluateDraft } from "../../grower/evaluate";
import type { QuoteDraft } from "../../grower/draft";
import { readyDraft } from "../../grower/__tests__/golden";
import { testPriceSource } from "../../grower/__tests__/test-snapshot";
import { withCapturedSupplierCosts } from "./costing-fixture";
import { estimatorCostingComplete, estimatorOpenItems, repConfigurationReady } from "../readiness-concepts";
import { AMOUNT_CHANGED_AT_SIGNOFF, checkApproval, checkHandoff, checkSignOff, managerApprovalReady } from "../workflow";

// REP_CONFIGURATION_READY / ESTIMATOR_COSTING_COMPLETE / MANAGER_APPROVAL_READY: derived, never persisted. Every reason belongs to exactly one owner.

const wh = { priceSource: testPriceSource(), withholdCost: true };
const vis = { priceSource: testPriceSource(), withholdCost: false };
const noException = (d: QuoteDraft): QuoteDraft => { const c = structuredClone(d); delete c.estimator.costBasis; return c; };
const ev = (d: QuoteDraft) => evaluateDraft(d, wh);

describe("readiness is split by owner without changing state or reasons", () => {
  it("a complete draft has no reasons for anyone", () => {
    const r = ev(readyDraft()).readiness;
    expect(r.state).toBe("READY");
    expect(r).toMatchObject({ reasons: [], repReasons: [], estimatorReasons: [] });
  });
  it("an unmapped product / unconfirmed package is ESTIMATOR-owned: the Rep configuration is still ready, the full state is BLOCKED exactly as before", () => {
    const d = readyDraft(); d.estimator.confirmedMappings = {}; d.estimator.confirmedPackages = [];
    const r = ev(d).readiness;
    expect(r.state).toBe("BLOCKED");
    expect(r.repReasons).toEqual([]);
    expect(r.estimatorReasons.length).toBeGreaterThan(0);
    expect(r.reasons).toEqual(r.estimatorReasons);
    expect(repConfigurationReady(r)).toEqual({ ready: true, reasons: [] });
    expect(estimatorOpenItems(r).count).toBe(r.estimatorReasons.length);
  });
  it("customer, site, engineering validity, quantities, charges, the M75 price and override reasons are REP-owned", () => {
    const cases: Array<[string, (d: QuoteDraft) => void]> = [
      ["customer", (d) => { d.customerName = ""; }],
      ["site", (d) => { d.siteName = " "; }],
      ["engineering", (d) => { d.config.lengthM = 0; }],
      ["quantity", (d) => { d.config.estimatorQuantities = {}; }],
      ["charge", (d) => { d.estimator.charges = {}; }],
      ["m75 price", (d) => { d.estimator.unitPrices = {}; }],
    ];
    for (const [name, mutate] of cases) {
      const d = readyDraft(); mutate(d);
      const r = ev(d).readiness;
      expect(r.repReasons.length, name).toBeGreaterThan(0);
      expect(repConfigurationReady(r).ready, name).toBe(false);
      expect(r.state, name).not.toBe("READY");
    }
  });
  it("reasons is always the union of the two owners' reasons", () => {
    const d = readyDraft(); d.customerName = ""; d.estimator.confirmedMappings = {};
    const r = ev(d).readiness;
    expect([...r.repReasons, ...r.estimatorReasons].sort()).toEqual([...r.reasons].sort());
    expect(r.repReasons.some((x) => /Customer name/.test(x))).toBe(true);
    expect(r.estimatorReasons.length).toBeGreaterThan(0);
  });
});

describe("ESTIMATOR_COSTING_COMPLETE", () => {
  it("is false while supplier costs are not captured, naming it; true only with an authorised recorded exception", () => {
    const d = noException(readyDraft());
    const c = estimatorCostingComplete(d, evaluateDraft(d, vis));
    expect(c.complete).toBe(false);
    expect(c.reasons.join(" ")).toMatch(/cost/i);
    const accepted = readyDraft(); // carries the fixture's recorded incompleteAccepted exception
    // ROUND 4: still passes, but as its own state - the accepted exception is reported (who / when / why), so no screen has to call it 'complete'
    expect(estimatorCostingComplete(accepted, evaluateDraft(accepted, vis))).toEqual({ complete: true, reasons: [], acceptedIncomplete: expect.objectContaining({ reason: expect.any(String), by: expect.any(String), at: expect.any(String) }) });
  });
  it("Estimator-priced-by-design lines (M75, penning, manual price) are NOT missing costs: with every SKU costed it is complete without an exception", () => {
    const { draft } = withCapturedSupplierCosts(readyDraft(), vis);
    expect(draft.estimator.costBasis).toBeUndefined();
    expect(estimatorCostingComplete(draft, evaluateDraft(draft, vis))).toEqual({ complete: true, reasons: [] }); // genuinely complete: no acceptedIncomplete
  });
  it("a priced catalogue line or physical SKU with no cost still blocks", () => {
    const { draft, skus } = withCapturedSupplierCosts(readyDraft(), vis, ["PNQ082"]);
    expect(skus).toContain("PNQ082");
    const c = estimatorCostingComplete(draft, evaluateDraft(draft, vis));
    expect(c.complete).toBe(false);
    expect(c.reasons.join(" ")).toMatch(/PNQ082/);
  });
  it("the exception waives COSTS only, never an unresolved mapping", () => {
    const d = readyDraft(); d.estimator.confirmedMappings = {};
    const c = estimatorCostingComplete(d, evaluateDraft(d, vis));
    expect(c.complete).toBe(false);
    expect(c.reasons).toEqual(evaluateDraft(d, vis).readiness.estimatorReasons);
  });
  it("is false for an invalid configuration", () => {
    const d = noException(readyDraft()); d.config.lengthM = 0;
    expect(estimatorCostingComplete(d, evaluateDraft(d, vis)).complete).toBe(false);
  });
});

describe("handoff gates on the Rep configuration, sign-off and approval on the whole", () => {
  const base = ev(readyDraft()).readiness;
  const estBlocked = { ...base, state: "BLOCKED" as const, reasons: ["Feeder: product mapping not confirmed"], repReasons: [], estimatorReasons: ["Feeder: product mapping not confirmed"] };
  const repBlocked = { ...base, state: "BLOCKED" as const, reasons: ["Site / project name is required."], repReasons: ["Site / project name is required."], estimatorReasons: [] };
  const h = (readiness: typeof base, total: number | null = 100) => checkHandoff({ readiness, totalExVatCents: total, confirmedAmountCents: 100, confirmedBy: "Joe" });

  it("Estimator-owned items do NOT stop the handoff; a Rep-owned item still does, with an accurate message", () => {
    expect(h(estBlocked).ok).toBe(true);
    const r = h(repBlocked);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/Site \/ project name is required/);
  });
  it("still requires a positive amount, who confirmed it, and the confirmed amount to equal the CURRENT total", () => {
    expect(h(estBlocked, 0)).toMatchObject({ ok: false, error: expect.stringMatching(/No amount can be confirmed yet.*Estimator/) });
    expect(h(base, 0)).toMatchObject({ ok: false, error: expect.stringMatching(/no commercial amount/) });
    expect(h(estBlocked, null).ok).toBe(false);
    expect(checkHandoff({ readiness: estBlocked, totalExVatCents: 100, confirmedAmountCents: 100, confirmedBy: "  " }).ok).toBe(false);
    expect(checkHandoff({ readiness: estBlocked, totalExVatCents: 100, confirmedAmountCents: 99, confirmedBy: "Joe" }).ok).toBe(false);
  });
  const costed = { complete: true, reasons: [] as string[] };
  const uncosted = { complete: false, reasons: ["Project margin not available: 2 line(s) have no cost (M75)."] };
  it("sign-off needs the full READY, complete costing and an unchanged confirmed amount (the Estimator learns it here)", () => {
    const s = (o: Partial<Parameters<typeof checkSignOff>[0]> = {}) => checkSignOff({ readiness: base, totalExVatCents: 500, customerConfirmedCents: 500, costing: costed, ...o });
    expect(s().ok).toBe(true);
    expect(s({ readiness: estBlocked })).toMatchObject({ ok: false, error: expect.stringMatching(/BLOCKED/) });
    expect(s({ costing: uncosted })).toMatchObject({ ok: false, error: expect.stringMatching(/Costing is incomplete: Project margin not available/) });
    expect(s({ customerConfirmedCents: 400 })).toEqual({ ok: false, error: AMOUNT_CHANGED_AT_SIGNOFF });
    expect(AMOUNT_CHANGED_AT_SIGNOFF).toBe("The amount changed since the customer confirmed it. Return it to the Rep to reconfirm.");
    expect(s({ customerConfirmedCents: null }).ok).toBe(false);
    expect(s({ totalExVatCents: null }).ok).toBe(false);
  });
  it("approval (MANAGER_APPROVAL_READY) additionally needs complete costing", () => {
    const a = { readiness: base, totalExVatCents: 500, customerConfirmedCents: 500, signoffHash: "h", currentDraftHash: "h", costing: costed };
    expect(managerApprovalReady(a).ok).toBe(true);
    expect(checkApproval({ ...a, costing: uncosted })).toMatchObject({ ok: false, error: expect.stringMatching(/Costing is incomplete/) });
  });
});

describe("POC item register wording", () => {
  it("is neutral for a viewer without cost visibility and unchanged for one with it", async () => {
    const { pocItemRegisterFor } = await import("../../grower/open-items");
    expect(JSON.stringify(pocItemRegisterFor(false))).not.toMatch(/landed|\bROE\b|freight|20%/i);
    expect(JSON.stringify(pocItemRegisterFor(true))).toMatch(/landed/);
  });
});
