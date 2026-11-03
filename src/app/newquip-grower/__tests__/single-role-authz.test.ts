/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { installStaged } from "@/lib/approvals/__tests__/staged-emulator";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { emptyDraft } from "@/newquip/grower/draft";
import { applyDemoDefaults } from "@/newquip/grower/demo-defaults";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { sendEmail } from "@/lib/email/resend";

// UX-006h: SERVER-SIDE NEGATIVE AUTHORISATION for the real hosted account shape. The REAL actions run over an in-memory database; the role tables
// (org_functional_roles) are seeded exactly like the NewQuip POC organisation - ONE explicit functional role per account - and the REAL role
// resolution (authoriseActor -> resolveRoles / effectiveRoles / toQuoteRoles / canSeeCosts) decides. Nothing about roles is mocked: only the session
// (who is signed in and whether they are an org owner/admin) is. Every cross-role call must be REFUSED with no state change and no write.
//
//   owner  : org OWNER tier, explicit ADMINISTRATOR   (requireOrgAdmin passes)
//   rep    : member tier, explicit REP
//   est    : member tier, explicit ESTIMATOR
//   mgr    : member tier, explicit MANAGER

let db: FakeDb;
vi.mock("server-only", () => ({}));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/email/resend", () => ({ sendEmail: vi.fn(async () => ({ ok: true, messageId: "m" })), emailConfigStatus: () => ({ configured: true, missing: [], senderDomain: "x.test" }) }));
import * as actions from "../actions";
import * as customer from "../customer-actions";
import * as delivery from "../delivery-actions";
import * as documents from "../document-actions";
import * as cost from "../cost-actions";

const ORG = "org-nq";
type Who = "owner" | "rep" | "est" | "mgr";
const WHO: Who[] = ["owner", "rep", "est", "mgr"];
const ACCOUNT: Record<Who, { userId: string; email: string; tier: "owner" | "member"; fn: string }> = {
  owner: { userId: "u-owner", email: "owner@a", tier: "owner", fn: "ADMINISTRATOR" },
  rep: { userId: "u-rep", email: "rep@a", tier: "member", fn: "REP" },
  est: { userId: "u-est", email: "est@a", tier: "member", fn: "ESTIMATOR" },
  mgr: { userId: "u-mgr", email: "mgr@a", tier: "member", fn: "MANAGER" },
};
const EMAILS: Record<string, string> = Object.fromEntries(Object.values(ACCOUNT).map((a) => [a.userId, a.email]));
const priceCtx = { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: true };
const draft = applyDemoDefaults({ ...emptyDraft(), customerName: "Test Customer" }).draft;
const total = Math.round(evaluateDraft(draft, priceCtx).budget!.totals.subtotalExTax * 100);
const ALT = { source: "ALTERNATIVE" as const, name: "Joe Farmer", reason: "Confirmed by telephone" };

/** The signed-in identity: the session facts a real request would have. Everything else comes from the real role tables. */
function as(who: Who, orgId = ORG) {
  const a = ACCOUNT[who];
  vi.mocked(requireNewquipPocOrg).mockResolvedValue({ orgId } as never);
  vi.mocked(requireModuleAccess).mockResolvedValue({ orgId, userId: a.userId, email: a.email } as never);
  vi.mocked(requireOrgAdmin).mockImplementation(async () => { if (a.tier === "member") throw new Error("Only an org owner or admin can do that."); return undefined as never; });
}

function world(opts: { strict?: boolean } = {}) {
  const d = new FakeDb();
  seedGoldenCatalogue(d as never, ORG);
  d.approvalsApplied = true; d.rolesApplied = true;
  installStaged(d);
  (d as any).auth = { admin: { getUserById: async (id: string) => ({ data: { user: { email: EMAILS[id] } } }) } };
  for (const a of Object.values(ACCOUNT)) {
    d.rows("org_members").push({ org_id: ORG, user_id: a.userId, role: a.tier });
    d.rows("org_functional_roles").push({ id: `r-${a.userId}`, org_id: ORG, user_id: a.userId, user_email: a.email, role: a.fn, assigned_by_email: "owner@a", assigned_at: "t" });
  }
  if (opts.strict) d.rows("approval_settings").push({ org_id: ORG, roles_enforced: true });
  return d;
}
const seedQuote = (state: "REP_DRAFT" | "ESTIMATOR_REVIEW", over: Record<string, unknown> = {}) => db.rows("newquip_quotes").push({
  id: "q1", org_id: ORG, quote_ref: "NQ-Q-0009", revision: 1, customer_name: "Test Customer", site_name: "Farm", quote_type: "project", state, draft, draft_hash: "h1",
  customer_confirmed_cents: state === "REP_DRAFT" ? null : total, customer_confirmed_by: state === "REP_DRAFT" ? null : "r", customer_confirmed_at: state === "REP_DRAFT" ? null : "t",
  handoff_by_email: state === "REP_DRAFT" ? null : "rep@a", created_by_email: "rep@a", estimator_signoff_hash: null, estimator_signoff_by_email: null, estimator_signoff_at: null,
  approved_by_email: null, approved_at: null, accepted_baseline: null, baseline_hash: null, contract_cents: null, project_id: null, created_at: "t", updated_at: "t", ...over,
});
const quote = () => db.rows("newquip_quotes")[0] as Record<string, any>;

/** Everything a refused action must leave untouched: the quotation, the approval requests and their events, and the count of writes. */
const fingerprint = () => JSON.stringify([db.rows("newquip_quotes"), db.rows("approval_requests"), db.rows("approval_events"), db.rows("approval_notifications"), db.writes.length]);

/** Drive the REAL workflow with the right single-role account at each step, to reach a given state. */
async function toEstimatorReview() { seedQuote("REP_DRAFT"); as("rep"); const r = await actions.sendGrowerQuoteToEstimatorAction("q1", total, ALT); expect(r.error).toBeUndefined(); expect(quote().state).toBe("ESTIMATOR_REVIEW"); }
async function toSignedOff() { await toEstimatorReview(); as("est"); const r = await actions.signOffGrowerQuoteAction("q1"); expect(r.error).toBeUndefined(); expect(quote().estimator_signoff_hash).toBeTruthy(); }
async function toFinal() { await toSignedOff(); as("mgr"); const r = await actions.approveGrowerQuoteAction("q1"); expect(r.error).toBeUndefined(); expect(quote().state).toBe("MANAGER_APPROVED_FINAL"); }

beforeEach(() => { db = world(); vi.clearAllMocks(); });

describe("the four-account shape resolves to exactly one capability each (real role resolution)", () => {
  const viewer = async (w: Who) => { as(w); return (await actions.getGrowerViewerAction()).data!; };
  it("ADMINISTRATOR-owner has NO quote role at all, yet sees cost (admin tier); Rep: rep only, cost-blind; Estimator and Manager: one role, cost visible", async () => {
    expect(await viewer("owner")).toEqual({ roles: [], canViewCommercials: true });
    expect(await viewer("rep")).toEqual({ roles: ["rep"], canViewCommercials: false });
    expect(await viewer("est")).toEqual({ roles: ["estimator"], canViewCommercials: true });
    expect(await viewer("mgr")).toEqual({ roles: ["manager"], canViewCommercials: true });
  });
  it("strict roles ON changes nothing for these four (every account has an explicit assignment)", async () => {
    db = world({ strict: true });
    expect(await viewer("owner")).toEqual({ roles: [], canViewCommercials: true });
    expect(await viewer("rep")).toEqual({ roles: ["rep"], canViewCommercials: false });
    expect((await viewer("mgr")).roles).toEqual(["manager"]);
  });
  it("CONTRAST: an owner/admin with NO assignment holds all three quote roles (why one admin account cannot show the roles separately)", async () => {
    db.rows("org_functional_roles").splice(0, 1); // remove the owner's ADMINISTRATOR row
    expect((await viewer("owner")).roles.sort()).toEqual(["estimator", "manager", "rep"]);
  });
});

describe("workflow actions: every cross-role call is refused server-side, with no state change and no write", () => {
  type Run = () => Promise<{ ok: boolean; error?: string }>;
  const refused = async (who: Who, run: Run, msg: RegExp) => {
    const before = fingerprint(); const mails = vi.mocked(sendEmail).mock.calls.length;
    as(who);
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(msg);
    expect(fingerprint()).toBe(before);
    expect(vi.mocked(sendEmail).mock.calls.length).toBe(mails);
  };

  describe("REP_DRAFT", () => {
    beforeEach(() => { seedQuote("REP_DRAFT"); });
    it.each(["owner", "est", "mgr"] as Who[])("%s cannot send to the Estimator (Rep only)", (w) => refused(w, () => actions.sendGrowerQuoteToEstimatorAction("q1", total, ALT), /Only a Rep/));
    it.each(["owner", "mgr"] as Who[])("%s cannot edit or save the draft (Rep/Estimator only)", (w) => refused(w, () => actions.saveGrowerDraftAction("q1", draft), /do not have permission to edit/));
    it.each(["owner", "est", "mgr"] as Who[])("%s cannot start a quotation (Rep only)", (w) => refused(w, () => actions.createGrowerQuoteAction(), /Only a rep can start a quote/));
    it.each(["owner", "rep"] as Who[])("%s cannot map a product (Estimator/Manager only)", (w) => refused(w, () => actions.searchCin7CatalogueForMappingAction("x"), /Only an Estimator or Manager/));
    it("the right roles can: Rep and Estimator save the draft; Rep starts a quotation", async () => {
      as("rep"); expect((await actions.saveGrowerDraftAction("q1", draft)).ok).toBe(true);
      as("est"); expect((await actions.saveGrowerDraftAction("q1", draft)).ok).toBe(true);
      as("rep"); expect((await actions.createGrowerQuoteAction()).ok).toBe(true);
    });
  });

  describe("ESTIMATOR_REVIEW, awaiting sign-off (estimator-stage request open)", () => {
    beforeEach(toEstimatorReview);
    it.each(["owner", "rep", "mgr"] as Who[])("%s cannot sign off (Estimator only)", (w) => refused(w, () => actions.signOffGrowerQuoteAction("q1"), /estimator role/));
    it.each(["owner", "rep", "est", "mgr"] as Who[])("%s cannot give final approval before the sign-off", (w) => refused(w, () => actions.approveGrowerQuoteAction("q1"), /waiting for estimator review, not manager approval/));
    it.each(["owner", "rep", "est", "mgr"] as Who[])("%s cannot return it to the Estimator (a Manager action, and only from manager review)", (w) => refused(w, () => actions.returnGrowerQuoteToEstimatorAction("q1", "please recheck"), /waiting for estimator review, not manager approval/));
    it.each(["owner", "rep", "mgr"] as Who[])("%s cannot return it to the Rep at this stage (only the stage's Estimator can)", (w) => refused(w, () => actions.returnGrowerQuoteToRepAction("q1", "needs rework"), /estimator role/));
    it.each(["owner", "mgr"] as Who[])("%s cannot edit the draft in review", (w) => refused(w, () => actions.saveGrowerDraftAction("q1", draft), /do not have permission to edit/));
    it.each(["owner", "est", "mgr"] as Who[])("%s cannot create a project from an unapproved quotation", (w) => refused(w, () => actions.createProjectFromGrowerQuoteAction("q1"), w === "mgr" ? /manager-approved final/ : /Only a Manager can create/));
  });

  describe("ESTIMATOR_REVIEW, signed off (manager-stage request open)", () => {
    beforeEach(toSignedOff);
    it.each(["owner", "rep", "est"] as Who[])("%s cannot give final approval (Manager only)", (w) => refused(w, () => actions.approveGrowerQuoteAction("q1"), /manager role/));
    it.each(["owner", "rep", "est"] as Who[])("%s cannot return it to the Estimator (Manager only)", (w) => refused(w, () => actions.returnGrowerQuoteToEstimatorAction("q1", "please recheck"), /manager role/));
    it.each(["owner", "rep", "est"] as Who[])("%s cannot return it to the Rep at manager review (Manager only)", (w) => refused(w, () => actions.returnGrowerQuoteToRepAction("q1", "needs rework"), /manager role/));
    it.each(["owner", "rep", "est", "mgr"] as Who[])("%s cannot sign off again at manager review (stage mismatch)", (w) => refused(w, () => actions.signOffGrowerQuoteAction("q1"), /waiting for manager approval, not estimator review/));
    it("the owner (ADMINISTRATOR) cannot approve through the quotation screen even though the Approvals dashboard offers a reasoned override: the action never passes override", async () => {
      await refused("owner", () => actions.approveGrowerQuoteAction("q1"), /explicit override|manager role/);
      expect(quote().state).toBe("ESTIMATOR_REVIEW");
    });
  });

  describe("a refused decision never decides, even when no approval request had been opened yet", () => {
    it.each(["owner", "rep", "mgr"] as Who[])("%s: signing off an in-review quotation with no open request is refused; the quotation and sign-off are untouched and nothing is approved", async (w) => {
      seedQuote("ESTIMATOR_REVIEW"); // no request has been opened for it
      as(w);
      const r = await actions.signOffGrowerQuoteAction("q1");
      expect(r.ok).toBe(false);
      expect(quote()).toMatchObject({ state: "ESTIMATOR_REVIEW", estimator_signoff_hash: null, estimator_signoff_by_email: null });
      expect(db.rows("approval_events").filter((e: any) => /APPROVED|RETURNED|REJECTED/.test(e.action))).toEqual([]);
    });
  });

  describe("MANAGER_APPROVED_FINAL (reached by Rep -> Estimator -> Manager)", () => {
    beforeEach(toFinal);
    it.each(WHO)("%s cannot edit an approved quotation", (w) => refused(w, () => actions.saveGrowerDraftAction("q1", draft), /final and cannot be edited/));
    it.each(WHO)("%s cannot sign off, approve or send an approved quotation again", async (w) => {
      await refused(w, () => actions.approveGrowerQuoteAction("q1"), /./);
      await refused(w, () => actions.signOffGrowerQuoteAction("q1"), /./);
      if (w !== "est" && w !== "mgr" && w !== "owner") await refused(w, () => actions.sendGrowerQuoteToEstimatorAction("q1", total, ALT), /./);
    });
    it.each(["owner", "rep", "est"] as Who[])("%s cannot create a Project (Manager only)", (w) => refused(w, () => actions.createProjectFromGrowerQuoteAction("q1"), /Only a Manager can create a Project/));
    it("the Manager passes the role gate (the outcome is then decided by the quote's own preconditions, not by the role)", async () => {
      as("mgr");
      const r = await actions.createProjectFromGrowerQuoteAction("q1");
      expect(r.error ?? "").not.toMatch(/Only a Manager/);
    });
  });
});

describe("the allowed path works for the right single-role account at each step, and records who did it", () => {
  it("Rep sends -> Estimator signs off -> Manager approves; the owner (ADMINISTRATOR) takes no part", async () => {
    await toFinal();
    expect(quote()).toMatchObject({ state: "MANAGER_APPROVED_FINAL", handoff_by_email: "rep@a", estimator_signoff_by_email: "est@a", approved_by_email: "mgr@a" });
    expect(quote().accepted_baseline).toBeTruthy();
    expect(db.rows("approval_events").map((e: any) => `${e.stage}:${e.action}:${e.actor_email}`).filter((s: string) => /APPROVED/.test(s))).toEqual(["ESTIMATOR:APPROVED:est@a", "MANAGER:APPROVED:mgr@a"]);
  });
  it("Estimator -> Rep return works for the Estimator alone, and the Manager -> Estimator return works for the Manager alone", async () => {
    await toSignedOff();
    as("mgr");
    expect((await actions.returnGrowerQuoteToEstimatorAction("q1", "please recheck the slats")).error).toBeUndefined();
    expect(quote().state).toBe("ESTIMATOR_REVIEW"); expect(quote().estimator_signoff_hash).toBeNull();
    as("est");
    expect((await actions.returnGrowerQuoteToRepAction("q1", "customer must reconfirm")).error).toBeUndefined();
    expect(quote().state).toBe("REP_DRAFT");
  });
});

describe("customer, delivery, document and cost actions: single-role refusals (real role resolution)", () => {
  beforeEach(() => { db.deliveryApplied = true; seedQuote("REP_DRAFT"); });
  const refusedWrites = async (who: Who, run: () => Promise<{ ok: boolean; error?: string }>, msg: RegExp) => {
    const writes = db.writes.length; as(who);
    const r = await run();
    expect(r.ok).toBe(false); expect(r.error).toMatch(msg);
    expect(db.writes.length).toBe(writes);
    expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
  };
  it.each(["owner", "est", "mgr"] as Who[])("%s cannot select, clear or choose the customer contact, or search customers (Rep only)", async (w) => {
    await refusedWrites(w, () => customer.selectQuoteCustomerAction("q1", "Boerdery"), /Only a Rep/);
    await refusedWrites(w, () => customer.clearQuoteCustomerAction("q1", true), /Only a Rep/);
    await refusedWrites(w, () => customer.chooseQuoteContactAction("q1", { source: "CIN7_CONTACT", contactIndex: 0 } as never), /Only a Rep/);
    await refusedWrites(w, () => customer.searchQuoteCustomersForQuoteAction("boer"), /Only a Rep/);
  });
  it.each(["owner", "est", "mgr"] as Who[])("%s cannot send a quotation to the customer, or retry a send (Rep only)", async (w) => {
    await refusedWrites(w, () => delivery.sendQuoteToCustomerAction("q1", {} as never), /Only a Rep/);
    await refusedWrites(w, () => delivery.retryQuoteSendAction("q1", "s1"), /Only a Rep/);
  });
  it.each(["owner", "est"] as Who[])("%s cannot record, verify or withdraw the customer's response, or issue the quotation PDF (Rep or Manager only)", async (w) => {
    await refusedWrites(w, () => delivery.recordCustomerResponseAction("q1", { documentId: "d", response: "ACCEPTED", contactName: "x", respondedOn: "2026-01-01", evidenceRef: "e", note: "" } as never), /permission/);
    await refusedWrites(w, () => delivery.reviewCustomerResponseAction("q1", { responseId: "r", decision: "VERIFIED", note: "n" }), /Rep or Manager/);
    await refusedWrites(w, () => delivery.revokeResponseLinksAction("q1", "reason here"), /permission/);
    await refusedWrites(w, () => documents.issueQuoteDocumentAction("q1"), /permission to issue/);
  });
  it.each(["owner", "rep", "est"] as Who[])("%s cannot change the company details (Manager only)", (w) => refusedWrites(w, () => documents.saveCompanyProfileAction({}), /Only a Manager/));
  it("CAPABILITY NOTE: the ADMINISTRATOR-only owner is refused every Rep/Manager document action too (it holds no quote role)", async () => {
    await refusedWrites("owner", () => documents.issueQuoteDocumentAction("q1"), /permission/);
  });
  it("cost capture and the cost estimate: the Rep is refused; Estimator, Manager and the admin-tier owner may read (cost visibility is not a quote role)", async () => {
    as("rep");
    for (const r of [cost.getQuoteCostEstimateAction("q1"), cost.captureLatestCostsAction("q1"), cost.recalculateCostsAction("q1"), cost.recordFxRateAction("USD", "17.5", "SARB", new Date().toISOString())]) expect((await r).error).toMatch(/Costs are internal/);
    for (const w of ["owner", "est", "mgr"] as Who[]) { as(w); expect((await cost.getQuoteCostEstimateAction("q1")).error ?? "").not.toMatch(/Costs are internal/); }
  });
});

describe("cost and margin are never in the Rep's payload (redaction), and are in the others'", () => {
  const costly = { costOverrides: { X: { unitCostCents: 5 } }, physicalCosts: { X: { unitCostCents: 5 } }, costBasis: { unitBasis: "x" } };
  const baseline = { internalMargin: { total: 1 }, physicalCostEstimate: { total: 1 }, estimator: costly };
  beforeEach(() => seedQuote("ESTIMATOR_REVIEW", { draft: { ...draft, estimator: { ...draft.estimator, ...costly } }, accepted_baseline: baseline }));
  const payload = async (w: Who) => { as(w); return (await actions.getGrowerQuoteAction("q1")).data!; };
  it("Rep: viewer.canViewCommercials=false, no cost/GP/margin on any line or total, and no internal cost fields anywhere in the quote record", async () => {
    const v = await payload("rep");
    expect(v.viewer).toEqual({ roles: ["rep"], canViewCommercials: false });
    for (const l of v.evaluation.budget!.lines) expect([l.estimatedCost, l.estimatedGP, l.marginPct]).toEqual([null, null, null]);
    expect(v.evaluation.budget!.totals.estimatedCost).toBe(0);
    expect(v.evaluation.budget!.totals.overallMarginPct ?? null).toBeNull();
    const s = JSON.stringify(v);
    for (const k of ["costOverrides", "physicalCosts", "costBasis", "internalMargin", "physicalCostEstimate"]) expect(s).not.toContain(k);
  });
  it("Rep: the live preview also withholds cost", async () => {
    as("rep");
    const p = (await actions.previewGrowerDraftAction(draft)).data!;
    expect(p.budget!.totals.estimatedCost).toBe(0);
    for (const l of p.budget!.lines) expect(l.estimatedCost).toBeNull();
  });
  it.each(["owner", "est", "mgr"] as Who[])("%s: canViewCommercials=true and the cost fields are present", async (w) => {
    const v = await payload(w);
    expect(v.viewer.canViewCommercials).toBe(true);
    expect(v.evaluation.budget!.totals.estimatedCost).toBeGreaterThan(0);
    expect(JSON.stringify(v)).toContain("physicalCostEstimate");
  });
  it("a client-supplied cost cannot be forged by a Rep: costs stay server-owned on save", async () => {
    as("rep");
    const forged = { ...draft, estimator: { ...draft.estimator, costOverrides: { X: { unitCostCents: 1 } } } } as never;
    expect((await actions.saveGrowerDraftAction("q1", forged)).ok).toBe(true);
    expect(JSON.stringify(quote().draft.estimator.costOverrides)).not.toContain('"unitCostCents":1}');
  });
});

describe("unauthenticated and other-organisation callers are refused, and nothing is written", () => {
  beforeEach(() => seedQuote("ESTIMATOR_REVIEW"));
  const everyAction: Array<[string, () => Promise<{ ok: boolean; error?: string }>]> = [
    ["customer.select", () => customer.selectQuoteCustomerAction("q1", "x")], ["customer.get", () => customer.getQuoteCustomerAction("q1")],
    ["delivery.send", () => delivery.sendQuoteToCustomerAction("q1", {} as never)], ["delivery.get", () => delivery.getQuoteDeliveryAction("q1")],
    ["delivery.record", () => delivery.recordCustomerResponseAction("q1", {} as never)], ["documents.issue", () => documents.issueQuoteDocumentAction("q1")],
    ["documents.get", () => documents.getQuoteDocumentsAction("q1")], ["documents.profile", () => documents.saveCompanyProfileAction({})],
    ["cost.get", () => cost.getQuoteCostEstimateAction("q1")], ["cost.capture", () => cost.captureLatestCostsAction("q1")],
    ["actions.signOff", () => actions.signOffGrowerQuoteAction("q1")], ["actions.approve", () => actions.approveGrowerQuoteAction("q1")],
    ["actions.project", () => actions.createProjectFromGrowerQuoteAction("q1")], ["actions.save", () => actions.saveGrowerDraftAction("q1", draft)],
  ];
  it.each(everyAction)("%s: a signed-out caller (module access rejects) is refused with no write", async (_n, run) => {
    vi.mocked(requireNewquipPocOrg).mockResolvedValue({ orgId: ORG } as never);
    vi.mocked(requireModuleAccess).mockRejectedValue(new Error("Not signed in."));
    const before = fingerprint();
    const r = await run();
    expect(r.ok).toBe(false); expect(r.error).toMatch(/Not signed in/);
    expect(fingerprint()).toBe(before);
  });
  it.each(everyAction)("%s: a caller from a non-NewQuip organisation is refused with no write", async (_n, run) => {
    vi.mocked(requireNewquipPocOrg).mockRejectedValue(new Error("This tool isn't available for your organization."));
    vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: "org-x", userId: "u-rep", email: "rep@a" } as never);
    const before = fingerprint();
    const r = await run();
    expect(r.ok).toBe(false); expect(r.error).toMatch(/isn't available/);
    expect(fingerprint()).toBe(before);
  });
  it("a Manager of ANOTHER (NewQuip) organisation cannot see or act on this organisation's quotation: 'not found', no change", async () => {
    // an admin-tier user of org-b: every role they hold is org-b's, and the quotation lookup is scoped to org-b
    vi.mocked(requireNewquipPocOrg).mockResolvedValue({ orgId: "org-b" } as never);
    vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: "org-b", userId: "u-other", email: "other@b" } as never);
    vi.mocked(requireOrgAdmin).mockResolvedValue(undefined as never);
    const before = fingerprint();
    for (const r of [actions.getGrowerQuoteAction("q1"), actions.approveGrowerQuoteAction("q1"), actions.signOffGrowerQuoteAction("q1"), actions.createProjectFromGrowerQuoteAction("q1")]) {
      const out = await r; expect(out.ok).toBe(false); expect(out.error).toMatch(/not found/i);
    }
    expect((await actions.saveGrowerDraftAction("q1", draft)).ok).toBe(false); // refused (the other organisation's catalogue check or the scoped lookup), never applied
    expect(quote().state).toBe("ESTIMATOR_REVIEW");
    expect(db.rows("approval_requests").filter((x: any) => x.org_id === ORG)).toEqual(JSON.parse(before)[1]);
  });
});
