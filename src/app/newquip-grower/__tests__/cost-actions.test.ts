import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { emptyDraft } from "@/newquip/grower/draft";
import { applyDemoDefaults } from "@/newquip/grower/demo-defaults";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";
import type { ProductCostRead } from "@/cin7/latest-cost";

// The REAL cost actions over the in-memory database; only the session and the (read-only) Cin7 product read are replaced. The supplier-price logic, the currency
// conversion, the selection rules, the FX store and the approval freeze all run for real.
let db: FakeDb;
const reads = new Map<string, ProductCostRead | null>();
const readLog: string[] = [];
vi.mock("server-only", () => ({}));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: async () => ({}) }));
vi.mock("@/cin7/latest-cost", () => ({ fetchProductCostRead: async (_c: unknown, sku: string) => { readLog.push(sku); return reads.get(sku) ?? null; } })); // the real adapter and logic run over this fake READ
vi.mock("@/lib/newquip-quotes/context", async () => {
  const { createWorkbookPriceSource: src } = await import("@/newquip/grower/workbook-price-source");
  const { NEWQUIP_MASTER_POC_SNAPSHOT: snap } = await import("@/newquip/grower/snapshot");
  return { evaluationContext: (withholdCost: boolean) => ({ priceSource: src(snap), withholdCost }) };
});
import * as cost from "../cost-actions";
import * as grower from "../actions";
import { managerApprove } from "@/lib/newquip-quotes/quote-store";
import { rolesFor } from "@/newquip/quote/roles";
import { evaluationContext } from "@/lib/newquip-quotes/context";

const ORG = "org-nq";
const draft = applyDemoDefaults({ ...emptyDraft(), customerName: "Test Customer" }).draft;
const priceCtx = { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: true };
const total = Math.round(evaluateDraft(draft, priceCtx).budget!.totals.subtotalExTax * 100);
const as = (admin: boolean) => {
  vi.mocked(requireNewquipPocOrg).mockResolvedValue({ orgId: ORG } as never);
  vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: ORG, userId: "u1", email: "u@nq" } as never);
  vi.mocked(requireOrgAdmin).mockImplementation(async () => { if (!admin) throw new Error("not admin"); return undefined as never; });
};
const quote = () => db.rows("newquip_quotes")[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const acts = () => db.rows("activity_log") as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

type Sup = { id: string; name: string; cost: number | null; currency?: string; last?: string | null };
const product = (sku: string, sups: Sup[]): ProductCostRead => ({
  sku, name: sku, averageCost: 999, uom: "Item", suppliers: [],
  rawSuppliers: sups.map((s) => ({ SupplierID: s.id, SupplierName: s.name, Cost: s.cost, FixedCost: 12345, LastSupplied: s.last === undefined ? "2026-10-01T00:00:00" : s.last, ...(s.currency ? { Currency: s.currency } : {}) })),
});
const A = (cost: number | null = 850): Sup => ({ id: "sup-a", name: "Supplier A", cost, currency: "ZAR" });
const B = (cost: number | null = 45, currency = "USD"): Sup => ({ id: "sup-b", name: "Supplier B", cost, currency });
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

async function scopeSkus() { as(true); return (await cost.getQuoteCostEstimateAction("q1")).data!.estimate!.lines.map((l) => l.sku); }
/** Every scope SKU gets the same supplier list unless overridden. */
async function stock(sups: Sup[], override: Record<string, Sup[]> = {}) { for (const sku of await scopeSkus()) reads.set(sku, product(sku, override[sku] ?? sups)); }
const line = async (sku: string) => (await cost.getQuoteCostEstimateAction("q1")).data!.estimate!.lines.find((l) => l.sku === sku)!;
const view = async () => (await cost.getQuoteCostEstimateAction("q1")).data!;
const confirmUnits = () => cost.confirmUnitBasisAction("q1", "NewQuip confirmed supplier prices are per stock unit");

beforeEach(() => {
  db = new FakeDb(); db.fxApplied = true; reads.clear(); readLog.length = 0;
  db.rows("newquip_quotes").push({ id: "q1", org_id: ORG, quote_ref: "NQ-Q-0009", revision: 1, customer_name: "Test Customer", site_name: "Farm", quote_type: "project", state: "ESTIMATOR_REVIEW", draft: structuredClone(draft), draft_hash: "h1",
    customer_confirmed_cents: total, customer_confirmed_by: "r", customer_confirmed_at: "t", handoff_by_email: "rep@a", created_by_email: "rep@a", estimator_signoff_hash: "h1", estimator_signoff_by_email: "est@a", estimator_signoff_at: "t",
    approved_by_email: null, approved_at: null, accepted_baseline: null, baseline_hash: null, contract_cents: null, project_id: null, created_at: "t", updated_at: "t" });
  db.rows("suppliers").push({ org_id: ORG, name: "Supplier A", currency: "ZAR" }, { org_id: ORG, name: "Supplier B", currency: "USD" });
});

describe("cost actions are internal and server-enforced (role and organisation isolation)", () => {
  it("a member can use none of them", async () => {
    as(false);
    for (const r of [cost.getQuoteCostEstimateAction("q1"), cost.captureLatestCostsAction("q1"), cost.setManualCostEstimateAction("q1", "X", 100, "supplier quote"), cost.selectSupplierAction("q1", "X", { supplierId: "a", supplierName: "A" }, "why not"),
      cost.recordFxRateAction("USD", "17.5", "SARB", hoursAgo(1)), cost.confirmUnitBasisAction("q1", "they are per stock unit"), cost.acceptIncompleteCostsAction("q1", "a long enough reason"), cost.recalculateCostsAction("q1")]) {
      expect((await r).error).toMatch(/internal/i);
    }
    expect(readLog).toEqual([]);
    expect(db.rows("newquip_fx_rates")).toEqual([]);
  });
  it("another organisation's quotation is not found, and its rates are not read", async () => {
    as(true);
    vi.mocked(requireNewquipPocOrg).mockResolvedValue({ orgId: "org-other" } as never);
    vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: "org-other", userId: "u9", email: "x@y" } as never);
    expect((await cost.getQuoteCostEstimateAction("q1")).error).toMatch(/not found/i);
    expect((await cost.captureLatestCostsAction("q1")).error).toMatch(/not found/i);
  });
});

describe("the cost estimate follows UNSAVED edits as a read-only preview (UAT-003)", () => {
  const skusOf = async (unsaved?: typeof draft) => (await cost.getQuoteCostEstimateAction("q1", unsaved)).data!.estimate!.lines.map((l) => l.sku);
  const excluding = (key: string, reason = "") => ({ ...draft, config: { ...draft.config, exclusions: { [key]: reason } } }) as typeof draft;
  it("excluding an element drops its products from the estimate at once (no reason needed for the preview), and re-including brings them back; nothing is stored", async () => {
    as(true);
    const saved = await skusOf();
    const stored = JSON.stringify(quote());
    let shrank = false;
    for (const k of ["feed_saver_mat", "concrete_slat", "bulk_tank", "feeder", "cup_drinker", "led_light"]) {
      const without = await skusOf(excluding(k));
      expect(without.length).toBeLessThanOrEqual(saved.length);
      if (without.length < saved.length) { shrank = true; expect(without.every((x) => saved.includes(x))).toBe(true); }
    }
    expect(shrank).toBe(true);
    expect(await skusOf(draft)).toEqual(saved); // re-included: the original estimate exactly
    expect(JSON.stringify(quote())).toBe(stored);
  });
  it("an approved (final) quotation ignores any supplied draft: its frozen estimate is never recomputed", async () => {
    as(true);
    quote().state = "MANAGER_APPROVED_FINAL";
    const a = await cost.getQuoteCostEstimateAction("q1");
    const b = await cost.getQuoteCostEstimateAction("q1", excluding("feeder", "x"));
    expect(b).toEqual(a);
  });
  it("a member still cannot read it, with or without a draft", async () => {
    as(false);
    expect((await cost.getQuoteCostEstimateAction("q1", excluding("feeder", "x"))).error).toMatch(/internal/i);
  });
});

describe("Owner visibility on an editable draft quotation (regression: the Capture button was not visible)", () => {
  it("the Owner is a cost viewer, the cost read succeeds and offers capture, for a rep draft and for a quotation in estimator review", async () => {
    for (const state of ["REP_DRAFT", "ESTIMATOR_REVIEW"]) {
      quote().state = state; as(true);
      expect((await grower.getGrowerViewerAction()).data?.canViewCommercials).toBe(true);
      const r = await cost.getQuoteCostEstimateAction("q1");
      expect(r.error).toBeUndefined();
      expect(r.data).toMatchObject({ canCapture: true, frozen: false });
      expect(r.data!.estimate!.lines.length).toBeGreaterThan(0);
    }
  });
  it("an incomplete draft still returns a readable view rather than an error", async () => {
    quote().draft.config.lengthM = 0; quote().draft.config.widthM = 0; as(true);
    const r = await cost.getQuoteCostEstimateAction("q1");
    expect(r.error).toBeUndefined();
    expect(r.data!.canCapture).toBe(true);
  });
});

describe("capture: every supplier price, in ZAR, evaluated independently", () => {
  it("a single ZAR supplier is selected automatically once the unit basis is confirmed; FixedCost and AverageCost play no part", async () => {
    await stock([A(850)]); await confirmUnits();
    expect((await cost.captureLatestCostsAction("q1")).error).toBeUndefined();
    const sku = (await scopeSkus())[0];
    expect(await line(sku)).toMatchObject({ status: "LATEST", unitCostCents: 85_000, supplier: "Supplier A", basis: { currency: "ZAR", originalPriceMicro: 850_000_000, selectionMethod: "AUTO_SINGLE", fx: null } });
  });
  it("without a unit-of-measure confirmation the price is unusable and the reason is shown (no silent per-stock-unit assumption)", async () => {
    await stock([A(850)]);
    await cost.captureLatestCostsAction("q1");
    const sku = (await scopeSkus())[0];
    expect(await line(sku)).toMatchObject({ status: "MISSING", unitCostCents: null });
    expect((await view()).skuOptions[sku].options[0].problems[0].code).toBe("UOM_UNCONFIRMED");
    expect(await confirmUnits()).toMatchObject({ ok: true }); // confirming re-evaluates the captured options without another Cin7 read
    expect((await line(sku)).unitCostCents).toBe(85_000);
    expect((await cost.confirmUnitBasisAction("q1", "short")).error).toMatch(/short sentence/);
  });
  it("a USD supplier is converted with the recorded rate, keeping the original price, currency, rate, source and time", async () => {
    await stock([B(45)]); await confirmUnits();
    await cost.recordFxRateAction("USD", "17.5", "SARB fixing, entered by estimator", hoursAgo(2));
    await cost.captureLatestCostsAction("q1");
    const sku = (await scopeSkus())[0];
    const l = await line(sku);
    expect(l).toMatchObject({ status: "LATEST", unitCostCents: 78_750, supplier: "Supplier B", basis: { currency: "USD", originalPriceMicro: 45_000_000, fx: { rate: "17.5", source: "SARB fixing, entered by estimator" } } });
    expect(l.basis!.fx!.asOf).toBeTruthy();
  });
  it("a foreign price with NO rate, or a STALE rate, is never treated as rand", async () => {
    await stock([B(45)]); await confirmUnits();
    await cost.captureLatestCostsAction("q1");
    const sku = (await scopeSkus())[0];
    expect(await line(sku)).toMatchObject({ status: "MISSING", unitCostCents: null });
    expect((await view()).skuOptions[sku].options[0].problems[0].code).toBe("NO_RATE");
    await cost.recordFxRateAction("USD", "17.5", "old fixing", hoursAgo(24 * 5));
    await cost.recalculateCostsAction("q1");
    expect((await view()).skuOptions[sku].options[0].problems[0].code).toBe("STALE_RATE");
    expect((await line(sku)).unitCostCents).toBeNull();
    await cost.recordFxRateAction("USD", "17.6", "today's fixing", hoursAgo(1));
    await cost.recalculateCostsAction("q1");
    expect((await line(sku)).unitCostCents).toBe(79_200);
  });
  it("a supplier whose currency is unknown (not on the record, not in the supplier master) is unusable", async () => {
    await stock([{ id: "sup-x", name: "Mystery Ltd", cost: 100 }]); await confirmUnits();
    await cost.captureLatestCostsAction("q1");
    expect((await view()).skuOptions[(await scopeSkus())[0]].options[0].problems[0].code).toBe("NO_CURRENCY");
  });
  it("a missing price is MISSING, never zero, and does not fall back to FixedCost (12345) or AverageCost (999)", async () => {
    await stock([A(null)]); await confirmUnits();
    await cost.captureLatestCostsAction("q1");
    const l = await line((await scopeSkus())[0]);
    expect(l).toMatchObject({ status: "MISSING", unitCostCents: null, totalCostCents: null });
    expect((await view()).complete).toBe(false);
  });
  it("capture only READS Cin7 and never touches an approved quotation", async () => {
    await stock([A(850)]); await confirmUnits();
    quote().state = "MANAGER_APPROVED_FINAL";
    expect((await cost.captureLatestCostsAction("q1")).error).toMatch(/frozen|approved/i);
  });
});

describe("multiple suppliers: nothing is chosen for the estimator by date or by price", () => {
  it("ZAR and USD together: both kept, converted, and the estimator must choose; the cheaper USD supplier is NOT auto-selected", async () => {
    await stock([A(850), B(45)]); await confirmUnits();
    await cost.recordFxRateAction("USD", "17.5", "SARB fixing", hoursAgo(1));
    await cost.captureLatestCostsAction("q1");
    const sku = (await scopeSkus())[0];
    const v = await view();
    expect(v.skuOptions[sku].options.map((o) => [o.supplierName, o.currency, o.zarUnitCents])).toEqual([["Supplier A", "ZAR", 85_000], ["Supplier B", "USD", 78_750]]);
    expect(v.skuOptions[sku].selectionStatus).toBe("NEEDS_CHOICE");
    expect(await line(sku)).toMatchObject({ status: "MISSING", issue: "NEEDS_CHOICE", unitCostCents: null });
    expect(v.complete).toBe(false);
  });
  it("the estimator selects a supplier: the choice, the reason and who/when are recorded and audited; changing it needs a reason", async () => {
    await stock([A(850), B(45)]); await confirmUnits();
    await cost.recordFxRateAction("USD", "17.5", "SARB fixing", hoursAgo(1));
    await cost.captureLatestCostsAction("q1");
    const sku = (await scopeSkus())[0];
    expect((await cost.selectSupplierAction("q1", sku, { supplierId: "sup-b", supplierName: "Supplier B" })).error).toBeUndefined(); // first choice, none preferred
    expect(await line(sku)).toMatchObject({ status: "LATEST", unitCostCents: 78_750, supplier: "Supplier B", basis: { selectionMethod: "MANUAL_SELECTION", selectedBy: "u@nq" } });
    expect((await cost.selectSupplierAction("q1", sku, { supplierId: "sup-a", supplierName: "Supplier A" })).error).toMatch(/reason is required/);
    expect((await cost.selectSupplierAction("q1", sku, { supplierId: "sup-a", supplierName: "Supplier A" }, "Better lead time")).error).toBeUndefined();
    expect(await line(sku)).toMatchObject({ unitCostCents: 85_000, supplier: "Supplier A", basis: { selectionReason: "Better lead time" } });
    const rows = acts().filter((a) => a.action === "newquip.supplier_selected");
    expect(rows).toHaveLength(2);
    expect(rows[1].detail).toMatchObject({ sku, supplier: "Supplier A", reason: "Better lead time", previous: "Supplier B" });
    expect(rows[1].actor_email).toBe("u@nq");
  });
  it("only stored, currently usable options can be selected", async () => {
    await stock([A(850), B(null)]); await confirmUnits();
    await cost.captureLatestCostsAction("q1");
    const sku = (await scopeSkus())[0];
    expect(await line(sku)).toMatchObject({ status: "LATEST", supplier: "Supplier A", basis: { selectionMethod: "AUTO_SINGLE" } }); // B has no price: A is the only usable supplier
    expect((await cost.selectSupplierAction("q1", sku, { supplierId: "sup-b", supplierName: "Supplier B" }, "because")).error).toMatch(/cannot be used/);
    expect((await cost.selectSupplierAction("q1", sku, { supplierId: "sup-zzz", supplierName: "Forged Ltd" }, "because")).error).toMatch(/not one of the captured options/);
    expect((await cost.selectSupplierAction("q1", "NOT-A-SKU", { supplierId: "sup-a", supplierName: "Supplier A" })).error).toMatch(/no captured supplier prices/);
  });
  it("re-capture keeps a deliberate selection and manual estimates; only an explicit replace discards the selection", async () => {
    await stock([A(850), B(45)]); await confirmUnits();
    await cost.recordFxRateAction("USD", "17.5", "SARB fixing", hoursAgo(1));
    await cost.captureLatestCostsAction("q1");
    const [s0, s1] = await scopeSkus();
    await cost.selectSupplierAction("q1", s0, { supplierId: "sup-b", supplierName: "Supplier B" });
    await cost.setManualCostEstimateAction("q1", s1, 5_000, "Supplier quote 14 Oct");
    reads.set(s0, product(s0, [A(900), B(50)])); // prices moved
    await cost.captureLatestCostsAction("q1");
    expect(await line(s0)).toMatchObject({ supplier: "Supplier B", unitCostCents: 87_500, basis: { selectionMethod: "MANUAL_SELECTION" } }); // choice kept, refreshed price (50 x 17.5)
    expect(await line(s1)).toMatchObject({ status: "MANUAL", unitCostCents: 5_000 });
    await cost.captureLatestCostsAction("q1", { replaceSelections: true });
    expect((await view()).skuOptions[s0].selectionStatus).toBe("NEEDS_CHOICE");
  });
  it("capturing changes the content, so the estimator's sign-off is withdrawn", async () => {
    await stock([A(850)]); await confirmUnits();
    quote().estimator_signoff_hash = quote().draft_hash;
    await cost.captureLatestCostsAction("q1");
    expect(quote().estimator_signoff_hash).toBeNull();
  });
});

describe("exchange-rate snapshots", () => {
  it("are validated, append-only and audited; ZAR, bad codes, bad rates, missing sources and future times are refused", async () => {
    as(true);
    for (const [c, r, s, t, re] of [["ZAR", "1", "x source", hoursAgo(1), /base currency/], ["US", "17", "x source", hoursAgo(1), /three-letter/], ["USD", "abc", "x source", hoursAgo(1), /positive number/], ["USD", "0", "x source", hoursAgo(1), /positive number/], ["USD", "17.1234567", "x source", hoursAgo(1), /6 decimals/],
      ["USD", "17", "ab", hoursAgo(1), /where the rate comes from/], ["USD", "17", "x source", "garbage", /not valid/], ["USD", "17", "x source", new Date(Date.now() + 86_400_000).toISOString(), /future/]] as const) {
      expect((await cost.recordFxRateAction(c, r, s, t)).error).toMatch(re);
    }
    expect(db.rows("newquip_fx_rates")).toEqual([]);
    expect((await cost.recordFxRateAction("usd", "17.5", "SARB fixing", hoursAgo(1))).ok).toBe(true);
    expect(db.rows("newquip_fx_rates")).toHaveLength(1);
    expect(acts().some((a) => a.action === "newquip.fx_rate_recorded" && a.detail.currency === "USD" && a.actor_email === "u@nq")).toBe(true);
  });
  it("before migration 0113 the failure is explained and only ZAR prices can be used", async () => {
    db.fxApplied = false; as(true);
    expect((await cost.recordFxRateAction("USD", "17.5", "SARB fixing", hoursAgo(1))).error).toMatch(/migration pending/);
    const v = await view();
    expect(v.fxAvailable).toBe(false);
  });
});

describe("approval: an incomplete snapshot is refused unless an authorised exception is recorded; the approved basis is frozen", () => {
  const approve = () => managerApprove(db as never, ORG, rolesFor("admin"), "mgr@a", "q1", evaluationContext(true), evaluationContext(false));
  const signed = () => { quote().estimator_signoff_hash = quote().draft_hash; quote().estimator_signoff_by_email = "est@a"; };

  it("freezes the selected supplier, original price and currency, the rate and its source and time, the unit, the ZAR cost and total", async () => {
    await stock([A(850), B(45)]); await confirmUnits();
    await cost.recordFxRateAction("USD", "17.5", "SARB fixing", hoursAgo(1));
    await cost.captureLatestCostsAction("q1");
    for (const sku of await scopeSkus()) await cost.selectSupplierAction("q1", sku, { supplierId: "sup-b", supplierName: "Supplier B" });
    await cost.acceptIncompleteCostsAction("q1", "Demo quotation: three packages are not yet mapped to Cin7 SKUs");
    signed(); await approve();
    expect(quote().state).toBe("MANAGER_APPROVED_FINAL");
    const est = quote().accepted_baseline.physicalCostEstimate;
    expect(est.missingSkus).toEqual([]); // every mapped SKU has a selected supplier (the unmapped demo packages are covered by the recorded exception)
    const l = est.lines[0];
    expect(l).toMatchObject({ supplier: "Supplier B", unitCostCents: 78_750, basis: { currency: "USD", originalPriceMicro: 45_000_000, purchaseUnit: null, conversionFactor: 1, selectionMethod: "MANUAL_SELECTION", fx: { rate: "17.5", source: "SARB fixing" } } });
    expect(l.totalCostCents).toBe(Math.round(l.quantity * 78_750));
    expect(est.costBasis.unitBasis.basis).toBe("STOCK_UNIT");
  });
  it("later price or rate changes never alter the approved estimate", async () => {
    await stock([A(850)]); await confirmUnits(); await cost.captureLatestCostsAction("q1");
    await cost.acceptIncompleteCostsAction("q1", "Demo quotation: three packages are not yet mapped to Cin7 SKUs");
    signed(); await approve();
    const frozen = JSON.stringify(quote().accepted_baseline.physicalCostEstimate);
    for (const sku of await scopeSkus()) reads.set(sku, product(sku, [A(9999), B(1)]));
    await cost.recordFxRateAction("USD", "99", "wild fixing", hoursAgo(0.1));
    expect((await cost.captureLatestCostsAction("q1")).error).toMatch(/frozen|approved/i);
    expect((await cost.recalculateCostsAction("q1")).error).toMatch(/frozen|approved/i);
    expect((await cost.selectSupplierAction("q1", (await scopeSkus())[0], { supplierId: "sup-b", supplierName: "Supplier B" }, "change it")).error).toMatch(/frozen|approved|captured/i);
    expect(JSON.stringify(quote().accepted_baseline.physicalCostEstimate)).toBe(frozen);
    const v = await view();
    expect(v).toMatchObject({ frozen: true, canCapture: false });
  });
  it("refuses to approve while a captured estimate is incomplete (a supplier still to be chosen), naming the problem", async () => {
    await stock([A(850), B(45)]); await confirmUnits();
    await cost.recordFxRateAction("USD", "17.5", "SARB fixing", hoursAgo(1));
    await cost.captureLatestCostsAction("q1");
    signed();
    await expect(approve()).rejects.toThrow(/cost estimate is incomplete.*no supplier cost selected/);
    expect(quote().state).toBe("ESTIMATOR_REVIEW");
  });
  it("an authorised, reasoned exception allows the approval and is frozen with it", async () => {
    await stock([A(850), B(45)]); await confirmUnits();
    await cost.recordFxRateAction("USD", "17.5", "SARB fixing", hoursAgo(1));
    await cost.captureLatestCostsAction("q1");
    expect((await cost.acceptIncompleteCostsAction("q1", "short")).error).toMatch(/written reason/);
    expect((await cost.acceptIncompleteCostsAction("q1", "Supplier choice follows the customer's PO, agreed with the director")).ok).toBe(true);
    signed(); await approve();
    expect(quote().state).toBe("MANAGER_APPROVED_FINAL");
    expect(quote().accepted_baseline.physicalCostEstimate).toMatchObject({ incomplete: true, costBasis: { incompleteAccepted: { reason: expect.stringContaining("director"), by: "u@nq" } } });
  });
  it("a quotation whose costing was never started keeps the existing behaviour (approval is not blocked)", async () => {
    signed(); await approve();
    expect(quote().state).toBe("MANAGER_APPROVED_FINAL");
    expect(quote().accepted_baseline.physicalCostEstimate).toBeUndefined();
  });
});

describe("a saved draft can never forge a cost, a selection or a declaration", () => {
  it("whatever the browser sends, the stored costs and cost basis are kept", async () => {
    await stock([A(850)]); await confirmUnits(); await cost.captureLatestCostsAction("q1");
    const sku = (await scopeSkus())[0];
    const stored = JSON.stringify(quote().draft.estimator.physicalCosts);
    const forged = structuredClone(quote().draft) as typeof draft;
    forged.estimator.physicalCosts = { [sku]: { unitCostCents: 1, source: "CIN7_LATEST", retrievedAt: "2026-01-01T00:00:00Z" } };
    forged.estimator.costBasis = { incompleteAccepted: { reason: "forged exception", by: "evil", at: "t" } };
    vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: ORG, userId: "u1", email: "u@nq" } as never);
    const saved = await grower.saveGrowerDraftAction("q1", forged);
    expect(saved.error).toBeUndefined();
    expect(JSON.stringify(quote().draft.estimator.physicalCosts)).toBe(stored);
    expect(quote().draft.estimator.costBasis.incompleteAccepted).toBeUndefined();
    expect(quote().draft.estimator.costBasis.unitBasis).toBeTruthy();
  });
});
