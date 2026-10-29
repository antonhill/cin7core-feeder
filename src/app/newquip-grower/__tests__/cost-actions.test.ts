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

// The REAL cost actions over the in-memory database; only the session and the (read-only) Cin7 product read are replaced.
let db: FakeDb;
const reads = new Map<string, ProductCostRead | null>();
const readLog: string[] = [];
vi.mock("server-only", () => ({}));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: async () => ({}) }));
vi.mock("@/cin7/latest-cost", () => ({ fetchProductCostRead: async (_c: unknown, sku: string) => { readLog.push(sku); return reads.get(sku) ?? null; } })); // the real adapter and resolver run over this fake READ
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
const draft = applyDemoDefaults(emptyDraft()).draft;
const priceCtx = { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: true };
const total = Math.round(evaluateDraft(draft, priceCtx).budget!.totals.subtotalExTax * 100);
const as = (admin: boolean) => {
  vi.mocked(requireNewquipPocOrg).mockResolvedValue({ orgId: ORG } as never);
  vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: ORG, userId: "u1", email: "u@nq" } as never);
  vi.mocked(requireOrgAdmin).mockImplementation(async () => { if (!admin) throw new Error("not admin"); return undefined as never; });
};
const quote = () => db.rows("newquip_quotes")[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const supplier = (cost: number | null, last: string | null = "2026-10-01") => ({ supplier: "Acme", cost, fixedCost: null, lastSupplied: last });

beforeEach(() => {
  db = new FakeDb(); reads.clear(); readLog.length = 0;
  db.rows("newquip_quotes").push({ id: "q1", org_id: ORG, quote_ref: "NQ-Q-0009", revision: 1, customer_name: "Test Customer", site_name: "Farm", quote_type: "project", state: "ESTIMATOR_REVIEW", draft: structuredClone(draft), draft_hash: "h1",
    customer_confirmed_cents: total, customer_confirmed_by: "r", customer_confirmed_at: "t", handoff_by_email: "rep@a", created_by_email: "rep@a", estimator_signoff_hash: "h1", estimator_signoff_by_email: "est@a", estimator_signoff_at: "t",
    approved_by_email: null, approved_at: null, accepted_baseline: null, baseline_hash: null, contract_cents: null, project_id: null, created_at: "t", updated_at: "t" });
});

describe("cost actions are internal and server-enforced", () => {
  it("a member can neither read nor capture nor estimate costs", async () => {
    as(false);
    expect((await cost.getQuoteCostEstimateAction("q1")).error).toMatch(/internal/i);
    expect((await cost.captureLatestCostsAction("q1")).error).toMatch(/internal/i);
    expect((await cost.setManualCostEstimateAction("q1", "X", 100, "supplier quote")).error).toMatch(/internal/i);
    expect(readLog).toEqual([]);
  });
});

describe("capture, missing costs, manual estimates and the freeze", () => {
  async function firstSku() {
    as(true);
    const v = (await cost.getQuoteCostEstimateAction("q1")).data!;
    return v.estimate!.lines[0]?.sku;
  }
  it("reads the latest Cin7 cost for each physical SKU (read-only), records the source and time, and flags a SKU without one as MISSING", async () => {
    const sku = await firstSku();
    expect(sku).toBeTruthy();
    reads.set(sku!, { sku: sku!, name: "x", averageCost: 999, suppliers: [supplier(12.5, "2026-09-01"), supplier(20, "2026-10-20")] });
    const r = await cost.captureLatestCostsAction("q1");
    expect(r.ok).toBe(true);
    const v = (await cost.getQuoteCostEstimateAction("q1")).data!;
    const line = v.estimate!.lines.find((l) => l.sku === sku)!;
    expect(line).toMatchObject({ status: "LATEST", unitCostCents: 2000, source: "CIN7_LATEST", supplier: "Acme" }); // the newest supply wins, NOT the average cost (999)
    expect(line.retrievedAt).toBeTruthy();
    for (const l of v.estimate!.lines.filter((x) => x.sku !== sku)) expect(l.status).toBe("MISSING"); // not in the fake Cin7: no cost, and never zero
    expect(v.complete).toBe(false);
    expect(v.marginPct).toBeNull(); // an incomplete estimate has no margin
  });
  it("capture changes the content, so the estimator's sign-off is withdrawn", async () => {
    await firstSku();
    expect(quote().estimator_signoff_hash).toBe("h1");
    await cost.captureLatestCostsAction("q1");
    expect(quote().estimator_signoff_hash).toBeNull();
  });
  it("a manual estimate needs a reason, is labelled MANUAL with who and when, and survives a refresh from Cin7", async () => {
    const sku = (await firstSku())!;
    expect((await cost.setManualCostEstimateAction("q1", sku, 5000, "ok")).error).toMatch(/reason/);
    expect((await cost.setManualCostEstimateAction("q1", sku, 0, "Supplier quote 14 Oct")).error).toMatch(/greater than zero/);
    expect((await cost.setManualCostEstimateAction("q1", "NOT-A-SKU", 5000, "Supplier quote 14 Oct")).error).toMatch(/not a physical SKU/);
    expect((await cost.setManualCostEstimateAction("q1", sku, 5000, "Supplier quote 14 Oct")).ok).toBe(true);
    reads.set(sku, { sku, name: "x", averageCost: null, suppliers: [supplier(77)] });
    await cost.captureLatestCostsAction("q1");
    const line = (await cost.getQuoteCostEstimateAction("q1")).data!.estimate!.lines.find((l) => l.sku === sku)!;
    expect(line).toMatchObject({ status: "MANUAL", unitCostCents: 5000, reason: "Supplier quote 14 Oct" }); // Cin7's 77 did not overwrite the audited estimate
  });
  it("a saved draft can never forge a Cin7 cost: whatever the browser sends, the stored costs are kept", async () => {
    const sku = (await firstSku())!;
    reads.set(sku, { sku, name: "x", averageCost: null, suppliers: [supplier(10)] });
    await cost.captureLatestCostsAction("q1");
    const forged = structuredClone(quote().draft) as typeof draft;
    forged.estimator.physicalCosts = { [sku]: { unitCostCents: 1, source: "CIN7_LATEST", retrievedAt: "2026-01-01T00:00:00Z" } };
    // the browser-facing save action re-establishes the session and keeps the server-owned costs
    vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: ORG, userId: "u1", email: "u@nq" } as never);
    const saved = await grower.saveGrowerDraftAction("q1", forged);
    expect(saved.error).toBeUndefined();
    expect(saved.ok).toBe(true);
    expect(quote().draft.estimator.physicalCosts[sku].unitCostCents).toBe(1000);
  });
  it("approval freezes the estimate; later Cin7 cost changes and capture attempts cannot alter it", async () => {
    const lines = (await cost.getQuoteCostEstimateAction("q1")).data!.estimate!.lines;
    for (const l of lines) reads.set(l.sku, { sku: l.sku, name: "x", averageCost: null, suppliers: [supplier(10)] });
    await cost.captureLatestCostsAction("q1");
    // sign-off again on the new content, then approve through the store (as the approval action does)
    quote().estimator_signoff_hash = quote().draft_hash; quote().estimator_signoff_by_email = "est@a"; quote().estimator_signoff_at = "t";
    await managerApprove(db as never, ORG, rolesFor("admin"), "mgr@a", "q1", evaluationContext(true), evaluationContext(false));
    expect(quote().state).toBe("MANAGER_APPROVED_FINAL");
    const frozen = JSON.stringify(quote().accepted_baseline.physicalCostEstimate);
    expect(quote().accepted_baseline.physicalCostEstimate.lines.length).toBeGreaterThan(0);
    for (const l of lines) reads.set(l.sku, { sku: l.sku, name: "x", averageCost: null, suppliers: [supplier(9999)] });
    const again = await cost.captureLatestCostsAction("q1");
    expect(again.error).toMatch(/frozen|approved/i);
    expect(JSON.stringify(quote().accepted_baseline.physicalCostEstimate)).toBe(frozen);
    const view = (await cost.getQuoteCostEstimateAction("q1")).data!;
    expect(view.frozen).toBe(true);
    expect(view.canCapture).toBe(false);
  });
});
