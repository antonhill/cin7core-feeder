import { describe, expect, it } from "vitest";
import snapshot from "../../../grower/snapshot/newquip-master-poc.snapshot.json";
import { createWorkbookPriceSource, type PriceSnapshot } from "../../../grower/workbook-price-source";
import { evaluateDraft } from "../../../grower/evaluate";
import { readyDraft } from "../../../grower/__tests__/golden";
import { testPriceSource } from "../../../grower/__tests__/test-snapshot";
import { hashOf } from "../../../quote/baseline";
import { snapshotOf } from "../../__tests__/helpers";
import { calculatePricing, DEFAULT_RULE_VERSION_ID, LEGACY_RULE_VERSION, micro, selectRuleVersion, type PricingScenario } from "..";
import { FIXTURE_DRAFT_RULE_VERSION } from "../fixtures";

const snap = snapshot as unknown as PriceSnapshot;
const legacy = createWorkbookPriceSource(snap);
const at = "2026-11-12T08:00:00.000Z";

// The legacy rule version must reproduce the POC engine EXACTLY, so that selecting nothing changes nothing and a later explicit selection starts from a proven baseline.
describe("the legacy rule version reproduces the existing POC price source, SKU for SKU, to the cent", () => {
  const entries = Object.values(snap.entries);
  it("covers the whole controlled snapshot", () => expect(entries.length).toBe(21));
  for (const e of entries) {
    it(`${e.sku}: project price and landed cost`, () => {
      const expected = legacy.priceFor(e.sku, "project");
      if (expected.status !== "priced") {
        // A zero-priced workbook row is "supplier quote required" in the POC. The model has no zero price either: a zero rate is invalid input and a missing cost is "not priced".
        expect(e.cost === 0 || e.roe === 0 || e.retailExVat === 0).toBe(true);
        return;
      }
      const s: PricingScenario = {
        pricingDate: at, forwardCover: {}, itemOverrides: {}, projectMarkup: null, projectAdjustment: null,
        fxQuotes: { EUR: { rateMicro: micro(e.roe), source: "workbook ROE", asOf: at } },
        lines: [{ key: e.sku, label: e.sku, sku: e.sku, quantity: 1, cost: { supplierId: null, supplierName: null, currency: "EUR", nativeUnitCostMicro: micro(e.cost), verification: "verified", source: "workbook" }, freight: { factorMicro: micro(e.freight), source: "workbook" } }],
      };
      const got = calculatePricing(s, LEGACY_RULE_VERSION).lines[0];
      expect(got.unitPriceCents).toBe(Math.round(expected.unitPriceExVat * 100));
      expect(got.unitLandedCostCents).toBe(Math.round(expected.landedCostExVat * 100));
    });
  }
});

describe("explicit selection: nothing changes until a new version is chosen", () => {
  it("the default is the legacy POC rules, at the existing 20% project markup", () => {
    expect(DEFAULT_RULE_VERSION_ID).toBe("legacy-poc-v1");
    const d = selectRuleVersion(undefined);
    expect(d).toEqual({ ok: true, rules: LEGACY_RULE_VERSION });
    expect(LEGACY_RULE_VERSION.markupBps).toBe(2000);
  });
  it("a draft/fixture version cannot be selected for a quotation (there is no option to allow it), and an unknown one is refused", () => {
    expect(selectRuleVersion(FIXTURE_DRAFT_RULE_VERSION.id)).toMatchObject({ ok: false });
    expect((selectRuleVersion as (id: string, o: object) => unknown)(FIXTURE_DRAFT_RULE_VERSION.id, { allowDraft: true })).toMatchObject({ ok: false }); // a stray option changes nothing
    expect(selectRuleVersion("made-up").ok).toBe(false);
    expect(selectRuleVersion("legacy-poc-v1").ok).toBe(true);
  });
});

describe("8. NQ-008A is untouched", () => {
  it("the existing engine's figures and the NQ-008A indicative snapshot are byte-identical to the NQ-008A candidate (67710c0)", () => {
    const ev = evaluateDraft(readyDraft({ quoteType: "project" }), { priceSource: testPriceSource(), withholdCost: false }).budget!;
    expect([ev.totals.subtotalExTax, ev.totals.estimatedCost]).toEqual([8609542.4, 3341952]);
    expect(hashOf(snapshotOf(readyDraft()).snapshot)).toBe(PINNED_SNAPSHOT_HASH);
  });
});

const PINNED_SNAPSHOT_HASH = "8514807e1c27ab0d998314fbab9649fc45056159c5b92564b04de522d903d58b";
