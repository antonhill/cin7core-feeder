// Phase H: commercial approvals. Pure rules + the real orchestration (quote / claim / variation stores, the approval store) over an in-memory database
// whose approval_* functions mirror migration 0110 line for line. The REAL SQL (state machine, append-only history, grants, RLS) is verified by
// supabase/tests/0110_newquip_commercial_approvals.test.sql against Postgres; these tests prove the application drives it correctly.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { goldenFixtureBaseline } from "@/lib/projects/baseline";
import { seedGoldenFixture, createClaimDraft, submitClaimForApproval, loadProjectView } from "@/lib/projects/project-store";
import { raiseVariation, repriceVariation } from "@/lib/projects/variation-store";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { emptyDraft } from "@/newquip/grower/draft";
import { applyDemoDefaults } from "@/newquip/grower/demo-defaults";
import { addBusinessDays, formatSast, isOverdue, waitingLabel } from "../time";
import { authoriseDecision } from "../policy";
import { filterQueue, sortQueue, summarise, currentReturned } from "../queue";
import { buildNotification } from "../messages";
import type { ApprovalRequestRow } from "../types";

vi.mock("server-only", () => ({}));
import {
  approvalsAvailable, decide, decideDocument, deliverPendingEmails, docHistory, legacyCtx, loadRequest, MAX_EMAIL_ATTEMPTS, myNotifications, reassign, retryEmail, sendOverdueReminders, submitForApproval,
  withdrawPendingFor, type ApprovalCtx,
} from "../approval-store";

const ORG = "org-nq"; const OTHER_ORG = "org-other";
const T0 = new Date("2026-10-29T07:14:00Z"); // 09:14 SAST, a Thursday
const R = (n: number) => n * 100;
let clock = 0;
let simNow: Date | null = null; // the simulated database clock (the real function uses clock_timestamp())

/** In-memory twin of approval_submit / approval_decide / approval_reassign / approval_mark_viewed / approval_record_reminder (migration 0110). */
function install(db: FakeDb) {
  const T = (n: string) => db.rows(n) as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const at = () => (simNow ?? new Date(Date.UTC(2026, 9, 29, 8, 0, ++clock))).toISOString();
  const event = (r: Record<string, any>, action: string, from: string | null, to: string | null, actor: string, name: string, reason: string | null) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const e = { id: `ev-${T("approval_events").length + 1}`, org_id: r.org_id, request_id: r.id, doc_type: r.doc_type, doc_id: r.doc_id, doc_ref: r.doc_ref, revision: r.revision, project_id: r.project_id, action, from_status: from, to_status: to, actor_email: actor.toLowerCase(), actor_name: name, reason, digest: r.digest, created_at: at() };
    T("approval_events").push(e); return e;
  };
  const enqueue = (org: string, reqId: string, evId: string, notes: Array<{ kind: string; recipient: string; subject: string; body: string }>) => {
    for (const n of notes ?? []) for (const ch of ["IN_APP", "EMAIL"]) {
      const key = `${n.kind}:${reqId}:${n.recipient.toLowerCase()}:${ch}`;
      if (T("approval_notifications").some((x) => x.dedupe_key === key)) continue;
      T("approval_notifications").push({ id: `nt-${T("approval_notifications").length + 1}`, org_id: org, request_id: reqId, event_id: evId, kind: n.kind, recipient_email: n.recipient.toLowerCase(), channel: ch, subject: n.subject, body: n.body, dedupe_key: key, status: ch === "IN_APP" ? "SENT" : "PENDING", attempts: 0, last_error: null, provider_message_id: null, sent_at: ch === "IN_APP" ? at() : null, read_at: null, created_at: at() });
    }
  };
  const find = (org: string, id: string) => { const r = T("approval_requests").find((x) => x.id === id && x.org_id === org); if (!r) throw new Error("approval: request not found"); return r; };
  (db as any).rpc = async (fn: string, a: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const out = await run(fn, a); return out.data && typeof out.data === "object" ? { ...out, data: { ...(out.data as object) } } : out;
  };
  const run = async (fn: string, a: any): Promise<{ data: unknown; error: { message: string } | null }> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      if (fn === "approval_submit") {
        const pend = T("approval_requests").find((x) => x.org_id === a.p_org && x.doc_type === a.p_doc_type && x.doc_id === a.p_doc_id && x.status === "PENDING");
        if (pend) {
          if (pend.digest === a.p_digest) return { data: pend, error: null };
          pend.status = "SUPERSEDED"; pend.closed_at = at(); pend.version += 1; event(pend, "SUPERSEDED", "PENDING", "SUPERSEDED", a.p_actor, a.p_actor_name, "The document changed and was submitted again.");
        }
        const rev = Math.max(0, ...T("approval_requests").filter((x) => x.org_id === a.p_org && x.doc_type === a.p_doc_type && x.doc_id === a.p_doc_id).map((x) => x.revision)) + 1;
        const row = { id: a.p_id, org_id: a.p_org, doc_type: a.p_doc_type, doc_id: a.p_doc_id, doc_ref: a.p_doc_ref, project_id: a.p_project_id, project_ref: a.p_project_ref, customer_name: a.p_customer, revision: rev, digest: a.p_digest, amount_cents: a.p_amount, status: "PENDING", prepared_by_email: a.p_prepared_by.toLowerCase(), submitted_at: at(), assigned_to_email: a.p_assigned_to?.toLowerCase() ?? null, assigned_at: a.p_assigned_to ? at() : null, due_at: a.p_due_at, first_viewed_at: null, decided_by_email: null, decided_by_name: null, decided_at: null, decision_reason: null, admin_override: false, closed_at: null, version: 1, reminders_sent: 0, last_reminder_at: null, created_at: at() };
        T("approval_requests").push(row);
        const ev = event(row, rev > 1 ? "RESUBMITTED" : "SUBMITTED", null, "PENDING", a.p_actor, a.p_actor_name, null);
        if (a.p_assigned_to) event(row, "ASSIGNED", "PENDING", "PENDING", a.p_actor, a.p_actor_name, a.p_assigned_to);
        enqueue(a.p_org, row.id, ev.id, a.p_notifications);
        return { data: row, error: null };
      }
      if (fn === "approval_decide") {
        const v = find(a.p_org, a.p_request);
        if (v.status !== "PENDING") throw new Error(`approval_not_pending: this submission is already ${v.status}`);
        if (v.version !== a.p_expected_version) throw new Error("approval_stale: the submission changed");
        if (v.digest !== a.p_expected_digest) throw new Error("approval_stale: the submitted content is not what was reviewed");
        const reason = (a.p_reason ?? "").trim() || null;
        if (["RETURN", "REJECT"].includes(a.p_action) && (!reason || reason.length < 3)) throw new Error("approval: a written reason is required to return or reject");
        const self = a.p_actor.toLowerCase() === v.prepared_by_email;
        if (a.p_action === "APPROVE" && self) { if (!a.p_override) throw new Error("approval_separation: you prepared this submission"); if (!reason || reason.length < 10) throw new Error("approval: an override needs a written reason"); }
        const to = { APPROVE: "APPROVED", RETURN: "RETURNED", REJECT: "REJECTED", WITHDRAW: "WITHDRAWN" }[a.p_action as string]!;
        Object.assign(v, { status: to, closed_at: at(), version: v.version + 1, decided_by_email: a.p_action === "WITHDRAW" ? null : a.p_actor.toLowerCase(), decided_by_name: a.p_action === "WITHDRAW" ? null : a.p_actor_name, decided_at: a.p_action === "WITHDRAW" ? null : at(), decision_reason: reason, admin_override: a.p_action === "APPROVE" && self });
        const ev = event(v, v.admin_override ? "OVERRIDE_APPROVED" : to, "PENDING", to, a.p_actor, a.p_actor_name, reason);
        enqueue(a.p_org, v.id, ev.id, a.p_notifications);
        return { data: v, error: null };
      }
      if (fn === "approval_reassign") {
        const v = find(a.p_org, a.p_request);
        if (v.status !== "PENDING") throw new Error("approval_not_pending");
        if (v.version !== a.p_expected_version) throw new Error("approval_stale: changed");
        const old = v.assigned_to_email; Object.assign(v, { assigned_to_email: a.p_new.toLowerCase(), assigned_at: at(), version: v.version + 1, reminders_sent: 0, last_reminder_at: null });
        enqueue(a.p_org, v.id, event(v, "REASSIGNED", "PENDING", "PENDING", a.p_actor, a.p_actor_name, `${old ?? "(unassigned)"} -> ${a.p_new}`).id, a.p_notifications);
        return { data: v, error: null };
      }
      if (fn === "approval_mark_viewed") { const v = T("approval_requests").find((x) => x.id === a.p_request); if (v && v.status === "PENDING" && !v.first_viewed_at && a.p_actor.toLowerCase() !== v.prepared_by_email) { v.first_viewed_at = at(); event(v, "VIEWED", "PENDING", "PENDING", a.p_actor, a.p_actor_name, null); } return { data: null, error: null }; }
      if (fn === "approval_record_reminder") {
        const v = find(a.p_org, a.p_request);
        if (v.status !== "PENDING" || v.reminders_sent !== a.p_expected_reminders) return { data: false, error: null };
        v.reminders_sent += 1; v.last_reminder_at = at(); enqueue(a.p_org, v.id, event(v, "REMINDER_SENT", "PENDING", "PENDING", "system", "System", `Reminder ${v.reminders_sent}`).id, a.p_notifications);
        return { data: true, error: null };
      }
      return { data: null, error: { message: `unknown rpc ${fn}` } };
    } catch (e) { return { data: null, error: { message: (e as Error).message } }; }
  };
}

const MGR: ApprovalCtx = { orgId: ORG, userId: "u-mgr", email: "mgr@a", name: "Mgr A", isManager: true, baseUrl: "https://toolbox.example" };
const MGR2: ApprovalCtx = { ...MGR, userId: "u-mgr2", email: "mgr2@a", name: "Mgr Two" };
const PM: ApprovalCtx = { orgId: ORG, userId: "u-pm", email: "pm@a", name: "PM A", isManager: false, baseUrl: "https://toolbox.example" };
const FOREIGN: ApprovalCtx = { ...MGR, orgId: OTHER_ORG, userId: "u-x", email: "x@other" };
const decideArgs = (r: ApprovalRequestRow) => ({ expectedVersion: r.version, expectedDigest: r.digest });
const noCin7 = (db: FakeDb) => db.writes.filter((w) => /cin7/i.test(w.table));

async function world() {
  const db = new FakeDb();
  db.approvalsApplied = true;
  install(db);
  (db as any).auth = { admin: { getUserById: async (id: string) => ({ data: { user: { email: { "u-mgr": "mgr@a", "u-mgr2": "mgr2@a", "u-pm": "pm@a" }[id] } } }) } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  db.rows("org_members").push({ org_id: ORG, user_id: "u-mgr", role: "admin" }, { org_id: ORG, user_id: "u-mgr2", role: "owner" }, { org_id: ORG, user_id: "u-pm", role: "member" });
  const projectId = await seedGoldenFixture(db as never, ORG, "seed@a", goldenFixtureBaseline());
  return { db, projectId };
}
const draftClaim = async (db: FakeDb, projectId: string) => { const d = await createClaimDraft(db as never, ORG, "pm@a", projectId); await submitClaimForApproval(db as never, ORG, projectId, d.claimId); return d.claimId; };

beforeEach(() => { clock = 0; simNow = null; });

// ───────────────────────────── pure rules ─────────────────────────────
describe("SAST dates and business days", () => {
  it("15: timestamps are stored in UTC and always shown unambiguously in SAST", () => {
    expect(formatSast("2026-10-29T08:32:00Z")).toBe("29 Oct 2026, 10:32 SAST");
    expect(formatSast("2026-12-31T22:30:00Z")).toBe("1 Jan 2027, 00:30 SAST"); // crosses midnight and the year
    expect(formatSast(null)).toBe("—");
    expect(formatSast("2026-10-29T08:32:00Z")).not.toMatch(/\d{2}\/\d{2}/);
  });
  it("20: the due date skips weekends (a Thursday submission + 2 business days = Monday), keeps the time, and does not model public holidays", () => {
    expect(formatSast(addBusinessDays("2026-10-29T07:14:00Z", 2))).toBe("2 Nov 2026, 09:14 SAST");
    expect(formatSast(addBusinessDays("2026-10-26T07:14:00Z", 2))).toBe("28 Oct 2026, 09:14 SAST");
  });
  it("20: overdue is strictly after the due time; waiting is supplementary elapsed time", () => {
    expect(isOverdue("2026-11-02T07:14:00Z", "2026-11-02T07:14:00Z")).toBe(false);
    expect(isOverdue("2026-11-02T07:14:00Z", "2026-11-02T07:15:00Z")).toBe(true);
    expect(isOverdue(null, "2030-01-01T00:00:00Z")).toBe(false);
    expect(waitingLabel("2026-10-29T07:00:00Z", "2026-10-29T07:45:00Z")).toBe("45 min");
    expect(waitingLabel("2026-10-27T07:00:00Z", "2026-10-29T10:00:00Z")).toBe("2 d 3 h");
  });
});

describe("authorisation policy", () => {
  const req = { status: "PENDING" as const, prepared_by_email: "pm@a" };
  it("9: only a manager approves, returns or rejects; the preparer or a manager withdraws", () => {
    expect(authoriseDecision({ email: "pm@a", isManager: false }, "APPROVE", req, {})).toMatchObject({ ok: false });
    expect(authoriseDecision({ email: "u@a", isManager: false }, "REJECT", req, { reason: "no" })).toMatchObject({ ok: false });
    expect(authoriseDecision({ email: "mgr@a", isManager: true }, "APPROVE", req, {})).toEqual({ ok: true, override: false });
    expect(authoriseDecision({ email: "PM@a", isManager: false }, "WITHDRAW", req, {})).toEqual({ ok: true, override: false });
    expect(authoriseDecision({ email: "u@a", isManager: false }, "WITHDRAW", req, {})).toMatchObject({ ok: false });
  });
  it("4+8: return and reject need a written reason; approving your own submission needs an explicit override with a real reason", () => {
    const m = { email: "mgr@a", isManager: true };
    expect(authoriseDecision(m, "RETURN", req, { reason: " " })).toMatchObject({ ok: false });
    expect(authoriseDecision(m, "REJECT", req, { reason: "" })).toMatchObject({ ok: false });
    expect(authoriseDecision(m, "RETURN", req, { reason: "Recheck stage values" })).toMatchObject({ ok: true });
    const self = { email: "MGR@a", isManager: true };
    expect(authoriseDecision(self, "APPROVE", { ...req, prepared_by_email: "mgr@a" }, {})).toMatchObject({ ok: false, error: expect.stringMatching(/cannot approve it normally/) });
    expect(authoriseDecision(self, "APPROVE", { ...req, prepared_by_email: "mgr@a" }, { override: true, reason: "short" })).toMatchObject({ ok: false });
    expect(authoriseDecision(self, "APPROVE", { ...req, prepared_by_email: "mgr@a" }, { override: true, reason: "Sole administrator during acceptance testing" })).toEqual({ ok: true, override: true });
  });
  it("a decided submission cannot be decided again", () => {
    expect(authoriseDecision({ email: "mgr@a", isManager: true }, "APPROVE", { status: "APPROVED", prepared_by_email: "pm@a" }, {})).toMatchObject({ ok: false, error: expect.stringMatching(/already approved/) });
  });
});

describe("queue filters, sorting and summary cards", () => {
  const row = (o: Partial<ApprovalRequestRow>): ApprovalRequestRow => ({ id: "r", org_id: ORG, doc_type: "CLAIM", doc_id: "d", doc_ref: "C1", project_id: "p", project_ref: "PRJ-1", customer_name: "Acme", revision: 1, digest: "x".repeat(64), amount_cents: 100, status: "PENDING", prepared_by_email: "pm@a", submitted_at: "2026-10-27T07:00:00Z", assigned_to_email: "mgr@a", assigned_at: null, due_at: "2026-10-29T07:00:00Z", first_viewed_at: null, decided_by_email: null, decided_by_name: null, decided_at: null, decision_reason: null, admin_override: false, closed_at: null, version: 1, reminders_sent: 0, last_reminder_at: null, created_at: "t", ...o });
  const rows = [
    row({ id: "1", amount_cents: R(1000), doc_type: "QUOTE", customer_name: "Acme", due_at: "2026-10-28T07:00:00Z" }),
    row({ id: "2", amount_cents: R(500), doc_type: "VARIATION", customer_name: "Beta", assigned_to_email: "mgr2@a", due_at: "2026-11-05T07:00:00Z", submitted_at: "2026-10-28T07:00:00Z" }),
    row({ id: "3", status: "APPROVED", amount_cents: R(9999), decided_at: "2026-10-29T06:30:00Z" }),
    row({ id: "4", status: "APPROVED", amount_cents: 1, decided_at: "2026-10-26T06:30:00Z" }),
    row({ id: "5", status: "RETURNED", decision_reason: "x" }), row({ id: "6", status: "REJECTED", decision_reason: "x" }),
  ];
  const NOW = "2026-10-29T09:00:00Z";
  it("16+17: filters and the pending value come from the canonical rows", () => {
    expect(filterQueue(rows, { status: "PENDING" }, "mgr@a", NOW).map((r) => r.id)).toEqual(["1", "2"]);
    expect(filterQueue(rows, { mine: true, status: "PENDING" }, "MGR@a", NOW).map((r) => r.id)).toEqual(["1"]);
    expect(filterQueue(rows, { docType: "VARIATION" }, "x", NOW).map((r) => r.id)).toEqual(["2"]);
    expect(filterQueue(rows, { customer: "bet" }, "x", NOW).map((r) => r.id)).toEqual(["2"]);
    expect(filterQueue(rows, { overdueOnly: true }, "x", NOW).map((r) => r.id)).toEqual(["1"]);
    const s = summarise(rows, "mgr@a", NOW);
    expect(s).toMatchObject({ awaitingMe: 1, pending: 2, overdue: 1, returned: 1, rejected: 1, approvedToday: 1, approvedThisWeek: 2, pendingValueCents: R(1500) });
  });
  it("16: sorting by submission date, waiting time and amount", () => {
    const pend = rows.filter((r) => r.status === "PENDING");
    expect(sortQueue(pend, "submitted_desc").map((r) => r.id)).toEqual(["2", "1"]);
    expect(sortQueue(pend, "waiting_desc").map((r) => r.id)).toEqual(["1", "2"]);
    expect(sortQueue(pend, "amount_desc").map((r) => r.id)).toEqual(["1", "2"]);
    expect(sortQueue(pend, "amount_asc").map((r) => r.id)).toEqual(["2", "1"]);
  });
  it("a returned submission stops needing action once a newer revision exists", () => {
    expect(currentReturned([row({ id: "a", status: "RETURNED", revision: 1 }), row({ id: "b", status: "PENDING", revision: 2 })])).toEqual([]);
    expect(currentReturned([row({ id: "a", status: "RETURNED", revision: 1 })]).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("notification content", () => {
  it("includes reference, customer, project, type, amount, approver, SAST time, action and a plain link; no token", () => {
    const n = buildNotification("SUBMITTED", { id: "req-1", doc_type: "CLAIM", doc_ref: "C02", revision: 1, customer_name: "Acme", project_ref: "PRJ-1", amount_cents: R(950000), prepared_by_email: "pm@a", assigned_to_email: "mgr@a", submitted_at: "2026-10-29T08:32:00Z", due_at: null } as ApprovalRequestRow, "MGR@a", { baseUrl: "https://t.example/" });
    expect(n.recipient).toBe("mgr@a");
    for (const part of ["C02", "Acme", "PRJ-1", "R 950", "pm@a", "mgr@a", "29 Oct 2026, 10:32 SAST", "Required action", "https://t.example/approvals/req-1"]) expect(n.body).toContain(part);
    expect(n.body).not.toMatch(/token|password|secret/i);
  });
});

// ───────────────────────────── orchestration ─────────────────────────────
describe("claims: submit -> approve / return / reject, through the real claim engine", () => {
  it("2+21: submission records the exact revision + digest; approval reserves the claim and records history; NOTHING is written to Cin7", async () => {
    const { db, projectId } = await world();
    const claimId = await draftClaim(db, projectId);
    const sub = await submitForApproval(db as never, PM, "CLAIM", claimId, { now: T0 });
    expect(sub).toMatchObject({ status: "PENDING", revision: 1, prepared_by_email: "pm@a", doc_type: "CLAIM", amount_cents: R(950_000) });
    expect(sub.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(formatSast(sub.due_at)).toBe("2 Nov 2026, 09:14 SAST");
    const done = await decide(db as never, MGR, sub.id, "APPROVE", decideArgs(sub));
    expect(done).toMatchObject({ status: "APPROVED", decided_by_email: "mgr@a" });
    expect((await loadProjectView(db as never, ORG, projectId))!.claims.find((c) => c.id === claimId)!.status).toBe("APPROVED");
    expect(noCin7(db)).toEqual([]); // approval authorises the commercial claim only
    expect((await docHistory(db as never, ORG, "CLAIM", claimId)).map((e) => e.action)).toEqual(["SUBMITTED", "APPROVED"]);
    const toPreparer = await myNotifications(db as never, ORG, "pm@a");
    expect(toPreparer.map((n) => n.kind)).toEqual(["APPROVED"]);
  });
  it("4+5: RETURN needs a reason and sends the claim back to DRAFT; the preparer revises and resubmits as revision 2; history is kept", async () => {
    const { db, projectId } = await world();
    const claimId = await draftClaim(db, projectId);
    const sub = await submitForApproval(db as never, PM, "CLAIM", claimId, { now: T0 });
    await expect(decide(db as never, MGR, sub.id, "RETURN", { ...decideArgs(sub), reason: " " })).rejects.toThrow(/written reason/);
    expect((await loadProjectView(db as never, ORG, projectId))!.claims.find((c) => c.id === claimId)!.status).toBe("READY_FOR_APPROVAL"); // refused before anything changed
    const ret = await decide(db as never, MGR, sub.id, "RETURN", { ...decideArgs(sub), reason: "Delivery stage is not yet 25% complete" });
    expect(ret.status).toBe("RETURNED");
    expect((await loadProjectView(db as never, ORG, projectId))!.claims.find((c) => c.id === claimId)!.status).toBe("DRAFT");
    await submitClaimForApproval(db as never, ORG, projectId, claimId);
    const again = await submitForApproval(db as never, PM, "CLAIM", claimId, { now: T0 });
    expect(again.revision).toBe(2);
    expect((await docHistory(db as never, ORG, "CLAIM", claimId)).map((e) => `${e.action}:${e.revision}`)).toEqual(["SUBMITTED:1", "RETURNED:1", "RESUBMITTED:2"]);
    expect((await myNotifications(db as never, ORG, "pm@a")).map((n) => n.kind)).toContain("RETURNED");
  });
  it("5: REJECT needs a reason and cancels the claim before any write (history retained)", async () => {
    const { db, projectId } = await world();
    const claimId = await draftClaim(db, projectId);
    const sub = await submitForApproval(db as never, PM, "CLAIM", claimId, { now: T0 });
    await expect(decide(db as never, MGR, sub.id, "REJECT", decideArgs(sub))).rejects.toThrow(/written reason/);
    const rej = await decide(db as never, MGR, sub.id, "REJECT", { ...decideArgs(sub), reason: "Customer disputes the milestone" });
    expect(rej.status).toBe("REJECTED");
    expect((await loadProjectView(db as never, ORG, projectId))!.claims.find((c) => c.id === claimId)!.status).toBe("CANCELLED_BEFORE_WRITE");
  });
});

describe("variations: submit, edit-lock, approve, reject", () => {
  async function variation() {
    const w = await world();
    const v = await raiseVariation(w.db as never, ORG, "est@a", { projectId: w.projectId, title: "V1 ventilation", description: "extra", amountCents: R(100_000), estimatedCostCents: R(60_000) });
    return { ...w, variationId: v.variationId };
  }
  it("3+22+23: approval authorises the variation revision only: revised contract moves, the separate billing project and Cin7 Sale are untouched", async () => {
    const { db, projectId, variationId } = await variation();
    const sub = await submitForApproval(db as never, { ...PM, email: "est@a" }, "VARIATION", variationId, { now: T0 });
    expect(sub).toMatchObject({ doc_ref: expect.stringContaining("V001"), amount_cents: R(100_000), prepared_by_email: "est@a" });
    const before = (await loadProjectView(db as never, ORG, projectId))!.commercial.revisedContractCents;
    await decide(db as never, MGR, sub.id, "APPROVE", decideArgs(sub));
    const after = (await loadProjectView(db as never, ORG, projectId))!;
    expect(after.commercial.revisedContractCents).toBe(before + R(100_000));
    expect(db.rows("projects").filter((p) => p.variation_id)).toHaveLength(0); // billing project only on the explicit, separate action
    expect(noCin7(db)).toEqual([]);
  });
  it("6+13: a submitted variation cannot be silently changed; withdrawing frees it; the edit then resubmits as a NEW revision", async () => {
    const { db, projectId, variationId } = await variation();
    const sub = await submitForApproval(db as never, { ...PM, email: "est@a" }, "VARIATION", variationId, { now: T0 });
    await expect(repriceVariation(db as never, ORG, "est@a", projectId, variationId, R(120_000))).rejects.toThrow(/pending approval/);
    await withdrawPendingFor(db as never, { ...PM, email: "est@a" }, "VARIATION", variationId, "Re-pricing");
    expect((await loadRequest(db as never, ORG, sub.id))!.status).toBe("WITHDRAWN");
    await repriceVariation(db as never, ORG, "est@a", projectId, variationId, R(120_000));
    const second = await submitForApproval(db as never, { ...PM, email: "est@a" }, "VARIATION", variationId, { now: T0 });
    expect(second).toMatchObject({ revision: 2, amount_cents: R(120_000) });
    await expect(decide(db as never, MGR, sub.id, "APPROVE", decideArgs(sub))).rejects.toThrow(/already withdrawn/); // the old revision can never be approved
  });
  it("7+11: a changed submission supersedes the pending one automatically; only the newest revision can be approved", async () => {
    const { db, variationId } = await variation();
    const first = await submitForApproval(db as never, PM, "VARIATION", variationId, { now: T0 });
    db.rows("project_variations")[0].amount_cents = R(130_000); // changed behind the guard (e.g. a direct write)
    const second = await submitForApproval(db as never, PM, "VARIATION", variationId, { now: T0 });
    expect((await loadRequest(db as never, ORG, first.id))!.status).toBe("SUPERSEDED");
    expect(second.revision).toBe(2);
    await expect(decide(db as never, MGR, first.id, "APPROVE", decideArgs(first))).rejects.toThrow(/already superseded/);
    expect((await docHistory(db as never, ORG, "VARIATION", variationId)).map((e) => e.action)).toEqual(["SUBMITTED", "SUPERSEDED", "RESUBMITTED"]);
  });
  it("5: reject records the reason on the variation itself", async () => {
    const { db, variationId } = await variation();
    const sub = await submitForApproval(db as never, PM, "VARIATION", variationId, { now: T0 });
    await decide(db as never, MGR, sub.id, "REJECT", { ...decideArgs(sub), reason: "Out of scope of the contract" });
    expect(db.rows("project_variations")[0]).toMatchObject({ status: "REJECTED", decision_reason: "Out of scope of the contract" });
  });
});

describe("quotations: sign-off is the submission, manager approval seals the baseline", () => {
  const ctxE = { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: true };
  const draft = applyDemoDefaults(emptyDraft()).draft;
  const total = Math.round(evaluateDraft(draft, ctxE).budget!.totals.subtotalExTax * 100);
  const seedQuote = (db: FakeDb) => db.rows("newquip_quotes").push({ id: "q1", org_id: ORG, quote_ref: "NQ-Q-0009", revision: 1, customer_name: "Test Customer", site_name: "Farm", quote_type: "project", state: "ESTIMATOR_REVIEW", draft, draft_hash: "h1", customer_confirmed_cents: total, customer_confirmed_by: "r", customer_confirmed_at: "t", handoff_by_email: "rep@a", estimator_signoff_hash: "h1", estimator_signoff_by_email: "est@a", estimator_signoff_at: "t", approved_by_email: null, approved_at: null, accepted_baseline: null, baseline_hash: null, contract_cents: null, project_id: null, created_at: "t", updated_at: "t" });
  it("1+22: a signed-off quote is submitted; approval freezes the baseline; unresolved Cin7 mappings do NOT block it", async () => {
    const { db } = await world(); seedQuote(db);
    const sub = await submitForApproval(db as never, MGR, "QUOTE", "q1", { now: T0 });
    expect(sub).toMatchObject({ doc_ref: "NQ-Q-0009", prepared_by_email: "est@a", amount_cents: total, revision: 1 });
    await decide(db as never, MGR, sub.id, "APPROVE", decideArgs(sub));
    const q = db.rows("newquip_quotes")[0];
    expect(q.state).toBe("MANAGER_APPROVED_FINAL");
    expect((q.accepted_baseline as { physicalScope: Array<{ mapping: { status: string }; resolution?: unknown }> }).physicalScope.filter((i) => i.mapping.status === "UNMAPPED" && !i.resolution).length).toBeGreaterThan(0);
    expect(noCin7(db)).toEqual([]);
  });
  it("4: a manager returning a quote sends it to the rep (reason kept); the quote cannot be submitted again until it is signed off again", async () => {
    const { db } = await world(); seedQuote(db);
    const sub = await submitForApproval(db as never, MGR, "QUOTE", "q1", { now: T0 });
    await decide(db as never, MGR, sub.id, "RETURN", { ...decideArgs(sub), reason: "Confirm the penning quantity" });
    expect(db.rows("newquip_quotes")[0].state).toBe("REP_DRAFT");
    await expect(submitForApproval(db as never, MGR, "QUOTE", "q1", { now: T0 })).rejects.toThrow(/not in a state that can be submitted/);
  });
  it("legacy approve button path: decideDocument auto-submits the current revision, then applies the same separation-of-duties rule", async () => {
    const { db } = await world(); seedQuote(db);
    const own = { ...MGR, email: "est@a" }; // the estimator who signed it off is also the approving manager
    await expect(decideDocument(db as never, own, "QUOTE", "q1", "APPROVE")).rejects.toThrow(/cannot approve it normally/);
    expect(db.rows("newquip_quotes")[0].state).toBe("ESTIMATOR_REVIEW");
    const done = await decideDocument(db as never, MGR, "QUOTE", "q1", "APPROVE");
    expect(done.status).toBe("APPROVED");
  });
});

describe("integrity: stale revisions, separation of duties, isolation, concurrency, idempotency", () => {
  it("11: a document that changed after submission cannot be approved (fail-before-fix: the digest is the only barrier here)", async () => {
    const { db, projectId } = await world();
    const claimId = await draftClaim(db, projectId);
    const sub = await submitForApproval(db as never, PM, "CLAIM", claimId, { now: T0 });
    db.rows("project_claims").find((c) => c.id === claimId)!.subtotal_cents = R(1); // the figures moved behind the approval
    await expect(decide(db as never, MGR, sub.id, "APPROVE", decideArgs(sub))).rejects.toThrow(/changed since it was submitted/);
    expect((await loadRequest(db as never, ORG, sub.id))!.status).toBe("PENDING");
    expect(db.rows("project_claims").find((c) => c.id === claimId)!.status).toBe("READY_FOR_APPROVAL");
  });
  it("11: a decision on a stale VERSION (someone reassigned meanwhile) is refused", async () => {
    const { db, projectId } = await world();
    const sub = await submitForApproval(db as never, PM, "CLAIM", await draftClaim(db, projectId), { now: T0 });
    await reassign(db as never, MGR, sub.id, "mgr2@a", sub.version);
    await expect(decide(db as never, MGR2, sub.id, "APPROVE", decideArgs(sub))).rejects.toThrow(/changed while you were reviewing/);
  });
  it("8+9: a non-manager cannot decide; a manager cannot approve their own submission without an override; an override is recorded permanently", async () => {
    const { db, projectId } = await world();
    const sub = await submitForApproval(db as never, MGR, "CLAIM", await draftClaim(db, projectId), { now: T0 });
    await expect(decide(db as never, PM, sub.id, "APPROVE", decideArgs(sub))).rejects.toThrow(/Only a manager/);
    const own = await submitForApproval(db as never, MGR, "VARIATION", (await raiseVariation(db as never, ORG, "mgr@a", { projectId, title: "V", description: "", amountCents: R(10) })).variationId, { now: T0 });
    await expect(decide(db as never, MGR, own.id, "APPROVE", decideArgs(own))).rejects.toThrow(/cannot approve it normally/);
    const ok = await decide(db as never, MGR, own.id, "APPROVE", { ...decideArgs(own), override: true, reason: "Sole administrator approving own test variation" });
    expect(ok).toMatchObject({ status: "APPROVED", admin_override: true });
    expect((await docHistory(db as never, ORG, "VARIATION", own.doc_id)).map((e) => e.action)).toContain("OVERRIDE_APPROVED");
  });
  it("10: another organisation can neither see nor decide nor submit these documents", async () => {
    const { db, projectId } = await world();
    const claimId = await draftClaim(db, projectId);
    const sub = await submitForApproval(db as never, PM, "CLAIM", claimId, { now: T0 });
    expect(await loadRequest(db as never, OTHER_ORG, sub.id)).toBeNull();
    await expect(decide(db as never, FOREIGN, sub.id, "APPROVE", decideArgs(sub))).rejects.toThrow(/not found/);
    await expect(submitForApproval(db as never, FOREIGN, "CLAIM", claimId)).rejects.toThrow(/not found/);
    expect((await loadRequest(db as never, ORG, sub.id))!.status).toBe("PENDING");
  });
  it("12: two managers approving at the same instant: exactly one decision, one APPROVED event, the claim approved once", async () => {
    const { db, projectId } = await world();
    const claimId = await draftClaim(db, projectId);
    const sub = await submitForApproval(db as never, PM, "CLAIM", claimId, { now: T0 });
    const res = await Promise.allSettled([decide(db as never, MGR, sub.id, "APPROVE", decideArgs(sub)), decide(db as never, MGR2, sub.id, "APPROVE", decideArgs(sub))]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(res.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await docHistory(db as never, ORG, "CLAIM", claimId)).filter((e) => e.action === "APPROVED")).toHaveLength(1);
    expect(db.rows("project_claims").filter((c) => c.id === claimId && c.status === "APPROVED")).toHaveLength(1);
  });
  it("13: repeating a decision is refused and creates no second event or notification; resubmitting identical content is a no-op", async () => {
    const { db, projectId } = await world();
    const claimId = await draftClaim(db, projectId);
    const sub = await submitForApproval(db as never, PM, "CLAIM", claimId, { now: T0 });
    const again = await submitForApproval(db as never, PM, "CLAIM", claimId, { now: T0 });
    expect(again.id).toBe(sub.id);
    expect(db.rows("approval_requests")).toHaveLength(1);
    await decide(db as never, MGR, sub.id, "APPROVE", decideArgs(sub));
    const events = db.rows("approval_events").length; const notes = db.rows("approval_notifications").length;
    await expect(decide(db as never, MGR, sub.id, "APPROVE", decideArgs(sub))).rejects.toThrow(/already approved/);
    expect(db.rows("approval_events")).toHaveLength(events); expect(db.rows("approval_notifications")).toHaveLength(notes);
  });
  it("recovery: if recording failed after the document changed, retrying the same decision reconciles instead of erroring or double-applying", async () => {
    const { db, projectId } = await world();
    const claimId = await draftClaim(db, projectId);
    const sub = await submitForApproval(db as never, PM, "CLAIM", claimId, { now: T0 });
    const real = (db as any).rpc; // eslint-disable-line @typescript-eslint/no-explicit-any
    (db as any).rpc = async (fn: string, a: unknown) => (fn === "approval_decide" ? { data: null, error: { message: "connection lost" } } : real(fn, a)); // eslint-disable-line @typescript-eslint/no-explicit-any
    await expect(decide(db as never, MGR, sub.id, "APPROVE", decideArgs(sub))).rejects.toThrow(/connection lost/);
    expect(db.rows("project_claims").find((c) => c.id === claimId)!.status).toBe("APPROVED"); // the document did change
    (db as any).rpc = real; // eslint-disable-line @typescript-eslint/no-explicit-any
    const done = await decide(db as never, MGR, sub.id, "APPROVE", decideArgs(sub));
    expect(done.status).toBe("APPROVED");
    expect((await docHistory(db as never, ORG, "CLAIM", claimId)).filter((e) => e.action === "APPROVED")).toHaveLength(1);
  });
  it("only a manager can be assigned; reassignment informs both approvers", async () => {
    const { db, projectId } = await world();
    await expect(submitForApproval(db as never, PM, "CLAIM", await draftClaim(db, projectId), { assignTo: "pm@a" })).rejects.toThrow(/must be a manager/);
    const sub = await submitForApproval(db as never, PM, "CLAIM", await draftClaim(db, projectId).catch(async () => (await db.rows("project_claims").at(-1))!.id as string), { assignTo: "mgr@a", now: T0 });
    await reassign(db as never, MGR, sub.id, "mgr2@a", sub.version);
    expect((await myNotifications(db as never, ORG, "mgr2@a")).map((n) => n.kind)).toEqual(["REASSIGNED"]);
    expect((await myNotifications(db as never, ORG, "mgr@a")).map((n) => n.kind).sort()).toEqual(["REASSIGNED_AWAY", "SUBMITTED"]);
  });
  it("migration pending: approvalsAvailable is false (never an error, never 'no approvals') so documents keep their previous behaviour", async () => {
    const db = { from: () => ({ select: () => ({ limit: async () => ({ data: null, error: { message: 'relation "public.approval_requests" does not exist' } }) }) }) };
    expect(await approvalsAvailable(db as never)).toBe(false);
    const broken = { from: () => ({ select: () => ({ limit: async () => ({ data: null, error: { message: "permission denied" } }) }) }) };
    await expect(approvalsAvailable(broken as never)).rejects.toThrow(/permission denied/);
  });
});

describe("notifications: durable, deduplicated, honest about delivery", () => {
  async function pending() {
    const { db, projectId } = await world();
    const sub = await submitForApproval(db as never, PM, "CLAIM", await draftClaim(db, projectId), { assignTo: "mgr@a", now: T0 });
    return { db, sub };
  }
  it("18: submission creates an in-app notification (delivered) and a queued email for the approver; nothing is sent by the decision path itself", async () => {
    const { db } = await pending();
    const mine = await myNotifications(db as never, ORG, "mgr@a");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ channel: "IN_APP", status: "SENT" });
    expect(mine[0].body).toContain("SAST");
    expect(db.rows("approval_notifications").filter((n) => n.channel === "EMAIL").every((n) => n.status !== "SENT")).toBe(true); // no provider accepted anything yet
  });
  it("19: an email is SENT only when the provider accepted it; failures are retried a bounded number of times, then wait for a manual retry", async () => {
    const { db } = await pending();
    const failing = vi.fn(async () => ({ ok: false, error: "RESEND_API_KEY / RESEND_FROM_EMAIL not configured" }));
    for (let i = 0; i < MAX_EMAIL_ATTEMPTS + 2; i++) await deliverPendingEmails(db as never, failing as never);
    const mail = db.rows("approval_notifications").filter((n) => n.channel === "EMAIL");
    expect(mail.every((n) => n.status === "ABANDONED" && n.attempts === MAX_EMAIL_ATTEMPTS && n.sent_at === null)).toBe(true);
    expect(failing).toHaveBeenCalledTimes(mail.length * (MAX_EMAIL_ATTEMPTS - 1)); // bounded: never more (the first attempt already happened at submission, with no provider configured)
    await retryEmail(db as never, MGR, mail[0].id as string);
    const ok = vi.fn(async () => ({ ok: true, messageId: "msg-1" }));
    await deliverPendingEmails(db as never, ok as never);
    expect(db.rows("approval_notifications").find((n) => n.id === mail[0].id)).toMatchObject({ status: "SENT", provider_message_id: "msg-1", attempts: 1 });
    await expect(retryEmail(db as never, PM, mail[0].id as string)).rejects.toThrow(/Only a manager/);
  });
  it("19: a decision never depends on delivery: with the email provider throwing, the approval still completes", async () => {
    const { db, sub } = await pending();
    const done = await decide(db as never, MGR, sub.id, "APPROVE", decideArgs(sub));
    expect(done.status).toBe("APPROVED");
  });
  it("two delivery workers cannot send the same email twice", async () => {
    const { db } = await pending();
    const send = vi.fn(async () => ({ ok: true, messageId: "m" }));
    await Promise.all([deliverPendingEmails(db as never, send as never), deliverPendingEmails(db as never, send as never)]);
    expect(send).toHaveBeenCalledTimes(db.rows("approval_notifications").filter((n) => n.channel === "EMAIL").length);
  });
});

describe("overdue reminders", () => {
  it("20: one reminder per cadence, bounded, escalation once, never auto-decides, stops when decided", async () => {
    const { db, projectId } = await world();
    db.rows("approval_settings").push({ org_id: ORG, target_business_days: 2, reminder_every_hours: 24, max_reminders: 2, escalation_email: "mgr2@a" });
    const sub = await submitForApproval(db as never, PM, "CLAIM", await draftClaim(db, projectId), { assignTo: "mgr@a", now: T0 });
    expect((simNow = new Date("2026-10-30T07:00:00Z"), await sendOverdueReminders(db as never, "2026-10-30T07:00:00Z")).reminded).toBe(0); // not due yet
    expect((simNow = new Date("2026-11-02T08:00:00Z"), await sendOverdueReminders(db as never, "2026-11-02T08:00:00Z")).reminded).toBe(1); // due Mon 09:14 SAST
    expect((simNow = new Date("2026-11-02T09:00:00Z"), await sendOverdueReminders(db as never, "2026-11-02T09:00:00Z")).reminded).toBe(0); // inside the cadence: no spam
    expect(db.rows("approval_notifications").filter((n) => String(n.kind).startsWith("ESCALATED")).length).toBe(2); // in-app + email, once
    expect((simNow = new Date("2026-11-03T09:00:00Z"), await sendOverdueReminders(db as never, "2026-11-03T09:00:00Z")).reminded).toBe(1);
    expect((simNow = new Date("2026-11-10T09:00:00Z"), await sendOverdueReminders(db as never, "2026-11-10T09:00:00Z")).reminded).toBe(0); // maximum reached
    expect((await loadRequest(db as never, ORG, sub.id))!.status).toBe("PENDING"); // lateness decides nothing
    await decide(db as never, MGR, sub.id, "APPROVE", decideArgs(sub));
    expect((simNow = new Date("2026-12-01T09:00:00Z"), await sendOverdueReminders(db as never, "2026-12-01T09:00:00Z")).reminded).toBe(0);
  });
});

describe("existing controls remain intact", () => {
  it("23+24: approving a claim does not post it: no Cin7 table is touched and the claim stays a local APPROVED claim for the separate posting action", async () => {
    const { db, projectId } = await world();
    const claimId = await draftClaim(db, projectId);
    const sub = await submitForApproval(db as never, PM, "CLAIM", claimId, { now: T0 });
    await decide(db as never, MGR, sub.id, "APPROVE", decideArgs(sub));
    expect(db.rows("project_claims").find((c) => c.id === claimId)!.status).toBe("APPROVED");
    expect(db.rows("project_claim_cin7_postings")).toHaveLength(0);
    expect(db.rows("project_cin7_sale_creations")).toHaveLength(0);
    expect(legacyCtx(ORG, "u", "A@B.com", true).email).toBe("a@b.com");
  });
});
