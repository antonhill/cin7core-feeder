"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ModuleHeader } from "@/app/ModuleHeader";
import { APPROVALS_MODULE } from "@/app/module-nav";
import { Alert } from "@/components/ui/Alert";
import { ActionFeedback, useKeyedActions } from "@/components/ui/action-feedback";
import { ApprovalTimeline } from "@/components/ApprovalTimeline";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Select } from "@/components/ui/Select";
import { applyDecision, showDecisionPanel } from "@/lib/approvals/detail-state";
import { formatSast, isOverdue, waitingLabel } from "@/lib/approvals/time";
import { DOC_TYPE_LABEL, STATUS_LABEL, type ApprovalAction, type ApprovalStatus } from "@/lib/approvals/types";
import { decideApprovalAction, getApprovalDetailAction, reassignApprovalAction, type ApprovalDetail } from "../actions";

// Review workspace: the exact revision and values that were SUBMITTED. If anything changed since, the server refuses the decision and this page says so.
const rand = (c: number) => `R ${(c / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const TONE: Record<ApprovalStatus, BadgeTone> = { PENDING: "warning", APPROVED: "success", RETURNED: "warning", REJECTED: "danger", WITHDRAWN: "neutral", SUPERSEDED: "neutral" };

export default function ApprovalDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<ApprovalDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<null | ApprovalAction>(null);
  const [reason, setReason] = useState("");
  const [override, setOverride] = useState(false);
  const [returnTo, setReturnTo] = useState<"ESTIMATOR" | "PREPARER">("ESTIMATOR");
  const acts = useKeyedActions();
  const busy = acts.anyPending; // a ref-guarded in-flight set, so a fast double-click cannot submit twice
  const [reasonTouched, setReasonTouched] = useState(false);
  const [newApprover, setNewApprover] = useState("");

  const load = useCallback(() => { getApprovalDetailAction(id).then((r) => { if (r.ok && r.data) { setD((cur) => (cur && cur.request.status !== "PENDING" && r.data!.request.status === "PENDING" ? cur : r.data!)); setError(null); } else setError(r.error ?? "Could not load this approval."); }); }, [id]);
  useEffect(load, [load]);

  if (!d) return <main className="mx-auto w-full max-w-[1200px] px-6 py-12"><ModuleHeader module={APPROVALS_MODULE}>Approval</ModuleHeader>{error ? <div className="mt-6"><Alert tone="danger">{error}</Alert></div> : <p className="mt-6 text-sm text-slate-500">Loading…</p>}</main>;
  const r = d.request;
  const now = new Date().toISOString();
  const late = r.status === "PENDING" && isOverdue(r.due_at, now);
  const docHref = r.doc_type === "QUOTE" ? `/newquip-grower/${r.doc_id}` : r.project_id ? `/projects/${r.project_id}` : "/projects";
  // What each action should leave the request as: used to tell, after a lost response, whether the decision was in fact recorded.
  const EXPECTED: Record<ApprovalAction, ApprovalStatus> = { APPROVE: "APPROVED", RETURN: "RETURNED", REJECT: "REJECTED", WITHDRAW: "WITHDRAWN" };
  const DONE: Record<ApprovalAction, string> = { APPROVE: "Approved. This authorises the document only; nothing was sent to Cin7.", RETURN: "Returned to the preparer for changes.", REJECT: "Rejected.", WITHDRAW: "Withdrawn." };
  // Mirrors the server's own minimums so the field says what is wrong BESIDE the field. The server remains the authority and re-checks every decision.
  const reasonError = (action: ApprovalAction | null): string | undefined => {
    if (!action || !reasonTouched) return undefined;
    const n = reason.trim().length;
    if ((action === "RETURN" || action === "REJECT") && n < 3) return action === "RETURN" ? "Explain what must change (at least 3 characters)." : "A written reason is required to reject (at least 3 characters).";
    if (action === "APPROVE" && d.can.needsOverride && n < 10) return "An override needs a written reason of at least 10 characters.";
    return undefined;
  };
  const decide = async (action: ApprovalAction) => {
    if (r.status !== "PENDING") return; // a decided request can never be decided again from this page
    setReasonTouched(true);
    if (reasonError(action) !== undefined || (action === "APPROVE" && d.can.needsOverride && reason.trim().length < 10)) return; // shown beside the field; nothing is submitted
    let seen: ApprovalStatus | null = null;
    const ok = await acts.run("decision", async () => {
      const res = await decideApprovalAction(r.id, action, { reason, override, destination: action === "RETURN" && d.can.returnToEstimator ? returnTo : undefined, expectedVersion: r.version, expectedDigest: r.digest });
      if (res.ok && res.data) setD((cur) => (cur ? applyDecision(cur, res.data!) : cur));
      return res;
    }, {
      pending: "Recording your decision…",
      success: (res) => `${DONE[action]}${res.data ? ` Status now: ${STATUS_LABEL[res.data.status]}.` : ""}`,
      reconcile: async () => {
        const x = await getApprovalDetailAction(id);
        if (!x.ok || !x.data) return "unreadable";
        const status = x.data.request.status;
        seen = status;
        if (status !== "PENDING") setD(x.data);
        return status === EXPECTED[action] ? "done" : status === "PENDING" ? "not_done" : "unknown";
      },
      // Without the server's own result we cannot know the decision was THIS user's (someone may have decided at the same moment), so say only what the request now is.
      doneAfterReconcile: () => `The request is now ${seen ? STATUS_LABEL[seen] : "decided"}. The response to your click was lost, so check the decision record on this page for who recorded it.`,
    });
    if (ok) { setMode(null); setReason(""); setOverride(false); setReasonTouched(false); } else load(); // a failure keeps the reason and the override tick exactly as typed
  };

  return (
    <main className="mx-auto w-full max-w-[1200px] px-6 py-8">
      <ModuleHeader module={APPROVALS_MODULE}>{DOC_TYPE_LABEL[r.doc_type]} {r.doc_ref}</ModuleHeader>
      <p className="mt-1 text-sm"><Link href="/approvals" className="underline">All approvals</Link> · <Link href={docHref} className="underline">View {r.doc_type === "QUOTE" ? "document" : "project"}</Link></p>
      {error && <div className="mt-3"><Alert tone="danger">{error}</Alert></div>}

      <Panel className="mt-4">
        <div className="flex flex-wrap items-center gap-2"><PanelTitle>Revision {r.revision}</PanelTitle><Badge tone={TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>{r.admin_override && <Badge tone="warning">administrator override</Badge>}{late && <Badge tone="danger">overdue</Badge>}</div>
        <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
          {([
            ["Customer", r.customer_name ?? "-"], ["Project", r.project_ref ?? "-"], ["Amount (ex VAT)", rand(r.amount_cents)],
            ["Submitted by", r.prepared_by_email], ["Submitted at", formatSast(r.submitted_at)], ["Waiting", r.status === "PENDING" ? waitingLabel(r.submitted_at, now) : "-"],
            ...(d.stage ? [["Stage", d.stage.label]] : []), ["Assigned approver", r.assigned_to_email ?? (d.stage ? `any ${d.stage.role.toLowerCase().replace("_", " ")}` : "any manager")], ...(r.return_destination ? [["Returned to", r.return_destination === "ESTIMATOR" ? "The estimator" : "The preparer"]] : []), ["Assigned at", formatSast(r.assigned_at)], ["Due", r.due_at ? formatSast(r.due_at) : "-"],
            ["First viewed", formatSast(r.first_viewed_at)], ["Decided", r.decided_at ? `${formatSast(r.decided_at)} by ${r.decided_by_name ?? r.decided_by_email}` : "-"], ["Content seal", `${r.digest.slice(0, 12)}…`],
          ] as Array<[string, string]>).map(([k, v]) => <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="font-medium text-slate-900 tabular-nums">{v}</dd></div>)}
        </dl>
        {r.decision_reason && <p className="mt-3 text-sm text-slate-700"><strong>Reason:</strong> {r.decision_reason}</p>}
      </Panel>

      {d.review.sections.map((s) => (
        <Panel key={s.title} className="mt-4">
          <PanelTitle>{s.title}</PanelTitle>
          {s.warning && <div className="mt-2"><Alert tone="warning">{s.warning}</Alert></div>}
          {s.rows.length > 0 && <dl className="mt-2 grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">{s.rows.map(([k, v]) => <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="text-slate-900">{v}</dd></div>)}</dl>}
          {s.items && s.items.length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-slate-700">{s.items.map((i, n) => <li key={n}>{i}</li>)}</ul>}
        </Panel>
      ))}

      {r.status !== "PENDING" && r.decided_at && (
        <Panel className="mt-4">
          <PanelTitle>Decision recorded</PanelTitle>
          <p className="mt-2 text-sm text-slate-800"><Badge tone={TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge> by <strong>{r.decided_by_name ?? r.decided_by_email}</strong> on {formatSast(r.decided_at)}.</p>
          {r.admin_override && <div className="mt-2"><Alert tone="warning"><strong>Administrator override of separation of duties.</strong> {r.decision_reason ? `Reason given: ${r.decision_reason}` : "No reason was recorded."}</Alert></div>}
          {!r.admin_override && r.decision_reason && <p className="mt-2 text-sm text-slate-700"><strong>Reason:</strong> {r.decision_reason}</p>}
          <ActionFeedback state={acts.stateOf("decision")} />
          <p className="mt-2 text-xs text-slate-500">This decision is final. It cannot be repeated or changed from here.</p>
        </Panel>
      )}

      {showDecisionPanel(d) && (
        <Panel className="mt-4">
          <PanelTitle>Decision</PanelTitle>
          {d.can.needsOverride && <div className="mt-2"><Alert tone="warning">You prepared this submission. You can approve it only as an explicit administrator override with a written reason, which is permanently recorded. You can still return or reject it.</Alert></div>}
          <div className="mt-3 flex flex-wrap gap-2">
            {d.can.decide && <Button disabled={busy} onClick={() => setMode("APPROVE")}>Approve…</Button>}
            {d.can.decide && <Button variant="secondary" disabled={busy} onClick={() => setMode("RETURN")}>Return for changes…</Button>}
            {d.can.decide && <Button variant="destructive" disabled={busy} onClick={() => setMode("REJECT")}>Reject…</Button>}
            {d.can.withdraw && <Button variant="secondary" disabled={busy} onClick={() => setMode("WITHDRAW")}>Withdraw…</Button>}
          </div>
          {mode && (
            <div className="mt-3 space-y-2 rounded-lg border border-slate-200 p-3 text-sm">
              <p>{mode === "APPROVE" ? "Approve" : mode === "RETURN" ? "Return" : mode === "REJECT" ? "Reject" : "Withdraw"} {DOC_TYPE_LABEL[r.doc_type].toLowerCase()} <strong>{r.doc_ref}</strong>, revision {r.revision}, <strong>{rand(r.amount_cents)}</strong> ex VAT, submitted {formatSast(r.submitted_at)}?</p>
              <Input label={mode === "RETURN" ? "What must change? (required)" : mode === "REJECT" ? "Reason for rejection (required)" : mode === "APPROVE" && d.can.needsOverride ? "Override reason (required)" : "Comment (optional)"} value={reason} onChange={(e) => { setReason(e.target.value); setReasonTouched(true); }} error={reasonError(mode)} />
              {mode === "RETURN" && d.can.returnToEstimator && (
                <Select label="Return to" value={returnTo} onChange={(e) => setReturnTo(e.target.value as "ESTIMATOR" | "PREPARER")}>
                  <option value="ESTIMATOR">The estimator (their sign-off is withdrawn and must be given again)</option>
                  <option value="PREPARER">The salesperson (a new revision)</option>
                </Select>
              )}
              {mode === "APPROVE" && d.can.needsOverride && <label className="flex items-center gap-2"><input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> I confirm this is an administrator override of separation of duties</label>}
              <div className="flex gap-2">
                <Button loading={acts.isPending("decision")} disabled={busy || (mode === "APPROVE" && d.can.needsOverride && !override) || ((mode === "RETURN" || mode === "REJECT") && reason.trim().length < 3)} onClick={() => decide(mode)}>Confirm</Button>
                <Button variant="secondary" disabled={busy} onClick={() => { setMode(null); setReasonTouched(false); }}>Cancel</Button>
              </div>
              <ActionFeedback state={acts.stateOf("decision")} />
              <p className="text-xs text-slate-500">Approving records the decision only. It does not create or authorise anything in Cin7, and does not skip the existing stock, claim-posting or variation-billing controls.</p>
            </div>
          )}
          {d.can.reassign && (
            <div className="mt-4 flex flex-wrap items-end gap-2">
              <Select label="Reassign to" value={newApprover} onChange={(e) => setNewApprover(e.target.value)}><option value="">Choose an approver…</option>{d.managers.filter((m) => m !== r.assigned_to_email).map((m) => <option key={m} value={m}>{m}</option>)}</Select>
              <Button size="sm" variant="secondary" disabled={!newApprover || busy} onClick={async () => { await acts.run("reassign", () => reassignApprovalAction(r.id, newApprover, r.version), { pending: "Reassigning…", success: "Reassigned.", reconcile: async () => { const x = await getApprovalDetailAction(id); if (!x.ok || !x.data) return "unreadable"; return x.data.request.assigned_to_email === newApprover ? "done" : "unknown"; } }); load(); }}>Reassign</Button>
            </div>
          )}
          {d.can.reassign && <ActionFeedback state={acts.stateOf("reassign")} />}
        </Panel>
      )}

      <Panel className="mt-4"><PanelTitle>This revision</PanelTitle><div className="mt-3"><ApprovalTimeline events={d.history} /></div></Panel>
      {d.docHistoryAll.length > d.history.length && <Panel className="mt-4"><PanelTitle>Full history of this document (all revisions)</PanelTitle><div className="mt-3"><ApprovalTimeline events={d.docHistoryAll} /></div></Panel>}
    </main>
  );
}
