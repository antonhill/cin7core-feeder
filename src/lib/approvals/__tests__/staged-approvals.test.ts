// Staged approvals (migration 0112): quotation = ESTIMATOR stage then MANAGER stage, with named approvers, role checks, return-to-estimator, stale-revision and
// duplicate-decision protection, driven through the REAL quote store and approval store over the in-memory twin of the 0112 functions.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
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
const draft = applyDemoDefaults(emptyDraft()).draft;
const total = Math.round(evaluateDraft(draft, priceCtx).budget!.totals.subtotalExTax * 100);

function world(opts: { strict?: boolean } = {}) {
  const db = new FakeDb();
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
const dArgs = (r: { version: number; digest: string }) => ({ expectedVersion: r.version, expectedDigest: r.digest });
const openEstimatorStage = (db: FakeDb) => resyncQuoteApprovals(db as never, REP, "q1");

beforeEach(() => vi.useRealTimers());

describe("staged availability", () => {
  it("is off until migration 0112 exists, and the Phase H behaviour is then untouched", async () => {
    const db = world(); db.rolesApplied = false;
    expect(await stagedAvailable(db as never)).toBe(false);
    db.rolesApplied = true;
    expect(await stagedAvailable(db as never)).toBe(true);
  });
});

describe("rep -> estimator -> manager", () => {
  it("opens the estimator stage for the estimators only; sign-off opens the manager stage for the managers only; approval seals the baseline; every step is in the history", async () => {
    const db = world();
    const est1 = await openEstimatorStage(db);
    expect(est1).toMatchObject({ stage: "ESTIMATOR", stage_role: "ESTIMATOR", prepared_by_email: "rep@a", originator_email: "rep@a", status: "PENDING", assigned_to_email: null });
    expect(notesTo(db, "est@a", "ESTIMATOR_ASSIGNED")).toHaveLength(1);
    expect(notesTo(db, "est2@a", "ESTIMATOR_ASSIGNED")).toHaveLength(1);
    expect(notesTo(db, "mgr@a")).toHaveLength(0); // not broadcast to managers
    expect(notesTo(db, "rep@a")).toHaveLength(0);

    await decideDocument(db as never, EST, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" });
    expect(quote(db).estimator_signoff_by_email).toBe("est@a");
    expect(quote(db).state).toBe("ESTIMATOR_REVIEW"); // not final yet
    const mgrReq = (await pendingRequestFor(db as never, ORG, "QUOTE", "q1"))!;
    expect(mgrReq).toMatchObject({ stage: "MANAGER", stage_role: "MANAGER", prepared_by_email: "est@a", originator_email: "rep@a" });
    expect(notesTo(db, "mgr@a", "MANAGER_SUBMITTED")).toHaveLength(1);
    expect(notesTo(db, "mgr2@a", "MANAGER_SUBMITTED")).toHaveLength(1);
    expect(notesTo(db, "est@a", "MANAGER_SUBMITTED")).toHaveLength(0);

    const done = await decide(db as never, MGR, mgrReq.id, "APPROVE", dArgs(mgrReq));
    expect(done.status).toBe("APPROVED");
    expect(quote(db).state).toBe("MANAGER_APPROVED_FINAL");
    expect(quote(db).accepted_baseline).toBeTruthy();
    const h = await docHistory(db as never, ORG, "QUOTE", "q1");
    expect(h.map((e) => `${e.stage}:${e.action}`)).toEqual(["ESTIMATOR:SUBMITTED", "ESTIMATOR:APPROVED", "MANAGER:SUBMITTED", "MANAGER:APPROVED"]);
    expect(h.every((e) => !!e.created_at && !!e.actor_email)).toBe(true);
  });

  it("the manager cannot approve until the estimator has signed off this content", async () => {
    const db = world();
    await openEstimatorStage(db);
    await expect(decideDocument(db as never, MGR, "QUOTE", "q1", "APPROVE", { stage: "MANAGER" })).rejects.toThrow(/waiting for estimator review, not manager approval/);
    expect(quote(db).state).toBe("ESTIMATOR_REVIEW");
    // and a manager (no estimator role) cannot sign off in the estimator's place
    await expect(decideDocument(db as never, MGR, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" })).rejects.toThrow(/estimator role/);
    expect(quote(db).estimator_signoff_hash).toBeNull();
  });
});

describe("return routing", () => {
  async function toManagerStage(db: FakeDb) {
    await openEstimatorStage(db);
    await decideDocument(db as never, EST, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" });
    return (await pendingRequestFor(db as never, ORG, "QUOTE", "q1"))!;
  }
  it("a manager returning a quote goes to the ESTIMATOR by default: sign-off withdrawn, quote/revision/confirmation/history kept, estimator re-notified, a new estimator request opens", async () => {
    const db = world();
    const m = await toManagerStage(db);
    const before = { revision: quote(db).revision, confirmed: quote(db).customer_confirmed_cents, hash: quote(db).draft_hash };
    const row = await decide(db as never, MGR, m.id, "RETURN", { ...dArgs(m), reason: "Feeder margin is too thin" });
    expect(row).toMatchObject({ status: "RETURNED", return_destination: "ESTIMATOR", decision_reason: "Feeder margin is too thin" });
    expect(quote(db)).toMatchObject({ state: "ESTIMATOR_REVIEW", estimator_signoff_hash: null, estimator_signoff_by_email: null, revision: before.revision, customer_confirmed_cents: before.confirmed, draft_hash: before.hash });
    const next = (await pendingRequestFor(db as never, ORG, "QUOTE", "q1"))!;
    expect(next).toMatchObject({ stage: "ESTIMATOR", assigned_to_email: "est@a" }); // back to the estimator who signed it off
    expect(notesTo(db, "est@a", "RETURNED_TO_ESTIMATOR")).toHaveLength(1);
    expect(notesTo(db, "rep@a", "RETURNED_TO_ESTIMATOR")).toHaveLength(0);
    // the returned manager request can never be approved afterwards (duplicate/stale protection)
    await expect(decide(db as never, MGR, m.id, "APPROVE", dArgs(m))).rejects.toThrow(/already|changed/);
    // history keeps the destination and the reason
    const ret = (await docHistory(db as never, ORG, "QUOTE", "q1")).find((e) => e.action === "RETURNED")!;
    expect(ret).toMatchObject({ stage: "MANAGER", destination: "ESTIMATOR", reason: "Feeder margin is too thin", actor_email: "mgr@a" });
  });

  it("resubmission acquires the approvals again for the current revision: a new sign-off, then a new manager request", async () => {
    const db = world();
    const m = await toManagerStage(db);
    await decide(db as never, MGR, m.id, "RETURN", { ...dArgs(m), reason: "Re-check the penning quantity" });
    // the manager can not approve in the meantime: nothing is waiting for them
    await expect(decideDocument(db as never, MGR, "QUOTE", "q1", "APPROVE", { stage: "MANAGER" })).rejects.toThrow(/waiting for estimator review/);
    await decideDocument(db as never, EST, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" });
    const again = (await pendingRequestFor(db as never, ORG, "QUOTE", "q1"))!;
    expect(again.stage).toBe("MANAGER");
    expect(again.id).not.toBe(m.id);
    expect(again.revision).toBeGreaterThan(m.revision);
    await decide(db as never, MGR2, again.id, "APPROVE", dArgs(again));
    expect(quote(db).state).toBe("MANAGER_APPROVED_FINAL");
    expect(reqs(db).filter((r) => r.stage === "MANAGER").map((r) => r.status)).toEqual(["RETURNED", "APPROVED"]);
  });

  it("an estimator returns to the REP (a new revision, sign-off and customer confirmation no longer apply); a return needs a reason", async () => {
    const db = world();
    const e = (await openEstimatorStage(db))!;
    await expect(decide(db as never, EST, e.id, "RETURN", { ...dArgs(e), reason: "" })).rejects.toThrow(/reason/);
    const row = await decide(db as never, EST, e.id, "RETURN", { ...dArgs(e), reason: "Customer changed the room count" });
    expect(row).toMatchObject({ status: "RETURNED", return_destination: "PREPARER" });
    expect(quote(db)).toMatchObject({ state: "REP_DRAFT", revision: 2, customer_confirmed_cents: null });
    expect(notesTo(db, "rep@a", "RETURNED_TO_REP")).toHaveLength(1);
  });

  it("only a quotation in manager review can be returned to the estimator", async () => {
    const db = world();
    const e = (await openEstimatorStage(db))!;
    await expect(decide(db as never, EST, e.id, "RETURN", { ...dArgs(e), reason: "x y z", destination: "ESTIMATOR" })).rejects.toThrow(/manager review/);
  });
});

describe("content changes invalidate the right sign-off", () => {
  it("editing a signed-off quote withdraws the sign-off, supersedes the manager request and sends it back to estimator review; the manager's old decision is stale", async () => {
    const db = world();
    await openEstimatorStage(db);
    await decideDocument(db as never, EST, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" });
    const m = (await pendingRequestFor(db as never, ORG, "QUOTE", "q1"))!;
    const edited = structuredClone(draft); edited.customerName = "Renamed Customer";
    const saved = await saveDraft(db as never, ORG, rolesFor("member"), "q1", edited);
    expect(saved.signoffCleared).toBe(true);
    await resyncQuoteApprovals(db as never, EST, "q1", { quiet: true });
    expect((await loadRequest(db as never, ORG, m.id))!.status).toBe("SUPERSEDED");
    expect((await pendingRequestFor(db as never, ORG, "QUOTE", "q1"))!.stage).toBe("ESTIMATOR");
    await expect(decide(db as never, MGR, m.id, "APPROVE", dArgs(m))).rejects.toThrow(/already|changed/);
    expect(quote(db).state).toBe("ESTIMATOR_REVIEW");
  });
});

describe("stale submissions are refused by the application as well as the database", () => {
  it("content re-signed outside the engine leaves the manager's request stale: it cannot be approved, and a wrong version/digest is named as such", async () => {
    const db = world();
    await openEstimatorStage(db);
    await decideDocument(db as never, EST, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" });
    const m = (await pendingRequestFor(db as never, ORG, "QUOTE", "q1"))!;
    // the reviewing manager's screen is older than the request
    await expect(decide(db as never, MGR, m.id, "APPROVE", { expectedVersion: m.version - 1, expectedDigest: m.digest })).rejects.toThrow(/changed while you were reviewing/);
    await expect(decide(db as never, MGR, m.id, "APPROVE", { expectedVersion: m.version, expectedDigest: "0".repeat(64) })).rejects.toThrow(/changed while you were reviewing/);
    // the content changes and is re-signed WITHOUT going through the engine (the quote is signed again, so it would look approvable): the old request is stale
    quote(db).draft_hash = "h2"; quote(db).estimator_signoff_hash = "h2";
    await expect(decide(db as never, MGR, m.id, "APPROVE", dArgs(m))).rejects.toThrow(/changed since it was submitted/);
    expect(quote(db).state).toBe("ESTIMATOR_REVIEW");
  });
});

describe("named approvers, roles and separation of duties", () => {
  it("a policy can name the approver of a stage: only that person may decide, and others must be reassigned first", async () => {
    const db = world();
    await savePolicy(db as never, { canAdminister: true }, "adm@a", { orgId: ORG, docType: "QUOTE", stages: [{ stage: "ESTIMATOR", role: "ESTIMATOR", approverEmail: "est2@a" }, { stage: "MANAGER", role: "MANAGER", approverEmail: "mgr2@a" }] });
    const e = (await openEstimatorStage(db))!;
    expect(e.assigned_to_email).toBe("est2@a");
    expect(notesTo(db, "est2@a", "ESTIMATOR_ASSIGNED")).toHaveLength(1);
    expect(notesTo(db, "est@a")).toHaveLength(0);
    await expect(decide(db as never, EST, e.id, "APPROVE", dArgs(e))).rejects.toThrow(/assigned to est2@a/);
    const moved = await reassign(db as never, MGR, e.id, "est@a", e.version);
    expect(moved.assigned_to_email).toBe("est@a");
    await decide(db as never, EST, e.id, "APPROVE", dArgs(moved));
    const m = (await pendingRequestFor(db as never, ORG, "QUOTE", "q1"))!;
    expect(m.assigned_to_email).toBe("mgr2@a");
    await expect(decide(db as never, MGR, m.id, "APPROVE", dArgs(m))).rejects.toThrow(/assigned to mgr2@a/);
    expect((await decide(db as never, MGR2, m.id, "APPROVE", dArgs(m))).status).toBe("APPROVED");
    const kinds = (await docHistory(db as never, ORG, "QUOTE", "q1")).map((x) => x.action);
    expect(kinds).toContain("REASSIGNED");
    expect(kinds.filter((k) => k === "ASSIGNED")).toHaveLength(2);
  });

  it("a policy cannot name someone who does not hold the stage's role, and reassignment is limited to holders of that role", async () => {
    const db = world();
    await expect(savePolicy(db as never, { canAdminister: true }, "adm@a", { orgId: ORG, docType: "QUOTE", stages: [{ stage: "ESTIMATOR", role: "ESTIMATOR", approverEmail: "rep@a" }, { stage: "MANAGER", role: "MANAGER", approverEmail: null }] })).rejects.toThrow(/does not hold/);
    await expect(savePolicy(db as never, { canAdminister: false }, "rep@a", { orgId: ORG, docType: "QUOTE", stages: [{ stage: "ESTIMATOR", role: "ESTIMATOR", approverEmail: null }, { stage: "MANAGER", role: "MANAGER", approverEmail: null }] })).rejects.toThrow(/Only an administrator/);
    const e = (await openEstimatorStage(db))!;
    await expect(reassign(db as never, MGR, e.id, "mgr@a", e.version)).rejects.toThrow(/Estimator role/);
    await expect(reassign(db as never, REP, e.id, "est@a", e.version)).rejects.toThrow(/Only an administrator/);
  });

  it("the salesperson who handed the quote over cannot sign it off, even holding the estimator role, except as an explicit reasoned administrator override", async () => {
    const db = world();
    db.rows("org_functional_roles").push({ id: "r-rep-est", org_id: ORG, user_id: "u-rep", user_email: "rep@a", role: "ESTIMATOR", assigned_by_email: "adm@a", assigned_at: "t" });
    const e = (await openEstimatorStage(db))!;
    await expect(decide(db as never, REP, e.id, "APPROVE", dArgs(e))).rejects.toThrow(/cannot approve/);
    expect(quote(db).estimator_signoff_hash).toBeNull();
  });

  it("an administrator override at the estimator stage is recorded as an override and does NOT stand in for the manager's sign-off", async () => {
    const db = world({ strict: true });
    // adm holds only ADMINISTRATOR (strict roles): no estimator or manager role
    const e = (await openEstimatorStage(db))!;
    await expect(decide(db as never, ADM, e.id, "APPROVE", dArgs(e))).rejects.toThrow(/override/i);
    await expect(decide(db as never, ADM, e.id, "APPROVE", { ...dArgs(e), override: true, reason: "short" })).rejects.toThrow(/written reason/);
    const row = await decide(db as never, ADM, e.id, "APPROVE", { ...dArgs(e), override: true, reason: "Estimators are unavailable until Monday" });
    expect(row.admin_override).toBe(true);
    const m = (await pendingRequestFor(db as never, ORG, "QUOTE", "q1"))!;
    expect(m).toMatchObject({ stage: "MANAGER", status: "PENDING" }); // the manager stage still needs its own decision
    expect(quote(db).state).toBe("ESTIMATOR_REVIEW");
    // the same administrator would need a second, separate, reasoned override at the manager stage; and the estimator who signed (adm) is the preparer of that stage
    await expect(decide(db as never, ADM, m.id, "APPROVE", dArgs(m))).rejects.toThrow(/override/i);
    const fin = await decide(db as never, ADM, m.id, "APPROVE", { ...dArgs(m), override: true, reason: "Sole administrator approving during the demonstration" });
    expect(fin.admin_override).toBe(true);
    const h = await docHistory(db as never, ORG, "QUOTE", "q1");
    expect(h.filter((x) => x.action === "OVERRIDE_APPROVED").map((x) => x.stage)).toEqual(["ESTIMATOR", "MANAGER"]); // two distinct, separately recorded overrides
  });

  it("strict roles: a plain tier member with no explicit role cannot sign off, and a user with no roles holds none", async () => {
    const db = world({ strict: true });
    db.rows("org_members").push({ org_id: ORG, user_id: "u-nobody", role: "member" });
    EMAILS["u-nobody"] = "nobody@a";
    expect([...(await resolveRoles(db as never, ORG, "u-nobody", false))]).toEqual([]);
    const e = (await openEstimatorStage(db))!;
    await expect(decide(db as never, ctxOf("u-nobody", "nobody@a"), e.id, "APPROVE", dArgs(e))).rejects.toThrow(/estimator role/);
    delete EMAILS["u-nobody"];
  });

  it("without strict roles a user with no explicit role keeps the Phase H tier behaviour (member = estimator, admin = manager)", async () => {
    const db = world();
    db.rows("org_members").push({ org_id: ORG, user_id: "u-legacy", role: "member" });
    expect([...(await resolveRoles(db as never, ORG, "u-legacy", false))].sort()).toEqual(["ESTIMATOR", "REP"]);
    expect((await resolveRoles(db as never, ORG, "u-legacy", true)).has("MANAGER")).toBe(true);
  });
});

describe("duplicate decisions and organisation isolation", () => {
  it("the same decision twice, or two managers racing, records exactly one decision", async () => {
    const db = world();
    await openEstimatorStage(db);
    await decideDocument(db as never, EST, "QUOTE", "q1", "APPROVE", { stage: "ESTIMATOR" });
    const m = (await pendingRequestFor(db as never, ORG, "QUOTE", "q1"))!;
    const results = await Promise.allSettled([decide(db as never, MGR, m.id, "APPROVE", dArgs(m)), decide(db as never, MGR2, m.id, "APPROVE", dArgs(m))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(reqs(db).filter((r) => r.stage === "MANAGER" && r.status === "APPROVED")).toHaveLength(1);
    await expect(decide(db as never, MGR, m.id, "APPROVE", dArgs(m))).rejects.toThrow(/already|changed/);
  });

  it("another organisation can neither read, decide nor reassign these requests", async () => {
    const db = world();
    const e = (await openEstimatorStage(db))!;
    const foreign = { ...EST, orgId: "org-other" };
    await expect(decide(db as never, foreign, e.id, "APPROVE", dArgs(e))).rejects.toThrow(/not found/);
    expect(await listRequests(db as never, "org-other")).toEqual([]);
    expect(await assignRole(db as never, { canAdminister: true }, "adm@a", { orgId: ORG, userId: "u-rep", role: "MANAGER" })).toBe(true);
  });
});

describe("overdue reminders follow the stage", () => {
  it("an overdue estimator-stage request reminds the estimators, not the managers; a named approver is reminded alone; nothing is ever decided by lateness", async () => {
    const db = world();
    const e = (await openEstimatorStage(db))!;
    const late = new Date(new Date(e.due_at!).getTime() + 3_600_000).toISOString();
    expect((await sendOverdueReminders(db as never, late, "https://toolbox.example")).reminded).toBe(1);
    expect(notesTo(db, "est@a", "OVERDUE-1")).toHaveLength(1);
    expect(notesTo(db, "est2@a", "OVERDUE-1")).toHaveLength(1);
    expect(notesTo(db, "mgr@a", "OVERDUE-1")).toHaveLength(0);
    expect((await loadRequest(db as never, ORG, e.id))!.status).toBe("PENDING");
    // a second sweep inside the cadence sends nothing more
    const sentAt = (await loadRequest(db as never, ORG, e.id))!.last_reminder_at!;
    expect((await sendOverdueReminders(db as never, new Date(new Date(sentAt).getTime() + 3_600_000).toISOString())).reminded).toBe(0);
  });
});

describe("role administration", () => {
  it("only an administrator assigns or removes roles; every change is in an immutable history; a non-member cannot be given a role", async () => {
    const db = world();
    await expect(assignRole(db as never, { canAdminister: false }, "rep@a", { orgId: ORG, userId: "u-rep", role: "MANAGER" })).rejects.toThrow(/Only an administrator/);
    expect(await assignRole(db as never, { canAdminister: true }, "adm@a", { orgId: ORG, userId: "u-rep", role: "PROCUREMENT" })).toBe(true);
    expect(await assignRole(db as never, { canAdminister: true }, "adm@a", { orgId: ORG, userId: "u-rep", role: "PROCUREMENT" })).toBe(false);
    expect(await removeRole(db as never, { canAdminister: true }, "adm@a", { orgId: ORG, userId: "u-rep", role: "PROCUREMENT" })).toBe(true);
    expect((db.rows("org_functional_role_events") as Array<{ action: string }>).map((e) => e.action)).toEqual(["ASSIGNED", "REMOVED"]);
    EMAILS["u-ghost"] = "ghost@x";
    await expect(assignRole(db as never, { canAdminister: true }, "adm@a", { orgId: ORG, userId: "u-ghost", role: "MANAGER" })).rejects.toThrow(/not a member/);
    delete EMAILS["u-ghost"];
    expect((await listAssignments(db as never, ORG))!.some((a) => a.role === "PROCUREMENT")).toBe(false);
  });
});
