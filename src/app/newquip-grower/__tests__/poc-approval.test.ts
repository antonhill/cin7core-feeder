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

describe("POC Presentation Mode also covers a catalogue line with NO library mapping (the FORTIS LED), listed as UNVERIFIED", () => {
  const noLibrary = () => { db.tables.newquip_package_mappings = []; };
  it("a normal quotation with the LED unmapped is still refused (nothing written)", async () => {
    noLibrary(); as(true); const before = snapshot();
    const r = await grower.approveGrowerQuoteAction("q1");
    expect(r.ok).toBe(false); expect(snapshot()).toBe(before);
    on(); const r2 = await grower.approveGrowerQuoteAction("q1"); // mode on but NOT marked: still the normal rule
    expect(r2.ok).toBe(false); expect(snapshot()).toBe(before);
  });
  it("a marked POC quotation is approved: the exception lists the LED as unverified, the baseline keeps it UNMAPPED, the confirmed amount and sign-off are untouched", async () => {
    noLibrary(); on(); as(true); mark();
    const confirmed = quote().customer_confirmed_cents, signoff = quote().estimator_signoff_by_email;
    const r = await grower.approveGrowerQuoteAction("q1");
    expect(r.ok, r.error).toBe(true);
    expect(quote()).toMatchObject({ state: "MANAGER_APPROVED_FINAL", customer_confirmed_cents: confirmed, estimator_signoff_by_email: signoff });
    const ex = quote().accepted_baseline.exceptions[0];
    expect(ex.reason).toMatch(/^POC PRESENTATION/);
    const led = ex.unresolved.find((i: { label: string }) => /LED/i.test(i.label));
    expect(led).toBeTruthy(); expect(led.pricing).toMatch(/not verified/);
    expect(ex.unresolved.map((i: { itemKey: string }) => i.itemKey)).toEqual(expect.arrayContaining(ITEMS));
    // never represented as mapped: the sealed physical scope still has the LED lines UNMAPPED
    const scope = JSON.stringify(quote().accepted_baseline.physicalScope);
    expect(scope).toMatch(/UNMAPPED/);
  });
});

import { scopeFromSnapshot, effectiveScope as effScope } from "@/lib/projects/product-scope";
describe("POC Presentation Mode: project creation and the Cin7 Sale scope", () => {
  const projectScope = () => scopeFromSnapshot((db.rows("projects")[0] as Record<string, any>).baseline_snapshot); // eslint-disable-line @typescript-eslint/no-explicit-any
  it("the unverified lines are EXCLUDED from the Sale's physical lines with the POC reason; nothing blocks the Sale; mapped lines stay", async () => {
    db.tables.newquip_package_mappings = []; on(); as(true); mark();
    expect((await grower.approveGrowerQuoteAction("q1")).ok).toBe(true);
    const p = await grower.createProjectFromGrowerQuoteAction("q1");
    expect(p.ok, p.error).toBe(true);
    const items = projectScope(); const eff = effScope(items);
    expect(eff.blockers).toEqual([]); // the Sale scope is resolvable: nothing unmapped is left to block it
    expect(eff.excluded.length).toBeGreaterThan(0);
    expect(eff.excluded.every((x) => /^POC PRESENTATION/.test(x.reason))).toBe(true);
    expect(eff.excluded.some((x) => /LED/i.test(x.description))).toBe(true);
    expect(eff.lines.length).toBeGreaterThan(0); // the verified products still go on the Sale
    expect(eff.lines.map((l) => l.sku)).not.toEqual(expect.arrayContaining(["TEST-FORTIS-LED"]));
    expect(items.every((i) => i.mapping.status !== "UNMAPPED" || i.resolution?.kind === "EXCLUDE")).toBe(true);
    expect(quote().accepted_baseline.physicalScope.some((i: { mapping: { status: string }; resolution?: unknown }) => i.mapping.status === "UNMAPPED" && !i.resolution)).toBe(true); // the sealed baseline itself is NOT rewritten
  });
  it("a normal quotation's project keeps its unmapped items blocking (nothing is auto-excluded)", async () => {
    as(true);
    const ok = await grower.approveGrowerQuoteAction("q1", { baselineException: req() });
    expect(ok.ok, ok.error).toBe(true);
    const p = await grower.createProjectFromGrowerQuoteAction("q1"); expect(p.ok, p.error).toBe(true);
    expect(effScope(projectScope()).excluded.some((x) => /^POC PRESENTATION/.test(x.reason))).toBe(false);
  });
});
