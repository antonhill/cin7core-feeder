import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { emptyDraft } from "@/newquip/grower/draft";
import { applyDemoDefaults } from "@/newquip/grower/demo-defaults";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";
import { commercialLinesOf } from "@/newquip/quote/baseline";
import { buildPhysicalScope } from "@/newquip/quote/physical-scope";
import { effectiveScope } from "@/lib/projects/product-scope";
import { rolesFor } from "@/newquip/quote/roles";
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
import { POC_MARKER, isPocQuote, hasPocFlag, approvedInPocMode, POC_BASELINE_REASON } from "@/lib/newquip-quotes/poc-presentation";
import { hashOf } from "@/newquip/quote/baseline";
import { saveDraft, createQuote } from "@/lib/newquip-quotes/quote-store";

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
const mark = () => { quote().draft.estimator.pocPresentation = true; }; // the SERVER flag, set directly in storage (only createGrowerQuoteAction sets it in production)
const spoof = () => { quote().draft.estimator.assumptions = `${POC_MARKER}: typed by a Rep`; }; // free text only: must have NO effect
import { afterEach } from "vitest";
afterEach(() => { delete process.env.NEWQUIP_POC_PRESENTATION; delete process.env.SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.VERCEL_ENV; });


const noLibrary = () => { db.tables.newquip_package_mappings = []; };
const pocAudit = () => acts().filter((x) => x.action === "newquip.baseline_exception_accepted");
import { scopeFromSnapshot } from "@/lib/projects/product-scope";
const projectScope = () => scopeFromSnapshot((db.rows("projects")[0] as Row).baseline_snapshot);
const forged = (over: Record<string, unknown> = {}) => { const d = structuredClone(quote().draft); Object.assign(d.estimator, over); return d; };

describe("the free-text 'POC PRESENTATION' assumptions marker has NO effect (Rep-owned text can never activate a bypass)", () => {
  it("mode ON, typed marker only: the Manager's plain approval is refused, no auto exception, nothing written (also with an unmapped catalogue product)", async () => {
    on(); as(true); spoof();
    for (const lib of [false, true]) {
      if (lib) noLibrary();
      const before = snapshot();
      const r = await grower.approveGrowerQuoteAction("q1");
      expect(r.ok).toBe(false); expect(snapshot()).toBe(before);
      expect(pocAudit()).toHaveLength(0); expect(quote().accepted_baseline).toBeNull();
    }
  });
  it("a Rep/Estimator typing the marker through saveGrowerDraftAction, then the Manager approving: still no special treatment", async () => {
    on(); as(false, "u-est");
    const d = forged({ assumptions: `${POC_MARKER}: demo please` });
    const s = await grower.saveGrowerDraftAction("q1", d);
    expect(s.ok, s.error).toBe(true);
    expect(quote().draft.estimator.assumptions).toMatch(/^POC PRESENTATION/);
    expect(hasPocFlag(quote().draft)).toBe(false);
    as(true);
    // the save returned the quotation to review state as needed; approval must still be the NORMAL refusal
    const before = snapshot();
    const r = await grower.approveGrowerQuoteAction("q1");
    expect(r.ok).toBe(false); expect(snapshot()).toBe(before); expect(pocAudit()).toHaveLength(0);
  });
  it("createGrowerQuoteAction with the marker typed (mode OFF, then ON-but-not-created-by-the-mode paths): no flag is stored", async () => {
    as(false, "u-rep");
    const typed = { ...structuredClone(draft), estimator: { ...structuredClone(draft.estimator), assumptions: `${POC_MARKER}: typed` } } as typeof draft;
    const r = await grower.createGrowerQuoteAction(typed);
    expect(r.ok, r.error).toBe(true);
    const row = db.rows("newquip_quotes").find((x) => x.id === r.data!.id) as Row;
    expect(row.draft.estimator.assumptions).toMatch(/^POC PRESENTATION/); expect(hasPocFlag(row.draft)).toBe(false);
    on(); expect(isPocQuote(row.draft, ORG)).toBe(false); // mode on afterwards: still not POC
  });
  it("mode ON, project creation from a normally approved quotation whose assumptions carry the marker: no scope exclusion", async () => {
    on(); as(true); spoof();
    const ok = await grower.approveGrowerQuoteAction("q1", { baselineException: req() });
    expect(ok.ok, ok.error).toBe(true);
    expect(quote().accepted_baseline.pocPresentation).toBe(false);
    const p = await grower.createProjectFromGrowerQuoteAction("q1"); expect(p.ok, p.error).toBe(true);
    expect(effectiveScope(projectScope()).excluded.some((x) => /POC PRESENTATION/.test(x.reason))).toBe(false);
  });
  it("the customer document wording is unchanged for a marker-only quotation (isPocQuote false), changed only for the server flag while the mode is on", () => {
    const env = { VERCEL_ENV: "preview", NEWQUIP_POC_PRESENTATION: "true", SUPABASE_URL: `https://${REF}.supabase.co`, NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co` };
    const typed = { estimator: { assumptions: `${POC_MARKER}: x` } } as never, flagged = { estimator: { assumptions: "", pocPresentation: true } } as never;
    expect(isPocQuote(typed, ORG, env)).toBe(false);
    expect(isPocQuote(flagged, ORG, env)).toBe(true);
  });
});

describe("the server POC flag cannot be set, cleared or forged by any client draft path", () => {
  it("createGrowerQuoteAction: a forged flag in the submitted draft is discarded when the mode is off; set by the SERVER when the mode is on", async () => {
    as(false, "u-rep");
    const r = await grower.createGrowerQuoteAction(forged({ pocPresentation: true }));
    expect(r.ok, r.error).toBe(true);
    expect(hasPocFlag((db.rows("newquip_quotes").find((x) => x.id === r.data!.id) as Row).draft)).toBe(false);
    on();
    const r2 = await grower.createGrowerQuoteAction();
    expect(hasPocFlag((db.rows("newquip_quotes").find((x) => x.id === r2.data!.id) as Row).draft)).toBe(true); // genuine POC creation
    expect(isPocQuote((db.rows("newquip_quotes").find((x) => x.id === r2.data!.id) as Row).draft, ORG)).toBe(true);
  });
  it("saveGrowerDraftAction as Rep-level member and as Manager: cannot SET the flag", async () => {
    for (const admin of [false, true]) {
      on(); as(admin);
      const s = await grower.saveGrowerDraftAction("q1", forged({ pocPresentation: true, assumptions: `x${admin}` }));
      expect(s.ok, s.error).toBe(true);
      expect(quote().draft.estimator.assumptions).toBe(`x${admin}`); // the save really applied
      expect(hasPocFlag(quote().draft)).toBe(false);
    }
  });
  it("saveGrowerDraftAction: cannot CLEAR a stored flag (deleted, false, or absent in the submitted draft)", async () => {
    on(); mark();
    for (const [i, admin] of [false, true].entries()) {
      as(admin);
      const d = forged({ assumptions: `clr${i}` }); delete (d.estimator as Record<string, unknown>).pocPresentation;
      expect((await grower.saveGrowerDraftAction("q1", d)).ok).toBe(true);
      expect(hasPocFlag(quote().draft)).toBe(true);
      expect((await grower.saveGrowerDraftAction("q1", forged({ pocPresentation: false, assumptions: `clr2${i}` }))).ok).toBe(true);
      expect(hasPocFlag(quote().draft)).toBe(true);
    }
  });
  it("the store itself (saveDraft / createQuote) enforces it, independent of the action layer", async () => {
    await saveDraft(db as never, ORG, rolesFor("admin"), "q1", forged({ pocPresentation: true, assumptions: "store" }) as never);
    expect(hasPocFlag(quote().draft)).toBe(false);
    mark();
    await saveDraft(db as never, ORG, rolesFor("admin"), "q1", { ...forged({ assumptions: "store2" }), estimator: { ...forged().estimator, assumptions: "store2", pocPresentation: undefined } } as never, undefined, { keepStoredPricing: true });
    expect(hasPocFlag(quote().draft)).toBe(true);
    const made = await createQuote(db as never, ORG, "x@y", forged({ pocPresentation: true }) as never);
    expect(hasPocFlag((db.rows("newquip_quotes").find((x) => x.id === made.id) as Row).draft)).toBe(false);
    const made2 = await createQuote(db as never, ORG, "x@y", forged({}) as never, { pocPresentation: true });
    expect(hasPocFlag((db.rows("newquip_quotes").find((x) => x.id === made2.id) as Row).draft)).toBe(true);
  });
});

describe("the flag is inert unless the mode is on at the moment of use", () => {
  it("flagged quotation, switch OFF: refused exactly as a normal quotation, nothing written", async () => {
    as(true); mark(); const before = snapshot();
    expect((await grower.approveGrowerQuoteAction("q1")).ok).toBe(false); expect(snapshot()).toBe(before);
  });
  it("flagged quotation, VERCEL_ENV=production with the switch on: refused", async () => {
    on(); process.env.VERCEL_ENV = "production"; as(true); mark(); const before = snapshot();
    expect((await grower.approveGrowerQuoteAction("q1")).ok).toBe(false); expect(snapshot()).toBe(before); expect(pocAudit()).toHaveLength(0);
  });
  it("a baseline sealed in POC mode gets NO scope exclusion at project creation once the switch is off or in production", async () => {
    noLibrary(); on(); as(true); mark();
    expect((await grower.approveGrowerQuoteAction("q1")).ok).toBe(true);
    delete process.env.NEWQUIP_POC_PRESENTATION;
    const p = await grower.createProjectFromGrowerQuoteAction("q1"); expect(p.ok, p.error).toBe(true);
    expect(effectiveScope(projectScope()).excluded.some((x) => /POC PRESENTATION/.test(x.reason))).toBe(false);
  });
});

describe("authorisation and audit of a genuine POC approval", () => {
  it("an Estimator-only (member) session cannot approve or auto-record: refused, nothing written", async () => {
    on(); as(false); mark(); const before = snapshot();
    const r = await grower.approveGrowerQuoteAction("q1");
    expect(r.ok).toBe(false); expect(snapshot()).toBe(before); expect(pocAudit()).toHaveLength(0);
    const r2 = await grower.approveGrowerQuoteAction("q1", { baselineException: req({ reason: POC_BASELINE_REASON }) });
    expect(r2.ok).toBe(false); expect(snapshot()).toBe(before);
  });
  it("the Manager auto-record writes an audit row naming the server flag as the basis, the actor, revision, draft hash; the baseline records pocPresentation", async () => {
    on(); as(true, "mgr1"); mark();
    const rev = quote().revision, hash = quote().draft_hash;
    const r = await grower.approveGrowerQuoteAction("q1");
    expect(r.ok, r.error).toBe(true);
    const row = pocAudit();
    expect(row).toHaveLength(1);
    const d = JSON.stringify(row[0]);
    expect(d).toContain("poc_presentation_server_flag"); expect(d).toContain("mgr1@nq"); expect(d).toContain(hash);
    expect(d).toMatch(/"revision":3|revision.{0,4}3/); expect(rev).toBe(3);
    expect(d).toMatch(/autoRecorded.{0,4}true/); expect(d).toMatch(/pocPresentation.{0,4}true/);
    expect(quote().accepted_baseline.pocPresentation).toBe(true);
    expect(quote().accepted_baseline.exceptions[0].approvedBy).toBe("mgr1@nq");
    expect(quote().accepted_baseline.exceptions[0].version).toMatchObject({ revision: 3, draftHash: hash });
  });
  it("a Manager's own typed exception on a normal quotation is audited as manager_recorded_exception with pocPresentation false", async () => {
    on(); as(true); const r = await grower.approveGrowerQuoteAction("q1", { baselineException: req() });
    expect(r.ok, r.error).toBe(true);
    const d = JSON.stringify(pocAudit()[0]);
    expect(d).toContain("manager_recorded_exception"); expect(d).toMatch(/pocPresentation.{0,4}false/);
  });
});

describe("a Manager-typed 'POC PRESENTATION' reason never triggers scope exclusion; legacy sealed POC baselines still do (read-compat)", () => {
  it("normal quotation, Manager types the POC prefix as the exception reason: baseline.pocPresentation false, no exclusion", async () => {
    noLibrary(); on(); as(true);
    // LED unmapped is not Estimator-priced by design for a normal quotation, so use the mapped library; the typed reason is the point
    db.tables.newquip_package_mappings = [ledLibraryMapping(ORG)];
    const ok = await grower.approveGrowerQuoteAction("q1", { baselineException: req({ reason: `${POC_MARKER}: typed by the Manager, long enough to pass validation` }) });
    expect(ok.ok, ok.error).toBe(true);
    expect(quote().accepted_baseline.pocPresentation).toBe(false);
    expect(approvedInPocMode(quote().accepted_baseline)).toBe(false);
    const p = await grower.createProjectFromGrowerQuoteAction("q1"); expect(p.ok, p.error).toBe(true);
    const eff = effectiveScope(projectScope());
    expect(eff.excluded.some((x) => /POC PRESENTATION/.test(x.reason))).toBe(false);
  });
  it("LEGACY: an already-approved baseline (no pocPresentation field, POC reason prefix) is still treated as POC-approved at project creation; the stored baseline is untouched", async () => {
    noLibrary(); on(); as(true); mark();
    expect((await grower.approveGrowerQuoteAction("q1")).ok).toBe(true);
    // Rewrite the stored row as the OLD build would have sealed it: no pocPresentation field, correctly re-sealed.
    const legacy = structuredClone(quote().accepted_baseline); delete legacy.pocPresentation;
    quote().accepted_baseline = legacy; quote().baseline_hash = hashOf(legacy);
    { const d = structuredClone(quote().draft); delete d.estimator.pocPresentation; quote().draft = d; } // and the draft carries no server flag: only the sealed record counts
    expect(approvedInPocMode(legacy)).toBe(true);
    const sealed = JSON.stringify([quote().accepted_baseline, quote().baseline_hash]);
    const p = await grower.createProjectFromGrowerQuoteAction("q1"); expect(p.ok, p.error).toBe(true);
    const eff = effectiveScope(projectScope());
    expect(eff.blockers).toEqual([]); expect(eff.excluded.length).toBeGreaterThan(0);
    expect(eff.excluded.every((x) => /^POC PRESENTATION/.test(x.reason))).toBe(true);
    expect(JSON.stringify([quote().accepted_baseline, quote().baseline_hash])).toBe(sealed);
  });
  it("read-compat is for sealed legacy baselines only: a NEW baseline carries an explicit boolean, so the prefix alone never counts", () => {
    expect(approvedInPocMode({ pocPresentation: false, exceptions: [{ reason: `${POC_MARKER}: x` }] })).toBe(false);
    expect(approvedInPocMode({ pocPresentation: true })).toBe(true);
    expect(approvedInPocMode({ exceptions: [{ reason: `${POC_MARKER}: x` }] })).toBe(true); // legacy sealed record
    expect(approvedInPocMode({ exceptions: [{ reason: "ordinary" }] })).toBe(false);
  });
});

import { pocDocumentMarked } from "@/lib/newquip-quotes/poc-presentation";
describe("customer-document demonstration wording (wording only)", () => {
  const env = { VERCEL_ENV: "preview", NEWQUIP_POC_PRESENTATION: "true", SUPABASE_URL: `https://${REF}.supabase.co`, NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co` };
  const legacy = { draft: { estimator: { assumptions: `${POC_MARKER}: old` } } as never, accepted_baseline: { exceptions: [{ reason: `${POC_MARKER}: old` }] } };
  it("an approved legacy POC baseline (no field, prefix reason) keeps the demo terms with the gate on; none with the gate off or in production", () => {
    expect(pocDocumentMarked(legacy, ORG, env)).toBe(true);
    expect(pocDocumentMarked(legacy, ORG, { ...env, NEWQUIP_POC_PRESENTATION: "false" })).toBe(false);
    expect(pocDocumentMarked(legacy, ORG, { ...env, VERCEL_ENV: "production" })).toBe(false);
  });
  it("explicit baseline flag counts; a NEW approval of a non-flagged quotation (explicit false, even with a typed prefix) and a marker-only draft do not", () => {
    expect(pocDocumentMarked({ accepted_baseline: { pocPresentation: true } }, ORG, env)).toBe(true);
    expect(pocDocumentMarked({ draft: { estimator: { assumptions: `${POC_MARKER}: x` } } as never, accepted_baseline: { pocPresentation: false, exceptions: [{ reason: `${POC_MARKER}: typed` }] } }, ORG, env)).toBe(false);
    expect(pocDocumentMarked({ draft: { estimator: { assumptions: `${POC_MARKER}: x` } } as never }, ORG, env)).toBe(false);
  });
});
