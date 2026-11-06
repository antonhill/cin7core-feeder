// Notification routing for the quotation lifecycle (in-app AND email outbox, one row per recipient and event): Rep submits -> Estimator; Estimator signs off -> Manager + Rep;
// Estimator returns -> Rep; Manager approves -> Rep + Estimator; Manager returns to Estimator -> Estimator + Rep; Manager rejects -> Rep + Estimator. Driven through the REAL
// approval store over the in-memory twin of the 0112 functions.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { emptyDraft } from "@/newquip/grower/draft";
import { applyDemoDefaults } from "@/newquip/grower/demo-defaults";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";
import { rolesFor } from "@/newquip/quote/roles";
import { saveDraft } from "@/lib/newquip-quotes/quote-store";
import { installStaged } from "./staged-emulator";

vi.mock("server-only", () => ({}));
import { decide, decideDocument, docHistory, loadRequest, listRequests, pendingRequestFor, reassign, resyncQuoteApprovals, sendOverdueReminders, stagedAvailable, type ApprovalCtx } from "../approval-store";
import { assignRole, removeRole, savePolicy, listAssignments, resolveRoles } from "../role-store";

const ORG = "org-nq";
const ctxOf = (userId: string, email: string, adminTier = false): ApprovalCtx => ({ orgId: ORG, userId, email, name: email, isManager: adminTier, baseUrl: "https://toolbox.example" });
const REP = ctxOf("u-rep", "rep@a"), EST = ctxOf("u-est", "est@a"), MGR = ctxOf("u-mgr", "mgr@a", true), MGR2 = ctxOf("u-mgr2", "mgr2@a", true), ADM = ctxOf("u-adm", "adm@a", true);
const EMAILS: Record<string, string> = { "u-rep": "rep@a", "u-est": "est@a", "u-est2": "est2@a", "u-mgr": "mgr@a", "u-mgr2": "mgr2@a", "u-adm": "adm@a" };
const priceCtx = { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: true };
const draft = applyDemoDefaults({ ...emptyDraft(), customerName: "Test Customer" }).draft;
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
const openEstimatorStage = (db: FakeDb) => resyncQuoteApprovals(db as never, REP, "q1");

beforeEach(() => vi.useRealTimers());


const NOTES = (db: FakeDb) => db.rows("approval_notifications") as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
const fresh = (db: FakeDb) => NOTES(db).length;
const since = (db: FakeDb, n: number) => NOTES(db).slice(n);
const kinds = (rows: Array<Record<string, any>>, channel = "IN_APP") => rows.filter((r) => r.channel === channel).map((r) => `${r.kind}>${r.recipient_email}`).sort(); // eslint-disable-line @typescript-eslint/no-explicit-any

describe("who is told about each quotation decision", () => {
  it("Rep submits -> the Estimators only", async () => {
    const db = world();
    await openEstimatorStage(db);
    expect(kinds(NOTES(db))).toEqual(["ESTIMATOR_ASSIGNED>est2@a", "ESTIMATOR_ASSIGNED>est@a"]);
    expect(kinds(NOTES(db), "EMAIL")).toEqual(["ESTIMATOR_ASSIGNED>est2@a", "ESTIMATOR_ASSIGNED>est@a"]);
  });

  it("Estimator signs off -> the Managers (existing) AND the Rep (new), by app and email, linking to the right stage", async () => {
    const db = world(); await openEstimatorStage(db);
    const n = fresh(db);
    await decideDocument(db as never, EST, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" });
    const added = since(db, n);
    expect(kinds(added)).toEqual(["MANAGER_SUBMITTED>mgr2@a", "MANAGER_SUBMITTED>mgr@a", "SIGNED_OFF_FOR_REP>rep@a"]);
    expect(kinds(added, "EMAIL")).toEqual(["MANAGER_SUBMITTED>mgr2@a", "MANAGER_SUBMITTED>mgr@a", "SIGNED_OFF_FOR_REP>rep@a"]);
    const rep = added.find((r) => r.kind === "SIGNED_OFF_FOR_REP" && r.channel === "EMAIL")!;
    expect(rep.subject).toMatch(/NQ-Q-0009/); expect(rep.body).toMatch(/No action needed from you/); expect(rep.body).toContain("/newquip-grower/q1?stage=3");
    expect(rep.body).toMatch(/By: est@a/); expect(rep.body).toMatch(/Decided: /);
    const mgr = added.find((r) => r.kind === "MANAGER_SUBMITTED" && r.channel === "EMAIL")!;
    expect(mgr.body).toContain("/newquip-grower/q1?stage=3"); expect(mgr.body).toMatch(/Approvals page: https:\/\/toolbox\.example\/approvals\//); // the existing approvals deep link is kept
  });

  it("Estimator returns -> the Rep", async () => {
    const db = world(); const r = (await openEstimatorStage(db))!;
    const n = fresh(db);
    await decide(db as never, EST, r.id, "RETURN", { reason: "check the slat quantity", ...dArgs(r) } as never);
    expect(kinds(since(db, n))).toEqual(["RETURNED_TO_REP>rep@a"]);
    const e = since(db, n).find((x) => x.channel === "EMAIL")!;
    expect(e.body).toContain("/newquip-grower/q1?stage=1"); expect(e.body).toMatch(/Reason: check the slat quantity/);
  });

  it("Manager approves -> the Rep (ready to issue, opens Stage 4) AND the Estimator", async () => {
    const db = world(); await openEstimatorStage(db);
    await decideDocument(db as never, EST, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" });
    const n = fresh(db);
    await decideDocument(db as never, MGR, "QUOTE", "q1", "APPROVE", { stage: "MANAGER" });
    expect(quote(db).state).toBe("MANAGER_APPROVED_FINAL");
    const added = since(db, n);
    expect(kinds(added)).toEqual(["APPROVED>est@a", "APPROVED_FOR_REP>rep@a"]);
    expect(kinds(added, "EMAIL")).toEqual(["APPROVED>est@a", "APPROVED_FOR_REP>rep@a"]);
    const rep = added.find((x) => x.kind === "APPROVED_FOR_REP" && x.channel === "EMAIL")!;
    expect(rep.body).toMatch(/^Quotation NQ-Q-0009 has been approved and is ready to issue to the customer\./);
    expect(rep.body).toContain("/newquip-grower/q1?stage=4"); expect(rep.body).toMatch(/By: mgr@a/); expect(rep.body).toMatch(/Decided: /);
    expect(added.find((x) => x.kind === "APPROVED" && x.channel === "EMAIL")!.body).toContain("stage=3");
  });

  it("Manager returns to the Estimator -> the Estimator (to act) AND the Rep (for information)", async () => {
    const db = world(); await openEstimatorStage(db);
    await decideDocument(db as never, EST, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" });
    const mreq = (await pendingRequestFor(db as never, ORG, "QUOTE", "q1"))!;
    const n = fresh(db);
    await decide(db as never, MGR, mreq.id, "RETURN", { reason: "recheck freight", destination: "ESTIMATOR", ...dArgs(mreq) } as never);
    const added = since(db, n);
    expect(kinds(added)).toEqual(expect.arrayContaining(["RETURNED_TO_ESTIMATOR>est@a", "RETURNED_TO_ESTIMATOR_FOR_REP>rep@a"]));
    const rep = added.find((x) => x.kind === "RETURNED_TO_ESTIMATOR_FOR_REP" && x.channel === "EMAIL")!;
    expect(rep.body).toMatch(/No action needed from you yet/); expect(rep.body).toContain("stage=2");
  });

  it("Manager rejects -> the Rep and the Estimator", async () => {
    const db = world(); await openEstimatorStage(db);
    await decideDocument(db as never, EST, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" });
    const mreq = (await pendingRequestFor(db as never, ORG, "QUOTE", "q1"))!;
    const n = fresh(db);
    await decide(db as never, MGR, mreq.id, "REJECT", { reason: "not viable at this price", ...dArgs(mreq) } as never);
    expect(kinds(since(db, n))).toEqual(["REJECTED>est@a", "REJECTED>rep@a"]);
  });

  it("every notification row is unique per event and recipient, and a repeated decision creates no second notification", async () => {
    const db = world(); await openEstimatorStage(db);
    await decideDocument(db as never, EST, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" });
    const keys = NOTES(db).map((x) => x.dedupe_key);
    expect(new Set(keys).size).toBe(keys.length);
    const n = fresh(db);
    await expect(decideDocument(db as never, EST, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" })).rejects.toThrow();
    expect(fresh(db)).toBe(n);
  });

  it("notifications never carry cost, margin or supplier information", async () => {
    const db = world(); await openEstimatorStage(db);
    await decideDocument(db as never, EST, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" });
    await decideDocument(db as never, MGR, "QUOTE", "q1", "APPROVE", { stage: "MANAGER" });
    for (const row of NOTES(db)) expect(`${row.subject}\n${row.body}`).not.toMatch(/(estimated cost|gross profit|markup|supplier|landed cost|cost price|exchange rate|margin[^.\n]*\d+(\.\d+)?\s?%)/i);
  });
});
