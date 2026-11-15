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

// WORKSTREAM B: role authorisation of the costing mutations, through the REAL server actions. The REAL cost actions over the in-memory database; only the session and the (read-only) Cin7 product read are replaced. The supplier-price logic, the currency
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
import { ledLibraryMapping, managerExceptionOpts } from "@/newquip/grower/__tests__/baseline-exception-fixture";

const ORG = "org-nq";
const draft = applyDemoDefaults({ ...emptyDraft(), customerName: "Test Customer" }).draft;
const priceCtx = { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: true };
const total = Math.round(evaluateDraft(draft, priceCtx).budget!.totals.subtotalExTax * 100);
type Kind = "owner" | "mgr" | "est" | "both" | "rep" | "repmgr";
/** One signed-in session. `owner` is the organisation owner/admin tier (all three roles); the others are members with explicit functional-role assignments. */
const as = (kind: Kind) => {
  vi.mocked(requireNewquipPocOrg).mockResolvedValue({ orgId: ORG } as never);
  vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: ORG, userId: "u1", email: "u@nq" } as never);
  vi.mocked(requireOrgAdmin).mockImplementation(async () => { if (kind !== "owner") throw new Error("not admin"); return undefined as never; });
  db.rolesApplied = true; db.approvalsApplied = true; db.tables.org_functional_roles = [];
  const roles = { mgr: ["MANAGER"], est: ["ESTIMATOR"], both: ["ESTIMATOR", "MANAGER"], rep: ["REP"], repmgr: ["REP", "MANAGER"], owner: [] }[kind];
  for (const role of roles) db.rows("org_functional_roles").push({ id: `r-${role}`, org_id: ORG, user_id: "u1", user_email: "u@nq", role, assigned_by_email: "o@nq", assigned_at: "t" });
};
const quote = () => db.rows("newquip_quotes")[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const acts = () => db.rows("activity_log") as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

type Sup = { id: string; name: string; cost: number | null; currency?: string; last?: string | null; extra?: Record<string, unknown> };
const product = (sku: string, sups: Sup[]): ProductCostRead => ({
  sku, name: sku, averageCost: 999, uom: "Item", suppliers: [],
  rawSuppliers: sups.map((s) => ({ SupplierID: s.id, SupplierName: s.name, Cost: s.cost, FixedCost: 12345, LastSupplied: s.last === undefined ? "2026-10-01T00:00:00" : s.last, ...(s.currency ? { Currency: s.currency } : {}), ...(s.extra ?? {}) })),
});
const A = (cost: number | null = 850): Sup => ({ id: "sup-a", name: "Supplier A", cost, currency: "ZAR" });
const B = (cost: number | null = 45, currency = "USD"): Sup => ({ id: "sup-b", name: "Supplier B", cost, currency });
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

async function scopeSkus() { as("owner"); return (await cost.getQuoteCostEstimateAction("q1")).data!.estimate!.lines.map((l) => l.sku); }
/** Every scope SKU gets the same supplier list unless overridden. */
async function stock(sups: Sup[], override: Record<string, Sup[]> = {}) { for (const sku of await scopeSkus()) reads.set(sku, product(sku, override[sku] ?? sups)); }
const confirmUnits = () => cost.confirmUnitBasisAction("q1", "NewQuip confirmed supplier prices are per stock unit");


beforeEach(() => {
  db = new FakeDb(); db.fxApplied = true; reads.clear(); readLog.length = 0;
  db.rows("newquip_quotes").push({ id: "q1", org_id: ORG, quote_ref: "NQ-Q-0009", revision: 1, customer_name: "Test Customer", site_name: "Farm", quote_type: "project", state: "ESTIMATOR_REVIEW", draft: structuredClone(draft), draft_hash: "h1",
    customer_confirmed_cents: total, customer_confirmed_by: "r", customer_confirmed_at: "t", handoff_by_email: "rep@a", created_by_email: "rep@a", estimator_signoff_hash: null, estimator_signoff_by_email: null, estimator_signoff_at: null,
    approved_by_email: null, approved_at: null, accepted_baseline: null, baseline_hash: null, contract_cents: null, project_id: null, created_at: "t", updated_at: "t" });
  db.rows("suppliers").push({ org_id: ORG, name: "Supplier A", currency: "ZAR" }, { org_id: ORG, name: "Supplier B", currency: "USD" });
});

const DENIED = /Only an Estimator who can see costs can change the costing/;
const WAIVER = /Only a Manager who can see costs can accept an incomplete cost estimate/;
/** Everything a costing mutation could touch: the stored quote row, the shared FX table, the audit log, the activity feed and the Cin7 read log. */
const snap = () => JSON.stringify({ q: db.rows("newquip_quotes"), fx: db.rows("newquip_fx_rates"), act: db.rows("activity_log").length, reads: readLog.length });

/** A quotation with captured costs, a selection, a manual estimate and a unit basis, so every mutation has something real to change. */
async function seeded() {
  await stock([A(850), B(45)]); await confirmUnits();
  as("owner");
  await cost.recordFxRateAction("USD", "17.5", "SARB fixing", hoursAgo(1));
  await cost.captureLatestCostsAction("q1");
  const [s1, s2] = await scopeSkus();
  await cost.selectSupplierAction("q1", s1, { supplierId: "sup-b", supplierName: "Supplier B" });
  await cost.setManualCostEstimateAction("q1", s2, 12_345, "supplier quote on file");
  return { s1, s2 };
}
type Call = (s: { s1: string; s2: string }) => Promise<{ ok: boolean; error?: string }>;
const MUTATIONS: Array<[string, Call]> = [
  ["captureLatestCostsAction", () => cost.captureLatestCostsAction("q1", { replaceSelections: true })],
  ["selectSupplierAction", (s) => cost.selectSupplierAction("q1", s.s1, { supplierId: "sup-a", supplierName: "Supplier A" }, "a proper reason")],
  ["recalculateCostsAction", () => cost.recalculateCostsAction("q1")],
  ["confirmUnitBasisAction", () => cost.confirmUnitBasisAction("q1", "re-confirmed per stock unit by the estimator")],
  ["setManualCostEstimateAction", (s) => cost.setManualCostEstimateAction("q1", s.s2, 99_999, "a different supplier quote")],
  ["clearManualCostEstimateAction", (s) => cost.clearManualCostEstimateAction("q1", s.s2)],
  ["recordFxRateAction", () => cost.recordFxRateAction("USD", "19.9", "a shared org-wide rate", hoursAgo(0.5))],
];

describe("costing mutations need the ESTIMATOR role (and cost visibility)", () => {
  for (const [name, call] of MUTATIONS) {
    it(`${name}: a Manager-only session is refused and NOTHING is written`, async () => {
      const s = await seeded(); const before = snap();
      as("mgr");
      const r = await call(s);
      expect(r.ok).toBe(false); expect(r.error).toMatch(DENIED);
      expect(snap()).toBe(before);
    });
    it(`${name}: a Rep / cost-blind session is refused and NOTHING is written`, async () => {
      const s = await seeded(); const before = snap();
      as("rep");
      const r = await call(s);
      expect(r.ok).toBe(false); expect(r.error).toMatch(/internal/i);
      expect(snap()).toBe(before);
    });
    for (const kind of ["est", "both", "owner"] as const) {
      it(`${name}: ${kind} is allowed`, async () => {
        const s = await seeded(); const before = snap();
        as(kind);
        const r = await call(s);
        expect(r.error).toBeUndefined(); expect(r.ok).toBe(true);
        expect(snap()).not.toBe(before);
      });
    }
  }
  it("a Manager-only session can still READ the cost view (verification and approval need it)", async () => {
    await seeded(); as("mgr");
    expect((await cost.getQuoteCostEstimateAction("q1")).ok).toBe(true);
  });
  it("an organisation owner/admin who was explicitly assigned ONLY the Manager role holds no Estimator authority", async () => {
    const s = await seeded(); const before = snap();
    as("owner"); db.rows("org_functional_roles").push({ id: "r-m", org_id: ORG, user_id: "u1", user_email: "u@nq", role: "MANAGER", assigned_by_email: "o", assigned_at: "t" });
    const r = await cost.recalculateCostsAction("q1"); void s;
    expect(r.error).toMatch(DENIED); expect(snap()).toBe(before);
  });
});

describe("the incomplete-costing WAIVER is reserved to a Manager, with evidence and an audit row", () => {
  const REASON = "Supplier choice follows the customer's PO, agreed with the director";
  it("an Estimator-only session is refused and nothing is written", async () => {
    await seeded(); const before = snap();
    as("est");
    const r = await cost.acceptIncompleteCostsAction("q1", REASON);
    expect(r.ok).toBe(false); expect(r.error).toMatch(WAIVER);
    expect(snap()).toBe(before); expect(quote().draft.estimator.costBasis.incompleteAccepted).toBeUndefined();
  });
  it("a Rep / cost-blind session is refused", async () => {
    await seeded(); const before = snap(); as("rep");
    expect((await cost.acceptIncompleteCostsAction("q1", REASON)).error).toMatch(/internal/i);
    expect(snap()).toBe(before);
  });
  it("a Manager-only session may accept it; the reason, who and when are recorded on the draft and in the audit log", async () => {
    await seeded(); as("mgr");
    expect((await cost.acceptIncompleteCostsAction("q1", REASON)).ok).toBe(true);
    expect(quote().draft.estimator.costBasis.incompleteAccepted).toMatchObject({ reason: REASON, by: "u@nq", at: expect.any(String) });
    expect(acts().filter((x) => x.action === "newquip.incomplete_costs_accepted")).toHaveLength(1);
    expect(acts().find((x) => x.action === "newquip.incomplete_costs_accepted")).toMatchObject({ detail: { quoteId: "q1", reason: REASON }, actor_email: "u@nq" });
  });
  it("both roles and the owner may accept it", async () => {
    for (const kind of ["both", "owner"] as const) {
      await seeded(); as(kind);
      expect((await cost.acceptIncompleteCostsAction("q1", REASON)).ok).toBe(true);
      delete quote().draft.estimator.costBasis.incompleteAccepted;
    }
  });
  it("the audit row is NON-OPTIONAL: if its insert fails the acceptance fails closed, no waiver is stored", async () => {
    await seeded(); as("mgr");
    const before = JSON.stringify(quote());
    const realFrom = db.from.bind(db);
    const spy = vi.spyOn(db, "from").mockImplementation(((t: string) => {
      const b = realFrom(t as never) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      return t === "activity_log" ? { ...b, insert: async () => ({ data: null, error: { message: "audit down" } }) } : b;
    }) as never);
    const r = await cost.acceptIncompleteCostsAction("q1", REASON);
    spy.mockRestore();
    expect(r.ok).toBe(false); expect(r.error).toMatch(/audit record could not be written/);
    expect(JSON.stringify(quote())).toBe(before);
    expect(quote().draft.estimator.costBasis.incompleteAccepted).toBeUndefined();
  });
  it("evidence is required: a missing or short reason is refused even for a Manager, and nothing is written", async () => {
    await seeded(); const before = snap(); as("mgr");
    for (const bad of ["", "   ", "short", "123456789"]) expect((await cost.acceptIncompleteCostsAction("q1", bad)).error).toMatch(/written reason/);
    expect(snap()).toBe(before);
  });
  it("a Manager session cannot use the waiver path on an approved (frozen) quotation", async () => {
    await seeded(); as("mgr"); quote().state = "MANAGER_APPROVED_FINAL";
    expect((await cost.acceptIncompleteCostsAction("q1", REASON)).error).toMatch(/frozen|approved/i);
  });
  it("a waiver already stored (a legacy quotation) is NOT invalidated by an Estimator's later costing, and is still honoured by sign-off and approval", async () => {
    await stock([A(850), B(45)]); await confirmUnits();
    as("owner"); await cost.recordFxRateAction("USD", "17.5", "SARB fixing", hoursAgo(1)); await cost.captureLatestCostsAction("q1");
    quote().draft.estimator.costBasis = { ...quote().draft.estimator.costBasis, incompleteAccepted: { reason: "Legacy exception recorded before the role rule", by: "legacy@nq", at: "2026-10-01T00:00:00.000Z" } };
    as("est"); expect((await cost.recalculateCostsAction("q1")).ok).toBe(true);
    expect(quote().draft.estimator.costBasis.incompleteAccepted).toMatchObject({ by: "legacy@nq" });
    db.rows("newquip_package_mappings").push(ledLibraryMapping(ORG));
    quote().estimator_signoff_hash = quote().draft_hash; quote().estimator_signoff_by_email = "est@a";
    await managerApprove(db as never, ORG, rolesFor("admin"), "mgr@a", "q1", evaluationContext(true), evaluationContext(false), managerExceptionOpts(quote() as never));
    expect(quote().state).toBe("MANAGER_APPROVED_FINAL");
    expect(quote().accepted_baseline.physicalCostEstimate.costBasis.incompleteAccepted).toMatchObject({ by: "legacy@nq", reason: expect.stringContaining("Legacy") });
  });
});

describe("saveGrowerDraftAction: field-level ownership of the costing fields (a Manager who can also edit drafts, i.e. Rep + Manager, holds no Estimator authority)", () => {
  const save = (d: unknown) => grower.saveGrowerDraftAction("q1", d as never);
  const stored = () => structuredClone(quote().draft) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const refusal = /Only an Estimator can change the costing/;

  it("a Rep+Manager session resubmitting the whole draft UNCHANGED succeeds (cost fields included)", async () => {
    await seeded(); quote().draft.estimator.costOverrides = { x: { lineCostCents: 5000, reason: "supplier quote", by: "e@nq", at: "t" } };
    quote().draft.estimator.priceResolutions = { y: { unitPriceExVat: 10, reason: "agreed price", by: "e@nq", at: "t" } };
    as("repmgr");
    const r = await save(stored());
    expect(r.error).toBeUndefined(); expect(r.ok).toBe(true);
  });
  it("a PURE Manager session cannot save a draft at all (canEditDraft needs Rep or Estimator): refused, and a costing change is named first; nothing is written", async () => {
    await seeded(); const before = snap(); as("mgr");
    expect((await save(stored())).error).toMatch(/permission to edit/);
    const d = stored(); d.estimator.costOverrides = { x: { lineCostCents: 1, reason: "sneaky override", by: "m", at: "t" } };
    expect((await save(d)).error).toMatch(refusal);
    expect(snap()).toBe(before);
  });
  it("a Manager may still change a Rep-owned field in the same save", async () => {
    await seeded(); as("repmgr");
    const d = stored(); d.siteName = "Another Farm";
    expect((await save(d)).error).toBeUndefined();
  });
  const CHANGES: Array<[string, (d: ReturnType<typeof stored>) => void]> = [
    ["costOverrides (add)", (d) => { d.estimator.costOverrides = { x: { lineCostCents: 1, reason: "sneaky override", by: "m", at: "t" } }; }],
    ["priceResolutions (add)", (d) => { d.estimator.priceResolutions = { y: { unitPriceExVat: 1, reason: "sneaky price", by: "m", at: "t" } }; }],
  ];
  for (const [name, change] of CHANGES) {
    it(`Rep+Manager changing ${name} is refused, the WHOLE save is refused, nothing is written`, async () => {
      await seeded(); const before = snap(); as("repmgr");
      const d = stored(); d.siteName = "Another Farm"; change(d);
      const r = await save(d);
      expect(r.ok).toBe(false); expect(r.error).toMatch(refusal);
      expect(snap()).toBe(before);
    });
  }
  it("Rep+Manager submitting forged physicalCosts / a forged waiver: the save SUCCEEDS but the stored values (and no waiver) are untouched", async () => {
    await seeded(); as("repmgr");
    const costs = JSON.stringify(quote().draft.estimator.physicalCosts), basis = JSON.stringify(quote().draft.estimator.costBasis);
    const d = stored(); const k = Object.keys(d.estimator.physicalCosts)[0];
    d.estimator.physicalCosts[k] = { ...d.estimator.physicalCosts[k], unitCostCents: 1 };
    d.estimator.costBasis = { ...d.estimator.costBasis, incompleteAccepted: { reason: "forged", by: "m", at: "t" } };
    const r = await save(d);
    expect(r.error).toBeUndefined();
    expect(JSON.stringify(quote().draft.estimator.physicalCosts)).toBe(costs);
    expect(JSON.stringify(quote().draft.estimator.costBasis)).toBe(basis);
    expect(quote().draft.estimator.costBasis.incompleteAccepted).toBeUndefined();
  });
  it("a STALE draft copy (an Estimator changed the costs since) is accepted from Rep+Manager, stored costs untouched; a changed costOverride in the same save is still refused", async () => {
    await seeded(); as("repmgr");
    const stale = stored();
    as("est"); expect((await cost.recalculateCostsAction("q1")).ok).toBe(true);
    const k = Object.keys(quote().draft.estimator.physicalCosts)[0];
    quote().draft.estimator.physicalCosts[k] = { ...quote().draft.estimator.physicalCosts[k], unitCostCents: 424242 };
    quote().draft.estimator.costBasis = { ...quote().draft.estimator.costBasis, incompleteAccepted: { reason: "Estimator-side legacy value", by: "legacy@nq", at: "t" } };
    const costs = JSON.stringify(quote().draft.estimator.physicalCosts), basis = JSON.stringify(quote().draft.estimator.costBasis);
    as("repmgr");
    expect((await save(stale)).error).toBeUndefined();
    expect(JSON.stringify(quote().draft.estimator.physicalCosts)).toBe(costs);
    expect(JSON.stringify(quote().draft.estimator.costBasis)).toBe(basis);
    const before = snap();
    stale.estimator.costOverrides = { x: { lineCostCents: 1, reason: "sneaky override", by: "m", at: "t" } };
    expect((await save(stale)).error).toMatch(refusal);
    expect(snap()).toBe(before);
  });
  it("Rep+Manager REMOVING an existing override or price resolution is also refused", async () => {
    await seeded(); quote().draft.estimator.costOverrides = { x: { lineCostCents: 5000, reason: "supplier quote", by: "e@nq", at: "t" } };
    const before = snap(); as("repmgr");
    const d = stored(); delete d.estimator.costOverrides;
    expect((await save(d)).error).toMatch(refusal); expect(snap()).toBe(before);
  });
  it("an Estimator (and both roles) may change cost overrides and price resolutions", async () => {
    for (const kind of ["est", "both"] as const) {
      await seeded(); as(kind);
      const d = stored(); d.estimator.costOverrides = { x: { lineCostCents: 7000, reason: "estimator supplier quote" } };
      expect((await save(d)).error).toBeUndefined();
      expect(quote().draft.estimator.costOverrides.x).toMatchObject({ lineCostCents: 7000, by: "u@nq" });
    }
  });
  it("a Rep+Manager keeps MAPPING decisions: changing confirmedMappings is not refused by the costing rule", async () => {
    await seeded(); as("repmgr");
    const d = stored(); d.estimator.confirmedMappings = { ...(d.estimator.confirmedMappings ?? {}), pvc_door: { sku: "NO-SUCH-SKU", confirmedBy: "x", confirmedAt: "t" } };
    const r = await save(d);
    expect(r.error ?? "").not.toMatch(refusal); expect(r.error ?? "").not.toMatch(/Only an Estimator or Manager can map/);
  });
  it("a Rep-only session still cannot map a product", async () => {
    await seeded(); as("rep");
    const d = stored(); d.estimator.confirmedMappings = { pvc_door: { sku: "NO-SUCH-SKU", confirmedBy: "x", confirmedAt: "t" } };
    expect((await save(d)).error).toMatch(/Only an Estimator or Manager can map/);
  });
});

describe("a Manager still approves a quotation (separation of duties and the waiver gate unchanged)", () => {
  it("approval with a Manager-recorded waiver works end to end", async () => {
    await stock([A(850), B(45)]); await confirmUnits();
    as("owner"); await cost.recordFxRateAction("USD", "17.5", "SARB fixing", hoursAgo(1)); await cost.captureLatestCostsAction("q1");
    db.rows("newquip_package_mappings").push(ledLibraryMapping(ORG));
    as("mgr"); expect((await cost.acceptIncompleteCostsAction("q1", "Supplier choice follows the customer's PO, agreed")).ok).toBe(true);
    quote().estimator_signoff_hash = quote().draft_hash; quote().estimator_signoff_by_email = "est@a";
    await managerApprove(db as never, ORG, rolesFor("admin"), "mgr@a", "q1", evaluationContext(true), evaluationContext(false), managerExceptionOpts(quote() as never));
    expect(quote().state).toBe("MANAGER_APPROVED_FINAL");
  });
});
