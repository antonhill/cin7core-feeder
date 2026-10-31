"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ModuleHeader } from "@/app/ModuleHeader";
import { APPROVALS_MODULE } from "@/app/module-nav";
import { Alert } from "@/components/ui/Alert";
import { ApprovalTimeline } from "@/components/ApprovalTimeline";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Select } from "@/components/ui/Select";
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
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<null | ApprovalAction>(null);
  const [reason, setReason] = useState("");
  const [override, setOverride] = useState(false);
  const [returnTo, setReturnTo] = useState<"ESTIMATOR" | "PREPARER">("ESTIMATOR");
  const [busy, setBusy] = useState(false);
  const [newApprover, setNewApprover] = useState("");

  const load = useCallback(() => { getApprovalDetailAction(id).then((r) => { if (r.ok && r.data) { setD(r.data); setError(null); } else setError(r.error ?? "Could not load this approval."); }); }, [id]);
  useEffect(load, [load]);

  if (!d) return <main className="mx-auto w-full max-w-[1200px] px-6 py-12"><ModuleHeader module={APPROVALS_MODULE}>Approval</ModuleHeader>{error ? <div className="mt-6"><Alert tone="danger">{error}</Alert></div> : <p className="mt-6 text-sm text-slate-500">Loading…</p>}</main>;
  const r = d.request;
  const now = new Date().toISOString();
  const late = r.status === "PENDING" && isOverdue(r.due_at, now);
  const docHref = r.doc_type === "QUOTE" ? `/newquip-grower/${r.doc_id}` : r.project_id ? `/projects/${r.project_id}` : "/projects";
  const decide = async (action: ApprovalAction) => {
    setBusy(true); setNotice(null);
    const res = await decideApprovalAction(r.id, action, { reason, override, destination: action === "RETURN" && d.can.returnToEstimator ? returnTo : undefined, expectedVersion: r.version, expectedDigest: r.digest });
    setBusy(false);
    if (res.ok) { setNotice(action === "APPROVE" ? "Approved. This authorises the document only; nothing was sent to Cin7." : action === "RETURN" ? "Returned to the preparer for changes." : action === "REJECT" ? "Rejected." : "Withdrawn."); setMode(null); setReason(""); setOverride(false); }
    else setNotice(res.error ?? "The decision was not recorded.");
    load();
  };

  return (
    <main className="mx-auto w-full max-w-[1200px] px-6 py-8">
      <ModuleHeader module={APPROVALS_MODULE}>{DOC_TYPE_LABEL[r.doc_type]} {r.doc_ref}</ModuleHeader>
      <p className="mt-1 text-sm"><Link href="/approvals" className="underline">All approvals</Link> · <Link href={docHref} className="underline">View {r.doc_type === "QUOTE" ? "document" : "project"}</Link></p>
      {error && <div className="mt-3"><Alert tone="danger">{error}</Alert></div>}
      {notice && <div className="mt-3"><Alert tone={/approved|returned|rejected|withdrawn/i.test(notice) && !/cannot|not recorded|changed|already/i.test(notice) ? "info" : "warning"}>{notice}</Alert></div>}

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

      {r.status === "PENDING" && (d.can.decide || d.can.withdraw) && (
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
              <Input label={mode === "RETURN" ? "What must change? (required)" : mode === "REJECT" ? "Reason for rejection (required)" : mode === "APPROVE" && d.can.needsOverride ? "Override reason (required)" : "Comment (optional)"} value={reason} onChange={(e) => setReason(e.target.value)} />
              {mode === "RETURN" && d.can.returnToEstimator && (
                <Select label="Return to" value={returnTo} onChange={(e) => setReturnTo(e.target.value as "ESTIMATOR" | "PREPARER")}>
                  <option value="ESTIMATOR">The estimator (their sign-off is withdrawn and must be given again)</option>
                  <option value="PREPARER">The salesperson (a new revision)</option>
                </Select>
              )}
              {mode === "APPROVE" && d.can.needsOverride && <label className="flex items-center gap-2"><input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> I confirm this is an administrator override of separation of duties</label>}
              <div className="flex gap-2">
                <Button loading={busy} disabled={busy || (mode === "APPROVE" && d.can.needsOverride && !override) || ((mode === "RETURN" || mode === "REJECT") && reason.trim().length < 3)} onClick={() => decide(mode)}>Confirm</Button>
                <Button variant="secondary" disabled={busy} onClick={() => setMode(null)}>Cancel</Button>
              </div>
              <p className="text-xs text-slate-500">Approving records the decision only. It does not create or authorise anything in Cin7, and does not skip the existing stock, claim-posting or variation-billing controls.</p>
            </div>
          )}
          {d.can.reassign && (
            <div className="mt-4 flex flex-wrap items-end gap-2">
              <Select label="Reassign to" value={newApprover} onChange={(e) => setNewApprover(e.target.value)}><option value="">Choose an approver…</option>{d.managers.filter((m) => m !== r.assigned_to_email).map((m) => <option key={m} value={m}>{m}</option>)}</Select>
              <Button size="sm" variant="secondary" disabled={!newApprover || busy} onClick={async () => { setBusy(true); const res = await reassignApprovalAction(r.id, newApprover, r.version); setBusy(false); setNotice(res.ok ? "Reassigned." : res.error ?? "Could not reassign."); load(); }}>Reassign</Button>
            </div>
          )}
        </Panel>
      )}

      <Panel className="mt-4"><PanelTitle>This revision</PanelTitle><div className="mt-3"><ApprovalTimeline events={d.history} /></div></Panel>
      {d.docHistoryAll.length > d.history.length && <Panel className="mt-4"><PanelTitle>Full history of this document (all revisions)</PanelTitle><div className="mt-3"><ApprovalTimeline events={d.docHistoryAll} /></div></Panel>}
    </main>
  );
}
