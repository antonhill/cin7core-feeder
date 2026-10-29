"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ModuleHeader } from "@/app/ModuleHeader";
import { APPROVALS_MODULE } from "@/app/module-nav";
import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Select } from "@/components/ui/Select";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { formatSast, isOverdue, waitingLabel } from "@/lib/approvals/time";
import { DOC_TYPE_LABEL, STATUS_LABEL, type ApprovalDocType, type ApprovalNotificationRow, type ApprovalStatus } from "@/lib/approvals/types";
import type { QueueFilters, QueueSort } from "@/lib/approvals/queue";
import { displayEmailStatus, EMAIL_STATUS_NOTE, type EmailDisplayStatus } from "@/lib/approvals/email-policy";
import { getApprovalsDashboardAction, getEmailStatusAction, getMyNotificationsAction, retryEmailAction, saveApprovalSettingsAction, sendPendingNowAction, sendTestEmailAction, type ApprovalsDashboard } from "./actions";

// The single place a manager sees every outstanding quotation, claim and variation approval. All figures come from the canonical approval records
// (never counters). Times are exact SAST; "waiting" is elapsed calendar time shown beside the exact submission time.
const rand = (c: number) => `R ${(c / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const TONE: Record<ApprovalStatus, BadgeTone> = { PENDING: "warning", APPROVED: "success", RETURNED: "warning", REJECTED: "danger", WITHDRAWN: "neutral", SUPERSEDED: "neutral" };

export default function ApprovalsPage() {
  const [d, setD] = useState<ApprovalsDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState<QueueFilters>({ status: "PENDING" });
  const [sort, setSort] = useState<QueueSort>("submitted_asc");
  const [notes, setNotes] = useState<ApprovalNotificationRow[] | null>(null);
  const [tab, setTab] = useState<"queue" | "notifications" | "admin">("queue");
  const [settings, setSettings] = useState({ targetBusinessDays: "2", reminderEveryHours: "24", maxReminders: "3", escalationEmail: "" });
  const [note, setNote] = useState<string | null>(null);
  const [mail, setMail] = useState<{ configured: boolean; missing: string[]; senderDomain: string | null; failed: number; abandoned: number; suppressed: number; restricted: boolean; allowlist: string[]; linkBase: string } | null>(null);

  const load = useCallback(() => {
    getApprovalsDashboardAction(f, sort).then((r) => { if (r.ok && r.data) { setD(r.data); setError(null); const t = r.data.settings; setSettings({ targetBusinessDays: String(t.targetBusinessDays), reminderEveryHours: String(t.reminderEveryHours), maxReminders: String(t.maxReminders), escalationEmail: t.escalationEmail ?? "" }); } else setError(r.error ?? "Could not load approvals."); });
  }, [f, sort]);
  useEffect(load, [load]);
  const openNotes = async () => { setTab("notifications"); const r = await getMyNotificationsAction(false); if (r.ok && r.data) setNotes(r.data.notifications); };

  if (!d) return <main className="mx-auto w-full max-w-[1480px] px-6 py-12"><ModuleHeader module={APPROVALS_MODULE}>Approvals</ModuleHeader>{error ? <div className="mt-6"><Alert tone="danger">{error}</Alert></div> : <p className="mt-6 text-sm text-slate-500">Loading…</p>}</main>;
  const s = d.summary;
  const cards: Array<[string, string, BadgeTone?]> = [
    ["Awaiting my approval", String(s.awaitingMe), s.awaitingMe ? "warning" : undefined], ["All pending", String(s.pending)], ["Overdue", String(s.overdue), s.overdue ? "danger" : undefined],
    ["Returned for changes", String(s.returned)], ["Approved today", String(s.approvedToday)], ["Approved this week", String(s.approvedThisWeek)], ["Rejected", String(s.rejected)], ["Pending value (ex VAT)", rand(s.pendingValueCents)],
  ];

  return (
    <main className="mx-auto w-full max-w-[1480px] px-6 py-8">
      <ModuleHeader module={APPROVALS_MODULE}>Approvals</ModuleHeader>
      <div className="mt-2"><Link className="text-sm text-slate-700 underline" href="/approvals/roles">Roles and approval routing</Link></div>
      {!d.available && <div className="mt-4"><Alert tone="warning">Approvals are not active (the database migration is pending). Until then quotations, claims and variations keep their existing approve buttons.</Alert></div>}
      {error && <div className="mt-4"><Alert tone="danger">{error}</Alert></div>}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map(([k, v, tone]) => (
          <div key={k} className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-xs text-slate-500">{k}</div>
            <div className={`mt-1 text-xl font-semibold tabular-nums ${tone === "danger" ? "text-red-700" : tone === "warning" ? "text-amber-700" : "text-slate-900"}`}>{v}</div>
          </div>
        ))}
      </div>

      {d.needsPreparerAction.length > 0 && (
        <div className="mt-4"><Alert tone="warning">{d.needsPreparerAction.length} of your submissions were returned for changes: {d.needsPreparerAction.map((r) => <Link key={r.id} href={`/approvals/${r.id}`} className="mr-2 underline">{r.doc_ref}</Link>)}</Alert></div>
      )}

      <div className="mt-4 flex gap-2">
        <Button size="sm" variant={tab === "queue" ? "primary" : "secondary"} onClick={() => setTab("queue")}>Queue</Button>
        <Button size="sm" variant={tab === "notifications" ? "primary" : "secondary"} onClick={openNotes}>Notifications{d.unread > 0 ? ` (${d.unread} unread)` : ""}</Button>
        {d.isManager && <Button size="sm" variant={tab === "admin" ? "primary" : "secondary"} onClick={() => setTab("admin")}>Delivery &amp; settings{d.failedEmails.length ? ` (${d.failedEmails.length} failed)` : ""}</Button>}
      </div>

      {tab === "queue" && (
        <Panel className="mt-3">
          <div className="grid gap-3 md:grid-cols-4 xl:grid-cols-6">
            <Select label="Show" value={f.mine ? "mine" : "all"} onChange={(e) => setF({ ...f, mine: e.target.value === "mine" })}><option value="all">All approvals</option><option value="mine">My approvals (assigned to me)</option></Select>
            <Select label="Type" value={f.docType ?? ""} onChange={(e) => setF({ ...f, docType: (e.target.value || undefined) as ApprovalDocType | undefined })}><option value="">All types</option>{(["QUOTE", "CLAIM", "VARIATION"] as const).map((t) => <option key={t} value={t}>{DOC_TYPE_LABEL[t]}</option>)}</Select>
            <Select label="Status" value={f.status ?? "ANY"} onChange={(e) => setF({ ...f, status: e.target.value as ApprovalStatus | "ANY" })}><option value="ANY">Any status</option>{(Object.keys(STATUS_LABEL) as ApprovalStatus[]).map((k) => <option key={k} value={k}>{STATUS_LABEL[k]}</option>)}</Select>
            <Input label="Customer" value={f.customer ?? ""} onChange={(e) => setF({ ...f, customer: e.target.value })} />
            <Input label="Project / reference" value={f.project ?? ""} onChange={(e) => setF({ ...f, project: e.target.value })} />
            <Input label="Submitted by" value={f.preparer ?? ""} onChange={(e) => setF({ ...f, preparer: e.target.value })} />
            <Input label="Assigned manager" value={f.assignee ?? ""} onChange={(e) => setF({ ...f, assignee: e.target.value })} />
            <Input label="Submitted from" type="date" value={f.from?.slice(0, 10) ?? ""} onChange={(e) => setF({ ...f, from: e.target.value ? `${e.target.value}T00:00:00+02:00` : undefined })} />
            <Input label="Submitted to" type="date" value={f.to?.slice(0, 10) ?? ""} onChange={(e) => setF({ ...f, to: e.target.value ? `${e.target.value}T23:59:59+02:00` : undefined })} />
            <Select label="Sort" value={sort} onChange={(e) => setSort(e.target.value as QueueSort)}><option value="submitted_asc">Oldest submission first</option><option value="submitted_desc">Newest submission first</option><option value="waiting_desc">Longest waiting</option><option value="amount_desc">Amount, high to low</option><option value="amount_asc">Amount, low to high</option></Select>
            <label className="flex items-end gap-2 pb-2 text-sm text-slate-700"><input type="checkbox" checked={!!f.overdueOnly} onChange={(e) => setF({ ...f, overdueOnly: e.target.checked })} /> Overdue only</label>
          </div>
          <div className="mt-4">
            {d.rows.length === 0 ? <p className="text-sm text-slate-600">{d.available ? "Nothing matches these filters." : "No approvals yet."}</p> : (
              <Table>
                <THead><TR>{["Reference", "Project", "Customer", "Type", "Rev", "Amount (ex VAT)", "Submitted by", "Submitted at", "Stage", "Assigned approver", "Status", "Waiting", "Due"].map((h) => <TH key={h} align={h.startsWith("Amount") ? "right" : "left"}>{h}</TH>)}</TR></THead>
                <TBody>
                  {d.rows.map((r) => {
                    const late = r.status === "PENDING" && isOverdue(r.due_at, d.nowIso);
                    return (
                      <TR key={r.id}>
                        <TD><Link href={`/approvals/${r.id}`} className="font-medium text-blue-700 underline">{r.doc_ref}</Link></TD>
                        <TD>{r.project_ref ?? "-"}</TD><TD>{r.customer_name ?? "-"}</TD><TD>{DOC_TYPE_LABEL[r.doc_type]}</TD><TD>{r.revision}</TD>
                        <TD align="right" className="whitespace-nowrap tabular-nums">{rand(r.amount_cents)}</TD>
                        <TD className="text-xs">{r.prepared_by_email}</TD><TD className="whitespace-nowrap text-xs">{formatSast(r.submitted_at)}</TD>
                        <TD className="text-xs">{r.stage === "ESTIMATOR" ? "Estimator review" : r.doc_type === "QUOTE" ? "Manager approval" : "Approval"}</TD>
                        <TD className="text-xs">{r.assigned_to_email ?? (r.stage_role ? `any ${r.stage_role.toLowerCase().replace("_", " ")}` : "any manager")}</TD>
                        <TD><Badge tone={TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>{r.admin_override && <Badge tone="warning">override</Badge>}</TD>
                        <TD className="whitespace-nowrap text-xs">{r.status === "PENDING" ? waitingLabel(r.submitted_at, d.nowIso) : "-"}</TD>
                        <TD className={`whitespace-nowrap text-xs ${late ? "font-medium text-red-700" : ""}`}>{r.due_at ? formatSast(r.due_at) : "-"}{late ? " (overdue)" : ""}</TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            )}
            <p className="mt-2 text-xs text-slate-500">Due dates count business days (Monday to Friday, SAST). Public holidays are not modelled.</p>
          </div>
        </Panel>
      )}

      {tab === "notifications" && (
        <Panel className="mt-3">
          <div className="flex items-center justify-between"><PanelTitle>Your approval notifications</PanelTitle><Button size="sm" variant="secondary" onClick={async () => { const r = await getMyNotificationsAction(true); if (r.ok && r.data) { setNotes(r.data.notifications); load(); } }}>Mark all read</Button></div>
          {!notes || notes.length === 0 ? <p className="mt-2 text-sm text-slate-600">No notifications.</p> : (
            <ul className="mt-2 divide-y divide-slate-100">
              {notes.map((n) => (
                <li key={n.id} className={`py-2 text-sm ${n.read_at ? "text-slate-600" : "font-medium text-slate-900"}`}>
                  <Link href={`/approvals/${n.request_id}`} className="underline">{n.subject}</Link>
                  <span className="ml-2 text-xs text-slate-500">{formatSast(n.created_at)}{n.read_at ? "" : " · unread"}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {tab === "admin" && d.isManager && (
        <div className="mt-3 space-y-4">
          <Panel>
            <PanelTitle>Email delivery</PanelTitle>
            <p className="mt-1 text-xs text-slate-500">Approval decisions never depend on email. &ldquo;Accepted&rdquo; means the mail provider (Resend) took the message; it is not confirmation that it reached an inbox. A Preview emails only the listed test mailboxes (anyone else gets the in-app notification only, shown here as Suppressed). A Preview has no scheduled sender: use Send pending now, or Retry on a failed one.</p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <Button size="sm" variant="secondary" onClick={async () => { const r = await getEmailStatusAction(); if (r.ok && r.data) setMail(r.data); else setNote(r.error ?? "Could not read the email status."); }}>Check email configuration</Button>
              {mail && (mail.configured
                ? <Badge tone="success">Provider configured{mail.senderDomain ? ` (sender @${mail.senderDomain})` : ""}</Badge>
                : <Badge tone="danger">Not configured: {mail.missing.join(", ")} missing. Approval emails cannot be sent; in-app notifications still work.</Badge>)}
              {mail?.configured && <Button size="sm" variant="secondary" onClick={async () => { const r = await sendTestEmailAction(); setNote(r.ok && r.data ? (r.data.suppressed ? `Not sent: ${r.data.error}` : r.data.accepted ? `The provider accepted a test email to ${r.data.to}${r.data.messageId ? ` (id ${r.data.messageId})` : ""}. Acceptance is not delivery: check that it arrived.` : `The test email was NOT accepted: ${r.data.error ?? "unknown error"}.`) : r.error ?? "Could not send a test email."); }}>Send a test email to me</Button>}
              {mail?.configured && <Button size="sm" variant="secondary" onClick={async () => { const r = await sendPendingNowAction(); setNote(r.ok && r.data ? `Dispatched queued emails: ${r.data.sent} accepted by the provider, ${r.data.failed} failed, ${r.data.suppressed} suppressed.` : r.error ?? "Could not send the pending emails."); load(); }}>Send pending now</Button>}
            </div>
            {mail && <p className="mt-2 text-xs text-slate-600">{mail.restricted ? <>Preview email policy: subjects are marked [PREVIEW] and only these mailboxes are emailed: {mail.allowlist.join(", ")}. </> : "Production email: no recipient restriction. "}{mail.linkBase ? <>Approval links point to {mail.linkBase}. </> : <>No link base is set, so email links would be relative. </>}{mail.suppressed ? `${mail.suppressed} suppressed.` : ""}</p>}
            {d.recentEmails.length === 0 ? <p className="mt-2 text-sm text-slate-600">No approval emails yet.</p> : (
              <ul className="mt-2 space-y-1 text-sm">
                {d.recentEmails.map((n) => {
                  const st: EmailDisplayStatus = displayEmailStatus(n);
                  return (
                    <li key={n.id} className="flex flex-wrap items-center gap-2" title={EMAIL_STATUS_NOTE[st]}>
                      <Badge tone={st === "ACCEPTED" ? "success" : st === "QUEUED" || st === "SUPPRESSED" ? "neutral" : "danger"}>{st === "ACCEPTED" ? "Accepted by provider" : st[0] + st.slice(1).toLowerCase()}</Badge>
                      <span>{n.subject} to {n.recipient_email}</span>
                      <span className="text-xs text-slate-500">{formatSast(n.sent_at ?? n.created_at)}{n.last_error ? ` · ${n.last_error}` : ""}{n.attempts ? ` · ${n.attempts} attempt(s)` : ""}</span>
                      {(st === "FAILED" || st === "ABANDONED" || st === "SUPPRESSED") && <Button size="sm" variant="secondary" onClick={async () => { const r = await retryEmailAction(n.id); setNote(r.ok && r.data ? (r.data.sent ? "Retried: the provider accepted it (acceptance is not inbox delivery)." : r.data.suppressed ? "Retried: still suppressed by the Preview policy." : "Retried: the provider did not accept it; see the reason in the list.") : r.error ?? "Could not retry."); load(); }}>Retry</Button>}
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
          <Panel>
            <PanelTitle>Approval target and reminders</PanelTitle>
            <div className="mt-2 grid gap-3 md:grid-cols-4">
              <Input label="Target (business days)" value={settings.targetBusinessDays} onChange={(e) => setSettings({ ...settings, targetBusinessDays: e.target.value })} />
              <Input label="Remind every (hours)" value={settings.reminderEveryHours} onChange={(e) => setSettings({ ...settings, reminderEveryHours: e.target.value })} />
              <Input label="Maximum reminders" value={settings.maxReminders} onChange={(e) => setSettings({ ...settings, maxReminders: e.target.value })} />
              <Input label="Escalate to (manager email)" value={settings.escalationEmail} onChange={(e) => setSettings({ ...settings, escalationEmail: e.target.value })} />
            </div>
            <div className="mt-3"><Button size="sm" onClick={async () => { const r = await saveApprovalSettingsAction({ targetBusinessDays: Number(settings.targetBusinessDays), reminderEveryHours: Number(settings.reminderEveryHours), maxReminders: Number(settings.maxReminders), escalationEmail: settings.escalationEmail.trim() || null }); setNote(r.ok ? "Saved." : r.error ?? "Could not save."); load(); }}>Save settings</Button></div>
            <p className="mt-2 text-xs text-slate-500">An overdue approval is only reminded about: lateness never approves or rejects anything. Reminders stop when the item is decided, withdrawn or superseded.</p>
          </Panel>
          {note && <Alert tone="info">{note}</Alert>}
        </div>
      )}
    </main>
  );
}
