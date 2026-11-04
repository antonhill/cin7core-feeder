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
import { managerApprove } from "@/lib/newquip-quotes/quote-store";
import { rolesFor } from "@/newquip/quote/roles";
import { evaluationContext } from "@/lib/newquip-quotes/context";
import { LED_MAPPED_SKU, ledLibraryMapping } from "@/newquip/grower/__tests__/baseline-exception-fixture";

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
import { POC_MARKER } from "@/lib/newquip-quotes/poc-presentation";

const ORG = "e1aea782-d095-47ad-90fb-4fa65c9bf855";
const ctx = { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: false };
const base = applyDemoDefaults({ ...emptyDraft(), customerName: "Test Customer" }).draft;
// Every physical SKU of the quotation has a supplier cost, so COSTING is complete. The LED package is MAPPED in the library (it is a typed price, not a design choice, so no exception could
// cover it); only the two Estimator-priced-by-design systems (M75, penning) have no Cin7 SKU.
const costs = (() => {
  const lines = commercialLinesOf(evaluateDraft(base, ctx).budget!);
  const out: Record<string, unknown> = {};
  for (const l of effectiveScope(buildPhysicalScope(lines)).lines) out[l.sku] = { unitCostCents: 1000, source: "MANUAL_ESTIMATE", retrievedAt: "t", reason: "r", by: "e", at: "t" };
  out[LED_MAPPED_SKU] = { unitCostCents: 1000, source: "MANUAL_ESTIMATE", retrievedAt: "t", reason: "r", by: "e", at: "t" };
  return out;
})();
const draft = { ...base, estimator: { ...base.estimator, physicalCosts: costs } } as typeof base;
const total = Math.round(evaluateDraft(draft, { ...ctx, withholdCost: true }).budget!.totals.subtotalExTax * 100);
const ITEMS = ["flex_auger", "penning_package"];
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
  db.tables.newquip_package_mappings = [ledLibraryMapping(ORG)]; // M75 and penning stay unmapped by design (seedGoldenCatalogue's golden library is replaced)
  db.rows("newquip_quotes").push({ id: "q1", org_id: ORG, quote_ref: "NQ-Q-0009", revision: 3, customer_name: "Test Customer", site_name: "Farm", quote_type: "project", state: "ESTIMATOR_REVIEW", draft: structuredClone(draft), draft_hash: "h1",
    customer_confirmed_cents: total, customer_confirmed_by: "r", customer_confirmed_at: "t", handoff_by_email: "rep@a", created_by_email: "rep@a", estimator_signoff_hash: "h1", estimator_signoff_by_email: "est@a", estimator_signoff_at: "t",
    approved_by_email: null, approved_at: null, accepted_baseline: null, baseline_hash: null, contract_cents: null, project_id: null, created_at: "t", updated_at: "t" });
});


const REF = "pnzwjqjovxxdikxtfngq";
const on = () => { process.env.VERCEL_ENV = "preview"; process.env.NEWQUIP_POC_PRESENTATION = "true"; process.env.SUPABASE_URL = `https://${REF}.supabase.co`; process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${REF}.supabase.co`; };
const mark = () => { const q = quote(); q.draft.estimator.assumptions = `${POC_MARKER}: test`; };
import { afterEach } from "vitest";
afterEach(() => { delete process.env.NEWQUIP_POC_PRESENTATION; delete process.env.SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.VERCEL_ENV; });

describe("POC Presentation Mode records the Manager baseline exception automatically, for POC quotations only", () => {
  it("on a marked quotation the Manager's plain approval seals the exception for M75 and penning with the POC reason", async () => {
    on(); as(true); mark();
    const r = await grower.approveGrowerQuoteAction("q1");
    expect(r.ok, r.error).toBe(true);
    expect(quote().state).toBe("MANAGER_APPROVED_FINAL");
    const ex = quote().accepted_baseline.exceptions[0];
    expect(ex.unresolved.map((i: { itemKey: string }) => i.itemKey).sort()).toEqual(ITEMS.slice().sort());
    expect(ex.reason).toMatch(/^POC PRESENTATION/);
    expect(acts().some((x) => x.action === "newquip.baseline_exception_accepted")).toBe(true);
  });
  it("the mode off: approval is refused exactly as before and nothing is written", async () => {
    as(true); mark(); const before = snapshot();
    const r = await grower.approveGrowerQuoteAction("q1");
    expect(r.ok).toBe(false); expect(snapshot()).toBe(before);
  });
  it("the mode on but the quotation NOT marked (an ordinary quotation): refused as before", async () => {
    on(); as(true); const before = snapshot();
    const r = await grower.approveGrowerQuoteAction("q1");
    expect(r.ok).toBe(false); expect(snapshot()).toBe(before);
  });
});
