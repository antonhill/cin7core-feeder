import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { installStaged } from "@/lib/approvals/__tests__/staged-emulator";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { emptyDraft } from "@/newquip/grower/draft";
import { applyDemoDefaults } from "@/newquip/grower/demo-defaults";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";
import { commercialLinesOf, baselineMatchesHash } from "@/newquip/quote/baseline";
import { buildPhysicalScope } from "@/newquip/quote/physical-scope";
import { effectiveScope } from "@/lib/projects/product-scope";
import { docHistory } from "@/lib/approvals/approval-store";

// UX-006 S3: the Manager's baseline exception, through the REAL action, quote store, approval store and baseline builder over the in-memory database. Only the session is replaced.
let db: FakeDb;
vi.mock("server-only", () => ({}));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/newquip/grower/context-unused", () => ({}));
vi.mock("@/lib/newquip-quotes/context", async () => {
  const { createWorkbookPriceSource: src } = await import("@/newquip/grower/workbook-price-source");
  const { NEWQUIP_MASTER_POC_SNAPSHOT: snap } = await import("@/newquip/grower/snapshot");
  return { evaluationContext: (withholdCost: boolean) => ({ priceSource: src(snap), withholdCost }) };
});
import * as grower from "../actions";

const ORG = "org-nq";
const ctx = { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: false };
const base = applyDemoDefaults({ ...emptyDraft(), customerName: "Test Customer" }).draft;
// Every physical SKU of the quotation has a supplier cost, so COSTING is complete; only the three Estimator-priced systems (M75, penning, LED) have no Cin7 SKU.
const costs = (() => {
  const lines = commercialLinesOf(evaluateDraft(base, ctx).budget!);
  const out: Record<string, unknown> = {};
  for (const l of effectiveScope(buildPhysicalScope(lines)).lines) out[l.sku] = { unitCostCents: 1000, source: "MANUAL_ESTIMATE", retrievedAt: "t", reason: "r", by: "e", at: "t" };
  return out;
})();
const draft = { ...base, estimator: { ...base.estimator, physicalCosts: costs } } as typeof base;
const total = Math.round(evaluateDraft(draft, { ...ctx, withholdCost: true }).budget!.totals.subtotalExTax * 100);
const ITEMS = ["flex_auger", "led_light", "penning_package"];
const REASON = "Penning, M75 and LED are Estimator-priced by design; the library mapping follows the customer PO";

const as = (admin: boolean, userId = "u1") => {
  vi.mocked(requireNewquipPocOrg).mockResolvedValue({ orgId: ORG } as never);
  vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: ORG, userId, email: `${userId}@nq` } as never);
  vi.mocked(requireOrgAdmin).mockImplementation(async () => { if (!admin) throw new Error("not admin"); return undefined as never; });
};
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const quote = () => db.rows("newquip_quotes")[0] as Row;
const acts = () => db.rows("activity_log") as Row[];
// A read creates an empty table in the fake; only rows count. Every refusal must leave all rows byte-identical AND record no write.
const snapshot = () => JSON.stringify(Object.fromEntries(Object.entries(db.tables).filter(([, rows]) => rows.length > 0)));
const req = (over: Partial<{ reason: string; expectedRevision: number; expectedDraftHash: string }> = {}) => ({ reason: REASON, expectedRevision: quote().revision, expectedDraftHash: quote().draft_hash, ...over });

beforeEach(() => {
  db = new FakeDb(); db.fxApplied = true;
  seedGoldenCatalogue(db as never, ORG);
  db.rows("newquip_quotes").push({ id: "q1", org_id: ORG, quote_ref: "NQ-Q-0009", revision: 3, customer_name: "Test Customer", site_name: "Farm", quote_type: "project", state: "ESTIMATOR_REVIEW", draft: structuredClone(draft), draft_hash: "h1",
    customer_confirmed_cents: total, customer_confirmed_by: "r", customer_confirmed_at: "t", handoff_by_email: "rep@a", created_by_email: "rep@a", estimator_signoff_hash: "h1", estimator_signoff_by_email: "est@a", estimator_signoff_at: "t",
    approved_by_email: null, approved_at: null, accepted_baseline: null, baseline_hash: null, contract_cents: null, project_id: null, created_at: "t", updated_at: "t" });
});

describe("the freeze rule is NOT weakened", () => {
  it("without an exception, approval still fails closed with the existing message and writes nothing", async () => {
    as(true);
    const before = snapshot();
    const r = await grower.approveGrowerQuoteAction("q1");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/3 package\(s\) are not mapped to Cin7 SKUs/);
    expect(quote().state).toBe("ESTIMATOR_REVIEW");
    expect(snapshot()).toBe(before);
  });
  it("the Manager workspace is told an exception is required, with the three Estimator-priced systems", async () => {
    as(true);
    const v = (await grower.getGrowerQuoteAction("q1")).data!;
    expect(v.baselineException?.baselineExceptionRequired).toBe(true);
    expect(v.baselineException?.items.map((i) => i.itemKey).sort()).toEqual(ITEMS);
    expect(v.baselineException?.items.find((i) => i.itemKey === "penning_package")).toMatchObject({ label: expect.stringContaining("penning"), pricedBy: "penning_rate" });
    expect(v.baselineException?.otherBlockers).toEqual([]);
  });
  it("a Rep/member never receives it", async () => {
    as(false);
    expect((await grower.getGrowerQuoteAction("q1")).data!.baselineException).toBeUndefined();
  });
});

describe("a Manager's recorded exception", () => {
  it("approves, and is sealed in the baseline with items, reason, approver, time and quotation version", async () => {
    as(true);
    const r = await grower.approveGrowerQuoteAction("q1", { baselineException: req() });
    expect(r.error).toBeUndefined();
    expect(quote().state).toBe("MANAGER_APPROVED_FINAL");
    const ex = quote().accepted_baseline.exceptions;
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({ kind: "ESTIMATOR_PRICED_WITHOUT_CIN7_SKU", reason: REASON, approvedBy: "u1@nq", version: { quoteRef: "NQ-Q-0009", revision: 3, draftHash: "h1" } });
    expect(new Date(ex[0].approvedAt).toISOString()).toBe(ex[0].approvedAt);
    expect(ex[0].unresolved.map((i: Row) => i.itemKey).sort()).toEqual(ITEMS);
    expect(ex[0].unresolved.every((i: Row) => i.label && i.pricedBy && i.pricing)).toBe(true);
    expect(baselineMatchesHash(quote().accepted_baseline, quote().baseline_hash)).toBe(true);
    // The cost estimate stays honest: it is still incomplete, it is simply accepted.
    expect(quote().accepted_baseline.physicalCostEstimate.incomplete).toBe(true);
  });
  it("is in the audit log (who, version, items, reason)", async () => {
    as(true);
    await grower.approveGrowerQuoteAction("q1", { baselineException: req() });
    const a = acts().find((x) => x.action === "newquip.baseline_exception_accepted")!;
    expect(a).toBeTruthy();
    expect(a.detail).toMatchObject({ quoteId: "q1", revision: 3, draftHash: "h1", reason: REASON, approvedBy: "u1@nq" });
    expect(a.detail.unresolved.map((i: Row) => i.itemKey).sort()).toEqual(ITEMS);
    expect(acts().some((x) => x.action === "newquip.quote_manager_approved")).toBe(true);
    expect(acts().find((x) => x.action === "newquip.quote_manager_approved")!.detail.baselineException).toMatchObject({ reason: REASON });
  });
  it("appears in the frozen quote view (nothing hides it)", async () => {
    as(true);
    await grower.approveGrowerQuoteAction("q1", { baselineException: req() });
    const v = (await grower.getGrowerQuoteAction("q1")).data!;
    expect(v.quote.accepted_baseline?.exceptions?.[0].reason).toBe(REASON);
    expect(v.baselineException).toBeUndefined(); // no longer pending
  });
  it("needs a written reason", async () => {
    as(true);
    const before = snapshot();
    expect((await grower.approveGrowerQuoteAction("q1", { baselineException: req({ reason: "short" }) })).error).toMatch(/written reason/);
    expect(snapshot()).toBe(before);
  });
});

describe("authority: Manager only, and a refusal changes nothing", () => {
  it("a plain member (Rep/Estimator) is refused with byte-identical tables and no write", async () => {
    as(false);
    const before = snapshot(); const writes = db.writes.length;
    const r = await grower.approveGrowerQuoteAction("q1", { baselineException: req() });
    expect(r.error).toMatch(/Only a Manager/);
    expect(snapshot()).toBe(before);
    expect(db.writes.length).toBe(writes);
  });
  it("an administrator-tier user whose functional roles do not include Manager is refused the same way", async () => {
    as(true, "u-est");
    db.rolesApplied = true; db.approvalsApplied = true; installStaged(db);
    db.rows("org_functional_roles").push({ id: "r1", org_id: ORG, user_id: "u-est", user_email: "u-est@nq", role: "ESTIMATOR", assigned_by_email: "x", assigned_at: "t" });
    const before = snapshot(); const writes = db.writes.length;
    const r = await grower.approveGrowerQuoteAction("q1", { baselineException: req() });
    expect(r.ok).toBe(false);
    expect(snapshot()).toBe(before);
    expect(db.writes.length).toBe(writes);
  });
});

describe("the exception is bound to the exact quotation version", () => {
  it("a different draft hash or revision refuses the approval and writes nothing", async () => {
    as(true);
    const before = snapshot();
    expect((await grower.approveGrowerQuoteAction("q1", { baselineException: req({ expectedDraftHash: "old-hash" }) })).error).toMatch(/changed after the exception was reviewed/);
    expect((await grower.approveGrowerQuoteAction("q1", { baselineException: req({ expectedRevision: 2 }) })).error).toMatch(/changed after the exception was reviewed/);
    expect(snapshot()).toBe(before);
  });
  it("an edit after the exception was reviewed (new content, sign-off given again) needs the exception accepted again", async () => {
    as(true);
    const seen = req();
    quote().draft_hash = "h2"; quote().estimator_signoff_hash = "h2"; // the quotation was edited and re-signed after the Manager reviewed it
    const before = snapshot();
    expect((await grower.approveGrowerQuoteAction("q1", { baselineException: seen })).error).toMatch(/changed after the exception was reviewed/);
    expect(snapshot()).toBe(before);
    expect((await grower.approveGrowerQuoteAction("q1", { baselineException: req() })).error).toBeUndefined();
    expect(quote().accepted_baseline.exceptions[0].version.draftHash).toBe("h2");
  });
});

describe("it waives ONLY the listed Estimator-priced systems", () => {
  it("refused when no exception applies (the Estimator already recorded the cost exception)", async () => {
    as(true);
    quote().draft.estimator.costBasis = { incompleteAccepted: { reason: "cost exception", by: "est@a", at: "t" } };
    const before = snapshot();
    expect((await grower.approveGrowerQuoteAction("q1", { baselineException: req() })).error).toMatch(/No baseline exception applies/);
    expect(snapshot()).toBe(before);
  });
  it("does not replace the Estimator cost exception: it still works unchanged on its own", async () => {
    as(true);
    quote().draft.estimator.costBasis = { incompleteAccepted: { reason: "cost exception", by: "est@a", at: "t" } };
    expect((await grower.approveGrowerQuoteAction("q1")).error).toBeUndefined();
    expect(quote().accepted_baseline.exceptions).toBeUndefined();
  });
  it("does not waive a missing supplier cost, even with an exception", async () => {
    as(true);
    const sku = Object.keys(costs)[0];
    delete quote().draft.estimator.physicalCosts[sku];
    const v = (await grower.getGrowerQuoteAction("q1")).data!;
    expect(v.baselineException?.baselineExceptionRequired).toBe(false);
    expect(v.baselineException?.otherBlockers.join(" ")).toMatch(/no supplier cost/);
    const before = snapshot();
    const r = await grower.approveGrowerQuoteAction("q1", { baselineException: req() });
    expect(r.ok).toBe(false);
    expect(snapshot()).toBe(before);
  });
});

describe("approval history (staged approvals) carries the exception", () => {
  it("the Manager decision event names the exception, its items and the reason", async () => {
    as(true, "u-mgr");
    db.rolesApplied = true; db.approvalsApplied = true; installStaged(db);
    (db as any).auth = { admin: { getUserById: async (id: string) => ({ data: { user: { email: `${id}@nq` } } }) } }; // eslint-disable-line @typescript-eslint/no-explicit-any
    db.rows("org_members").push({ org_id: ORG, user_id: "u-mgr", role: "admin" });
    db.rows("org_functional_roles").push({ id: "r1", org_id: ORG, user_id: "u-mgr", user_email: "u-mgr@nq", role: "MANAGER", assigned_by_email: "x", assigned_at: "t" });
    const r = await grower.approveGrowerQuoteAction("q1", { baselineException: req() });
    expect(r.error).toBeUndefined();
    expect(quote().state).toBe("MANAGER_APPROVED_FINAL");
    const ev = await docHistory(db as never, ORG, "QUOTE", "q1");
    const decided = ev.find((e) => /approve/i.test(String(e.action)) && e.reason);
    expect(decided?.reason).toMatch(/Accepted incomplete: Estimator-priced systems without Cin7 SKU mapping/);
    expect(decided?.reason).toContain("penning_package");
    expect(decided?.reason).toContain(REASON);
  });
});
