// In-memory twin of the migration 0112 functions (approval_submit_staged, approval_decide_staged, approval_reassign, org_role_assign / org_role_remove,
// approval_policy_save). The REAL SQL is verified against Postgres by supabase/tests/0112_newquip_roles_and_staged_approvals.test.sql; these tests prove the
// application drives it correctly, so this twin must mirror the SQL line for line (every branch below has the matching SQL branch).
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FakeDb } from "@/lib/projects/__tests__/fake-db";

export function installStaged(db: FakeDb, clockStart = Date.UTC(2026, 9, 29, 8, 0, 0)) {
  let tick = 0;
  const at = () => new Date(clockStart + ++tick * 1000).toISOString();
  const T = (n: string) => db.rows(n) as Array<Record<string, any>>;
  const event = (r: Record<string, any>, action: string, from: string | null, to: string | null, actor: string, name: string, reason: string | null, extra: Record<string, any> = {}) => {
    const e = { id: `ev-${T("approval_events").length + 1}`, org_id: r.org_id, request_id: r.id, doc_type: r.doc_type, doc_id: r.doc_id, doc_ref: r.doc_ref, revision: r.revision, project_id: r.project_id, action, from_status: from, to_status: to, actor_email: actor.toLowerCase(), actor_name: name, reason, digest: r.digest, created_at: at(), stage: r.stage ?? null, destination: null, ...extra };
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
  const ok = (data: unknown) => ({ data, error: null });

  (db as any).rpc = async (fn: string, a: any) => {
    try {
      const out = await run(fn, a);
      return out.data && typeof out.data === "object" && !Array.isArray(out.data) ? { ...out, data: { ...(out.data as object) } } : out;
    } catch (e) { return { data: null, error: { message: (e as Error).message } }; }
  };
  const run = async (fn: string, a: any): Promise<{ data: unknown; error: { message: string } | null }> => {
    if (fn === "approval_submit_staged") {
      const pend = T("approval_requests").find((x) => x.org_id === a.p_org && x.doc_type === a.p_doc_type && x.doc_id === a.p_doc_id && x.status === "PENDING");
      if (pend) {
        if (pend.digest === a.p_digest && pend.stage === a.p_stage) return ok(pend);
        Object.assign(pend, { status: "SUPERSEDED", closed_at: at(), version: pend.version + 1 });
        event(pend, "SUPERSEDED", "PENDING", "SUPERSEDED", a.p_actor, a.p_actor_name, "The document changed and was submitted again.");
      }
      const rev = Math.max(0, ...T("approval_requests").filter((x) => x.org_id === a.p_org && x.doc_type === a.p_doc_type && x.doc_id === a.p_doc_id).map((x) => x.revision)) + 1;
      const row = { id: a.p_id, org_id: a.p_org, doc_type: a.p_doc_type, doc_id: a.p_doc_id, doc_ref: a.p_doc_ref, project_id: a.p_project_id, project_ref: a.p_project_ref, customer_name: a.p_customer, revision: rev, digest: a.p_digest, amount_cents: a.p_amount, status: "PENDING", prepared_by_email: a.p_prepared_by.toLowerCase(), originator_email: (a.p_originator ?? "").toLowerCase() || null, stage: a.p_stage, stage_role: a.p_stage_role, return_destination: null, submitted_at: at(), assigned_to_email: a.p_assigned_to ? a.p_assigned_to.toLowerCase() : null, assigned_at: a.p_assigned_to ? at() : null, due_at: a.p_due_at, first_viewed_at: null, decided_by_email: null, decided_by_name: null, decided_at: null, decision_reason: null, admin_override: false, closed_at: null, version: 1, reminders_sent: 0, last_reminder_at: null, created_at: at() };
      T("approval_requests").push(row);
      const ev = event(row, T("approval_requests").some((x) => x.org_id === a.p_org && x.doc_type === a.p_doc_type && x.doc_id === a.p_doc_id && x.stage === a.p_stage && x.id !== a.p_id) ? "RESUBMITTED" : "SUBMITTED", null, "PENDING", a.p_actor, a.p_actor_name, null);
      if (a.p_assigned_to) event(row, "ASSIGNED", "PENDING", "PENDING", a.p_actor, a.p_actor_name, a.p_assigned_to.toLowerCase());
      enqueue(a.p_org, row.id, ev.id, a.p_notifications);
      return ok(row);
    }
    if (fn === "approval_decide_staged") {
      const v = find(a.p_org, a.p_request);
      if (v.status !== "PENDING") throw new Error(`approval_not_pending: this submission is already ${v.status}`);
      if (v.version !== a.p_expected_version) throw new Error("approval_stale: the submission changed");
      if (v.digest !== a.p_expected_digest) throw new Error("approval_stale: the submitted content is not what was reviewed");
      const reason = (a.p_reason ?? "").trim() || null;
      if (["RETURN", "REJECT"].includes(a.p_action) && (!reason || reason.length < 3)) throw new Error("approval: a written reason is required to return or reject");
      const self = a.p_actor.toLowerCase() === v.prepared_by_email || a.p_actor.toLowerCase() === (v.originator_email ?? "");
      if (a.p_action === "APPROVE" && self) { if (!a.p_override) throw new Error("approval_separation: you prepared or originated this submission"); if (!reason || reason.length < 10) throw new Error("approval: an override needs a written reason"); }
      if (a.p_action === "APPROVE" && !self && a.p_override && (!reason || reason.length < 10)) throw new Error("approval: an override needs a written reason");
      const dest = a.p_action === "RETURN" ? (a.p_destination ?? "PREPARER") : null;
      if (dest === "ESTIMATOR" && !(v.doc_type === "QUOTE" && v.stage === "MANAGER")) throw new Error("approval: only a quotation in manager review can be returned to the estimator");
      const to = ({ APPROVE: "APPROVED", RETURN: "RETURNED", REJECT: "REJECTED", WITHDRAW: "WITHDRAWN" } as Record<string, string>)[a.p_action];
      Object.assign(v, { status: to, closed_at: at(), version: v.version + 1, decided_by_email: a.p_action === "WITHDRAW" ? null : a.p_actor.toLowerCase(), decided_by_name: a.p_action === "WITHDRAW" ? null : a.p_actor_name, decided_at: a.p_action === "WITHDRAW" ? null : at(), decision_reason: reason, admin_override: a.p_action === "APPROVE" && (self || !!a.p_override), return_destination: dest });
      const ev = event(v, v.admin_override ? "OVERRIDE_APPROVED" : to, "PENDING", to, a.p_actor, a.p_actor_name, reason, { destination: dest });
      enqueue(a.p_org, v.id, ev.id, a.p_notifications);
      return ok(v);
    }
    if (fn === "approval_reassign") {
      const v = find(a.p_org, a.p_request);
      if (v.status !== "PENDING") throw new Error("approval_not_pending");
      if (v.version !== a.p_expected_version) throw new Error("approval_stale: changed");
      const old = v.assigned_to_email; Object.assign(v, { assigned_to_email: a.p_new.toLowerCase(), assigned_at: at(), version: v.version + 1, reminders_sent: 0, last_reminder_at: null });
      enqueue(a.p_org, v.id, event(v, "REASSIGNED", "PENDING", "PENDING", a.p_actor, a.p_actor_name, `${old ?? "(unassigned)"} -> ${a.p_new}`).id, a.p_notifications);
      return ok(v);
    }
    if (fn === "approval_mark_viewed") return ok(null);
    if (fn === "approval_policy_save") {
      const names = (a.p_stages as Array<{ stage: string }>).map((s) => s.stage).join(",");
      if (a.p_doc_type === "QUOTE" && names !== "ESTIMATOR,MANAGER") throw new Error("approval_policy: a quotation always needs an estimator stage followed by a manager stage");
      if (a.p_doc_type !== "QUOTE" && names !== "MANAGER") throw new Error("approval_policy: a single manager stage");
      const cur = T("approval_policies").find((p) => p.org_id === a.p_org && p.doc_type === a.p_doc_type);
      if (cur) Object.assign(cur, { stages: a.p_stages, version: cur.version + 1, updated_by_email: a.p_actor }); else T("approval_policies").push({ org_id: a.p_org, doc_type: a.p_doc_type, stages: a.p_stages, version: 1, updated_by_email: a.p_actor });
      return ok(cur ?? T("approval_policies").at(-1));
    }
    if (fn === "org_role_assign") {
      if (!T("org_members").some((m) => m.org_id === a.p_org && m.user_id === a.p_user)) throw new Error("org_role: that user is not a member of this organisation");
      if (T("org_functional_roles").some((r) => r.org_id === a.p_org && r.user_id === a.p_user && r.role === a.p_role)) return ok(false);
      T("org_functional_roles").push({ id: `r-${T("org_functional_roles").length + 1}`, org_id: a.p_org, user_id: a.p_user, user_email: a.p_email.toLowerCase(), role: a.p_role, assigned_by_email: a.p_actor, assigned_at: at() });
      T("org_functional_role_events").push({ id: `re-${T("org_functional_role_events").length + 1}`, org_id: a.p_org, user_id: a.p_user, user_email: a.p_email.toLowerCase(), role: a.p_role, action: "ASSIGNED", actor_email: a.p_actor.toLowerCase(), created_at: at() });
      return ok(true);
    }
    if (fn === "org_role_remove") {
      const i = T("org_functional_roles").findIndex((r) => r.org_id === a.p_org && r.user_id === a.p_user && r.role === a.p_role);
      if (i < 0) return ok(false);
      const [gone] = T("org_functional_roles").splice(i, 1);
      T("org_functional_role_events").push({ id: `re-${T("org_functional_role_events").length + 1}`, org_id: a.p_org, user_id: a.p_user, user_email: gone.user_email, role: a.p_role, action: "REMOVED", actor_email: a.p_actor.toLowerCase(), created_at: at() });
      return ok(true);
    }
    return { data: null, error: { message: `unknown rpc ${fn}` } };
  };
}
