import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { createQuote, saveDraft, sendToEstimator, estimatorSignOff } from "@/lib/newquip-quotes/quote-store";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { rolesFor } from "@/newquip/quote/roles";
import * as actions from "../actions";

// The NewQuip actions against the REAL quote store (in-memory database stand-in): who may do what is decided by the workflow
// table, not by a mock. Authorisation is re-established in every action; anything that is not provably admin is a plain member.

let db: FakeDb;
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/newquip-quotes/context", async () => {
  const { testPriceSource: src } = await import("@/newquip/grower/__tests__/test-snapshot");
  return { evaluationContext: (withholdCost: boolean) => ({ priceSource: src(), withholdCost }) };
});

const ORG = "org-nq";
const SESSION = { orgId: ORG, userId: "u1", email: "u@nq" };
const ctx = { priceSource: testPriceSource(), withholdCost: true };
const member = rolesFor("member");

async function quoteInReview(withSignoff: boolean): Promise<string> {
  const d = readyDraft();
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, d);
  const total = (await import("@/newquip/grower/evaluate")).evaluateDraft(d, ctx).budget!.totals.subtotalExTax;
  await sendToEstimator(db as never, ORG, member, "rep@nq", id, ctx, { confirmedAmountCents: Math.round(total * 100), confirmedBy: "Joe" });
  if (withSignoff) await estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx);
  return id;
}

beforeEach(() => {
  db = new FakeDb();
  vi.clearAllMocks();
  vi.mocked(requireNewquipPocOrg).mockResolvedValue(SESSION as never);
  vi.mocked(requireModuleAccess).mockResolvedValue(SESSION as never);
  vi.mocked(requireOrgAdmin).mockResolvedValue(SESSION as never); // admin
});

describe("every NewQuip action authorises first", () => {
  const calls: Array<[string, () => Promise<{ ok: boolean; error?: string }>]> = [
    ["getGrowerViewerAction", () => actions.getGrowerViewerAction()],
    ["listGrowerQuotesAction", () => actions.listGrowerQuotesAction()],
    ["createGrowerQuoteAction", () => actions.createGrowerQuoteAction()],
    ["getGrowerQuoteAction", () => actions.getGrowerQuoteAction("q")],
    ["previewGrowerDraftAction", () => actions.previewGrowerDraftAction(readyDraft())],
    ["saveGrowerDraftAction", () => actions.saveGrowerDraftAction("q", readyDraft())],
    ["sendGrowerQuoteToEstimatorAction", () => actions.sendGrowerQuoteToEstimatorAction("q", 1, "x")],
    ["returnGrowerQuoteToRepAction", () => actions.returnGrowerQuoteToRepAction("q", "x")],
    ["signOffGrowerQuoteAction", () => actions.signOffGrowerQuoteAction("q")],
    ["approveGrowerQuoteAction", () => actions.approveGrowerQuoteAction("q")],
    ["createProjectFromGrowerQuoteAction", () => actions.createProjectFromGrowerQuoteAction("q")],
  ];
  it.each(calls)("%s: a non-NewQuip organisation is refused and nothing is written", async (_n, run) => {
    vi.mocked(requireNewquipPocOrg).mockRejectedValue(new Error("This tool isn't available for your organization."));
    const r = await run();
    expect(r).toEqual({ ok: false, error: "This tool isn't available for your organization." });
    expect(db.writes).toEqual([]);
  });
  it.each(calls)("%s: module access denied is refused and nothing is written", async (_n, run) => {
    vi.mocked(requireModuleAccess).mockRejectedValue(new Error("You don't have access to this feature."));
    expect((await run()).ok).toBe(false);
    expect(db.writes).toEqual([]);
  });
});

describe("roles: member = rep + estimator; owner/admin adds manager (fail closed)", () => {
  it("a plain member cannot give final approval — the quote stays in ESTIMATOR_REVIEW", async () => {
    const id = await quoteInReview(true);
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("Only an org owner or admin can act as a NewQuip manager."));
    const r = await actions.approveGrowerQuoteAction(id);
    expect(r).toEqual({ ok: false, error: "Requires the manager role." });
    expect(db.rows("newquip_quotes")[0].state).toBe("ESTIMATOR_REVIEW");
  });
  it("an admin (manager) approves once the estimator signed off, and the accepted baseline is frozen", async () => {
    const id = await quoteInReview(true);
    const r = await actions.approveGrowerQuoteAction(id);
    expect(r.ok).toBe(true);
    expect(r.data!.quote.state).toBe("MANAGER_APPROVED_FINAL");
    expect(r.data!.quote.accepted_baseline).toBeTruthy();
    expect((await actions.saveGrowerDraftAction(id, readyDraft())).error).toMatch(/final and cannot be edited/);
  });
  it("an admin cannot approve a quote the estimator has not signed off", async () => {
    const id = await quoteInReview(false);
    expect((await actions.approveGrowerQuoteAction(id)).error).toMatch(/has not signed off/);
  });
  it("a failure to establish the admin role fails CLOSED (member roles, and no cost for the viewer)", async () => {
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("db down"));
    const v = await actions.getGrowerViewerAction();
    expect(v).toEqual({ ok: true, data: { roles: expect.arrayContaining(["rep", "estimator"]), canViewCommercials: false } });
    expect(v.data!.roles).not.toContain("manager");
  });
  it("cost is withheld from members (no cost/GP/margin in the data they receive) and shown to managers", async () => {
    const id = await quoteInReview(false);
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("no"));
    const asMember = await actions.getGrowerQuoteAction(id);
    expect(asMember.data!.viewer.canViewCommercials).toBe(false);
    expect(JSON.stringify(asMember.data!.evaluation.budget)).not.toMatch(/"estimatedCost":[1-9]/);
    for (const l of asMember.data!.evaluation.budget!.lines) expect([l.estimatedCost, l.estimatedGP, l.marginPct]).toEqual([null, null, null]);
    expect(asMember.data!.evaluation.budget!.totals.estimatedCost).toBe(0);
    vi.mocked(requireOrgAdmin).mockResolvedValue(SESSION as never);
    const asAdmin = await actions.getGrowerQuoteAction(id);
    expect(asAdmin.data!.viewer.canViewCommercials).toBe(true);
    expect(asAdmin.data!.evaluation.budget!.totals.estimatedCost).toBeGreaterThan(0);
  });
  it("only a rep can start a quote; a viewer with no roles cannot", async () => {
    expect((await actions.createGrowerQuoteAction()).ok).toBe(true);
  });
});
