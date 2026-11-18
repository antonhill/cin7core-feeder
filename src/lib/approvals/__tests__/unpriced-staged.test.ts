// STAGED mode (migration 0112) for a quotation handed over with NO customer price (customer_confirmed_cents NULL): the Estimator stage must be actionable (request + notification, the
// Estimator can return it to the Rep), while sign-off and approval stay impossible until the Rep has confirmed the calculated amount. Same emulated 0112 functions as staged-approvals.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { emptyDraft } from "@/newquip/grower/draft";
import { applyDemoDefaults } from "@/newquip/grower/demo-defaults";
import { withAcceptedIncompleteCosting } from "@/newquip/grower/__tests__/golden";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";
import { rolesFor } from "@/newquip/quote/roles";
import { managerApprove, sendToEstimator } from "@/lib/newquip-quotes/quote-store";
import { UNPRICED_HANDOFF_BASIS } from "@/newquip/quote/workflow";
import { installStaged } from "./staged-emulator";

vi.mock("server-only", () => ({}));
import { decide, decideDocument, pendingRequestFor, resyncQuoteApprovals, type ApprovalCtx } from "../approval-store";

const ORG = "org-nq";
const ctxOf = (userId: string, email: string, adminTier = false): ApprovalCtx => ({ orgId: ORG, userId, email, name: email, isManager: adminTier, baseUrl: "https://toolbox.example" });
const REP = ctxOf("u-rep", "rep@a"), EST = ctxOf("u-est", "est@a"), MGR = ctxOf("u-mgr", "mgr@a", true), MGR2 = ctxOf("u-mgr2", "mgr2@a", true), ADM = ctxOf("u-adm", "adm@a", true);
const EMAILS: Record<string, string> = { "u-rep": "rep@a", "u-est": "est@a", "u-est2": "est2@a", "u-mgr": "mgr@a", "u-mgr2": "mgr2@a", "u-adm": "adm@a" };
const priceCtx = { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: true };
const draft = withAcceptedIncompleteCosting(applyDemoDefaults({ ...emptyDraft(), customerName: "Test Customer" }).draft);
const total = Math.round(evaluateDraft(draft, priceCtx).budget!.totals.subtotalExTax * 100);

function world(opts: { strict?: boolean } = {}) {
  const db = new FakeDb();
  seedGoldenCatalogue(db as never, ORG);
  db.approvalsApplied = true; db.rolesApplied = true;
  installStaged(db);
  (db as any).auth = { admin: { getUserById: async (id: string) => ({ data: { user: { email: EMAILS[id] } } }) } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  db.rows("org_members").push(
    { org_id: ORG, user_id: "u-rep", role: "member" }, { org_id: ORG, user_id: "u-est", role: "member" }, { org_id: ORG, user_id: "u-est2", role: "member" },
    { org_id: ORG, user_id: "u-mgr", role: "admin" }, { org_id: ORG, user_id: "u-mgr2", role: "owner" }, { org_id: ORG, user_id: "u-adm", role: "admin" },
  );
  const grant = (user: string, role: string) => db.rows("org_functional_roles").push({ id: `r-${user}-${role}`, org_id: ORG, user_id: user, user_email: EMAILS[user], role, assigned_by_email: "adm@a", assigned_at: "t" });
  grant("u-rep", "REP"); grant("u-est", "ESTIMATOR"); grant("u-est2", "ESTIMATOR"); grant("u-mgr", "MANAGER"); grant("u-mgr2", "MANAGER"); grant("u-adm", "ADMINISTRATOR");
  if (opts.strict) db.rows("approval_settings").push({ org_id: ORG, roles_enforced: true });
  db.rows("newquip_quotes").push({ id: "q1", org_id: ORG, quote_ref: "NQ-Q-0009", revision: 1, customer_name: "Test Customer", site_name: "Farm", quote_type: "project", state: "ESTIMATOR_REVIEW", draft, draft_hash: "h1",
    customer_confirmed_cents: total, customer_confirmed_by: "r", customer_confirmed_at: "t", handoff_by_email: "rep@a", created_by_email: "rep@a", estimator_signoff_hash: null, estimator_signoff_by_email: null, estimator_signoff_at: null,
    approved_by_email: null, approved_at: null, accepted_baseline: null, baseline_hash: null, contract_cents: null, project_id: null, created_at: "t", updated_at: "t" });
  return db;
}
const quote = (db: FakeDb) => db.rows("newquip_quotes")[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const reqs = (db: FakeDb) => db.rows("approval_requests") as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const notesTo = (db: FakeDb, email: string, kind?: string) => (db.rows("approval_notifications") as Array<Record<string, any>>).filter((n) => n.channel === "IN_APP" && n.recipient_email === email && (!kind || n.kind === kind)); // eslint-disable-line @typescript-eslint/no-explicit-any
/** The queued EMAIL rows for a recipient: they must mirror the in-app notifications exactly (same stage, same people). */
const emailsTo = (db: FakeDb, email: string, kind?: string) => (db.rows("approval_notifications") as Array<Record<string, any>>).filter((n) => n.channel === "EMAIL" && n.recipient_email === email && (!kind || n.kind === kind)); // eslint-disable-line @typescript-eslint/no-explicit-any
const dArgs = (r: { version: number; digest: string }) => ({ expectedVersion: r.version, expectedDigest: r.digest });

const unpricedWorld = () => {
  const db = world();
  Object.assign(quote(db), { customer_confirmed_cents: null, customer_confirmed_by: UNPRICED_HANDOFF_BASIS, customer_confirmed_at: "t" });
  return db;
};
const member = rolesFor("member");
const err = async (p: Promise<unknown>): Promise<string> => p.then(() => "", (e: Error) => e.message);
const openEstimatorStage = (db: FakeDb) => resyncQuoteApprovals(db as never, REP, "q1");

beforeEach(() => vi.useRealTimers());

describe("staged mode: unpriced initial handoff", () => {
  it("opens an ESTIMATOR-stage request and notifies the estimators (and no Manager-stage request exists)", async () => {
    const db = unpricedWorld();
    const req = await openEstimatorStage(db);
    expect(req).toMatchObject({ stage: "ESTIMATOR", stage_role: "ESTIMATOR", status: "PENDING", prepared_by_email: "rep@a" });
    expect(notesTo(db, "est@a", "ESTIMATOR_ASSIGNED")).toHaveLength(1);
    expect(emailsTo(db, "est@a", "ESTIMATOR_ASSIGNED")).toHaveLength(1);
    expect(notesTo(db, "mgr@a")).toHaveLength(0);
    expect(reqs(db).filter((r) => r.stage === "MANAGER")).toHaveLength(0);
    expect(quote(db).customer_confirmed_cents).toBeNull();
  });

  it("the Estimator can RETURN it to the Rep (the request closes, a new revision starts, nothing is confirmed)", async () => {
    const db = unpricedWorld();
    await openEstimatorStage(db);
    await decideDocument(db as never, EST, "QUOTE", "q1", "RETURN", { stage: "ESTIMATOR", reason: "Price established - Rep to confirm the calculated amount with the customer" });
    expect(quote(db)).toMatchObject({ state: "REP_DRAFT", revision: 2, customer_confirmed_cents: null, customer_confirmed_by: null, estimator_signoff_hash: null });
    expect(await pendingRequestFor(db as never, ORG, "QUOTE", "q1")).toBeNull();
  });

  it("staged SIGN-OFF is refused with the explicit no-customer-price message while cents are NULL, even with a request open; nothing is signed", async () => {
    const db = unpricedWorld();
    await openEstimatorStage(db);
    expect(await err(decideDocument(db as never, EST, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" }))).toMatch(/No customer price has been confirmed yet - return it to the Rep to confirm the calculated amount/);
    expect(quote(db).estimator_signoff_hash).toBeNull();
    expect((await pendingRequestFor(db as never, ORG, "QUOTE", "q1"))!.stage).toBe("ESTIMATOR");
    expect(reqs(db).filter((r) => r.stage === "MANAGER")).toHaveLength(0);
  });

  it("a Manager-stage request is NEVER opened for an unconfirmed quotation, and approval is refused with NULL cents even with a (forged) sign-off on the current content", async () => {
    const db = unpricedWorld();
    await openEstimatorStage(db);
    quote(db).estimator_signoff_hash = quote(db).draft_hash; quote(db).estimator_signoff_by_email = "est@a"; // a forged sign-off of THIS content
    const again = await resyncQuoteApprovals(db as never, REP, "q1");
    expect(again?.stage).toBe("ESTIMATOR"); // still the estimator stage: the unconfirmed quotation is not "signed"
    expect(reqs(db).filter((r) => r.stage === "MANAGER")).toHaveLength(0);
    expect(await err(decideDocument(db as never, MGR, "QUOTE", "q1", "APPROVE", { stage: "MANAGER" }))).toMatch(/waiting for estimator review, not manager approval/);
    expect(await err(managerApprove(db as never, ORG, rolesFor("admin"), "mgr@a", "q1", priceCtx, priceCtx))).toMatch(/confirmation was never recorded/);
    expect(quote(db).state).toBe("ESTIMATOR_REVIEW");
    expect(quote(db).accepted_baseline).toBeNull();
  });

  it("after the Estimator returns it, the Rep's NORMAL amount confirmation is mandatory (a wrong amount is refused), and then the staged flow proceeds to Manager approval", async () => {
    const db = unpricedWorld();
    await openEstimatorStage(db);
    await decideDocument(db as never, EST, "QUOTE", "q1", "RETURN", { stage: "ESTIMATOR", reason: "Price established - Rep to confirm" });
    expect(await err(sendToEstimator(db as never, ORG, member, "rep@a", "q1", priceCtx, { confirmedAmountCents: total + 1, confirmedBy: "Joe" }))).toMatch(/must equal the quote total/);
    expect(quote(db).state).toBe("REP_DRAFT");
    await sendToEstimator(db as never, ORG, member, "rep@a", "q1", priceCtx, { confirmedAmountCents: total, confirmedBy: "Joe" });
    expect(quote(db)).toMatchObject({ state: "ESTIMATOR_REVIEW", customer_confirmed_cents: total, customer_confirmed_by: "Joe" });
    const est = await openEstimatorStage(db);
    expect(est).toMatchObject({ stage: "ESTIMATOR" });
    await decideDocument(db as never, EST, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" });
    expect(quote(db).estimator_signoff_hash).toBe(quote(db).draft_hash);
    const mgrReq = (await pendingRequestFor(db as never, ORG, "QUOTE", "q1"))!;
    expect(mgrReq.stage).toBe("MANAGER");
    const done = await decide(db as never, MGR, mgrReq.id, "APPROVE", dArgs(mgrReq));
    expect(done.status).toBe("APPROVED");
    expect(quote(db).state).toBe("MANAGER_APPROVED_FINAL");
  });

  it("positive-amount behaviour is unchanged: a confirmed quotation still opens the ESTIMATOR stage and signs off exactly as before", async () => {
    const db = world();
    const req = await openEstimatorStage(db);
    expect(req).toMatchObject({ stage: "ESTIMATOR" });
    await decideDocument(db as never, EST, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" });
    expect(quote(db).estimator_signoff_hash).toBe(quote(db).draft_hash);
  });
});
