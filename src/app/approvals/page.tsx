"use client";

import { useUnsavedGuard } from "@/lib/use-unsaved-guard";
import { pageContainerClass } from "@/app/PageContainer";
import { formatZarCents } from "@/lib/format-money";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/Skeleton";
import { ModuleHeader } from "@/app/ModuleHeader";
import { APPROVALS_MODULE } from "@/app/module-nav";
import { Alert } from "@/components/ui/Alert";
import { ActionFeedback, useKeyedActions } from "@/components/ui/action-feedback";
import { Status } from "@/components/ui/Status";
import type { BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { formatSast, isOverdue, waitingLabel } from "@/lib/approvals/time";
import { DOC_TYPE_LABEL, STATUS_LABEL, type ApprovalNotificationRow, type ApprovalStatus } from "@/lib/approvals/types";
import { activeFilters, type QueueFilters, type QueueSort } from "@/lib/approvals/queue";
import { DEFAULT_QUEUE_FILTERS, DEFAULT_QUEUE_SORT } from "@/lib/approvals/filter-view";
import { ApprovalQueueFilters } from "@/components/ApprovalQueueFilters";
import { displayEmailStatus, EMAIL_STATUS_NOTE, type EmailDisplayStatus } from "@/lib/approvals/email-policy";
import { getApprovalsDashboardAction, getEmailStatusAction, getMyNotificationsAction, retryEmailAction, saveApprovalSettingsAction, sendPendingNowAction, sendTestEmailAction, type ApprovalsDashboard, type DispatchSummary } from "./actions";

// The single place a manager sees every outstanding quotation, claim and variation approval. All figures come from the canonical approval records
// (never counters). Times are exact SAST; "waiting" is elapsed calendar time shown beside the exact submission time.
const rand = (c: number) => formatZarCents(c);
const TONE: Record<ApprovalStatus, BadgeTone> = { PENDING: "warning", APPROVED: "success", RETURNED: "warning", REJECTED: "danger", WITHDRAWN: "neutral", SUPERSEDED: "neutral" };

export default function ApprovalsPage() {
  const [d, setD] = useState<ApprovalsDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState<QueueFilters>({ ...DEFAULT_QUEUE_FILTERS });
  const [sort, setSort] = useState<QueueSort>(DEFAULT_QUEUE_SORT);
  const [notes, setNotes] = useState<ApprovalNotificationRow[] | null>(null);
  const [tab, setTab] = useState<"queue" | "notifications" | "admin">("queue");
  const [settings, setSettings] = useState({ targetBusinessDays: "2", reminderEveryHours: "24", maxReminders: "3", escalationEmail: "" });
  const [loadedSettings, setLoadedSettings] = useState(settings); // the last values read from the server: the settings form is dirty only when it differs from these
  const acts = useKeyedActions(); // every admin action reports beside its own button and ignores a second click while it is in flight
  const [notesState, setNotesState] = useState<"idle" | "loading" | "error">("idle");
  const [mail, setMail] = useState<{ configured: boolean; missing: string[]; senderDomain: string | null; failed: number; abandoned: number; suppressed: number; restricted: boolean; allowlist: string[]; linkBase: string } | null>(null);

  // Unsaved-work guard: only the managers' settings form (admin tab) can be dirty; a save reloads the server values and releases it.
  useUnsavedGuard(!!d?.isManager && tab === "admin" && (Object.keys(settings) as Array<keyof typeof settings>).some((k) => settings[k] !== loadedSettings[k]));

  const load = useCallback(() => {
    getApprovalsDashboardAction(f, sort).then((r) => { if (r.ok && r.data) { setD(r.data); setError(null); const t = r.data.settings; const s = { targetBusinessDays: String(t.targetBusinessDays), reminderEveryHours: String(t.reminderEveryHours), maxReminders: String(t.maxReminders), escalationEmail: t.escalationEmail ?? "" }; setSettings(s); setLoadedSettings(s); } else setError(r.error ?? "Could not load approvals."); });
  }, [f, sort]);
  useEffect(load, [load]);
  const openNotes = async () => {
    setTab("notifications"); setNotesState("loading");
    try { const r = await getMyNotificationsAction(false); if (r.ok && r.data) { setNotes(r.data.notifications); setNotesState("idle"); } else setNotesState("error"); } catch { setNotesState("error"); }
  };

  if (!d) return <main className={pageContainerClass("data")}><ModuleHeader variant="workspace" module={APPROVALS_MODULE}>Approvals</ModuleHeader>{error ? <div className="mt-6"><Alert tone="danger">{error}</Alert></div> : <div role="status" aria-live="polite" aria-busy="true" data-testid="approvals-loading"><p className="mt-6 text-sm text-slate-600">Loading approvals…</p><Skeleton className="mt-4 h-12 w-full max-w-3xl" /><Skeleton className="mt-4 h-96 w-full" /></div>}</main>;
  const s = d.summary;
  const cards: Array<[string, string, BadgeTone?]> = [
    ["Awaiting my approval", String(s.awaitingMe)], ["All pending", String(s.pending)], ["Overdue", String(s.overdue), s.overdue ? "danger" : undefined],
    ["Returned for changes", String(s.returned)], ["Approved today", String(s.approvedToday)], ["Approved this week", String(s.approvedThisWeek)], ["Rejected", String(s.rejected)], ["Pending value (ex VAT)", rand(s.pendingValueCents)],
  ];

  return (
    <main className={pageContainerClass("data", "compact")}>
      <ModuleHeader variant="workspace" module={APPROVALS_MODULE}>Approvals</ModuleHeader>
      <div className="mt-2"><Link className="text-sm text-slate-700 underline" href="/approvals/roles">Roles and approval routing</Link></div>
      {!d.available && <div className="mt-4"><Alert tone="warning">Approvals are not active (the database migration is pending). Until then quotations, claims and variations keep their existing approve buttons.</Alert></div>}
      {error && <div className="mt-4"><Alert tone="danger">{error}</Alert></div>}

      {s.awaitingMe > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-400 bg-amber-50 px-4 py-3" data-testid="awaiting-me">
          <p className="text-sm text-amber-900"><strong className="tabular-nums">{s.awaitingMe}</strong> {s.awaitingMe === 1 ? "approval is" : "approvals are"} waiting for your decision.</p>
          <Button size="sm" onClick={() => { setTab("queue"); setF({ mine: true, status: "PENDING" }); }}>Show what needs my decision</Button>
        </div>
      )}
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-4 xl:grid-cols-7" data-testid="approvals-summary">
        {cards.map(([k, v, tone]) => (
          <div key={k} className="flex items-baseline justify-between gap-2 sm:block">
            <dt className="text-xs text-slate-700">{k}</dt>
            <dd className={`whitespace-nowrap text-base font-semibold tabular-nums sm:mt-0.5 sm:text-xl ${tone === "danger" ? "text-red-700" : "text-slate-900"}`}>{v}</dd>
          </div>
        ))}
      </dl>

      {d.needsPreparerAction.length > 0 && (
        <div className="mt-4"><Alert tone="warning">{d.needsPreparerAction.length} of your submissions were returned for changes: {d.needsPreparerAction.map((r) => <Link key={r.id} href={`/approvals/${r.id}`} className="mr-2 underline">{r.doc_ref}</Link>)}</Alert></div>
      )}

      <div className="mt-4 flex gap-2">
        <Button size="sm" aria-pressed={tab === "queue"} variant={tab === "queue" ? "primary" : "secondary"} onClick={() => setTab("queue")}>Queue</Button>
        <Button size="sm" aria-pressed={tab === "notifications"} variant={tab === "notifications" ? "primary" : "secondary"} onClick={openNotes}>Notifications{d.unread > 0 ? ` (${d.unread} unread)` : ""}</Button>
        {d.isManager && <Button size="sm" aria-pressed={tab === "admin"} variant={tab === "admin" ? "primary" : "secondary"} onClick={() => setTab("admin")}>Delivery &amp; settings{d.failedEmails.length ? ` (${d.failedEmails.length} failed)` : ""}</Button>}
      </div>

      {tab === "queue" && (
        <Panel className="mt-3">
          <ApprovalQueueFilters f={f} setF={setF} sort={sort} setSort={setSort} />
          <div className="mt-4">
            {d.rows.length === 0 ? <p className="text-sm text-slate-600">{d.available ? (activeFilters(f).length ? "Nothing matches these filters. Use Clear filters to return to the default view, or set Status to Any status." : "Nothing to show.") : "No approvals yet."}</p> : (
              <>
              <p className="mb-2 text-sm text-slate-700" data-testid="queue-count">{d.rows.length} {d.rows.length === 1 ? "approval" : "approvals"}: <strong>{d.rows.filter((r) => r.status === "PENDING").length} pending</strong>, {d.rows.filter((r) => r.status !== "PENDING").length} completed or returned.</p>
              <Table scrollLabel="Approvals queue">
                <THead><TR>{["Reference", "Project", "Customer", "Type", "Amount (ex VAT)", "Submitted", "Stage", "Assigned approver", "Status", "Waiting", "Due"].map((h) => <TH key={h} align={h.startsWith("Amount") ? "right" : "left"}>{h}</TH>)}</TR></THead>
                <TBody>
                  {d.rows.map((r) => {
                    const late = r.status === "PENDING" && isOverdue(r.due_at, d.nowIso);
                    const mine = r.status === "PENDING" && d.awaitingMeIds.includes(r.id);
                    return (
                      <TR key={r.id} flagged={mine ? "warning" : undefined} className={r.status === "PENDING" ? "" : "bg-slate-50"}>
                        <TD><Link href={`/approvals/${r.id}`} className="font-medium text-blue-700 underline">{r.doc_ref}</Link><div className="text-xs text-slate-600">rev {r.revision}</div>{mine && <div className="mt-1"><Status tone="warning">Your decision</Status></div>}</TD>
                        <TD>{r.project_ref ?? "-"}</TD><TD>{r.customer_name ?? "-"}</TD><TD>{DOC_TYPE_LABEL[r.doc_type]}</TD>
                        <TD align="right" className="whitespace-nowrap tabular-nums">{rand(r.amount_cents)}</TD>
                        <TD className="text-xs"><div>{r.prepared_by_email}</div><div className="whitespace-nowrap text-slate-600">{formatSast(r.submitted_at)}</div></TD>
                        <TD className="text-xs">{r.stage === "ESTIMATOR" ? "Estimator review" : r.doc_type === "QUOTE" ? "Manager approval" : "Approval"}</TD>
                        <TD className="text-xs">{r.assigned_to_email ?? (r.stage_role ? `any ${r.stage_role.toLowerCase().replace("_", " ")}` : "any manager")}</TD>
                        <TD><Status tone={TONE[r.status]}>{STATUS_LABEL[r.status]}</Status>{r.admin_override && <Status tone="warning">override</Status>}</TD>
                        <TD className="whitespace-nowrap text-xs">{r.status === "PENDING" ? waitingLabel(r.submitted_at, d.nowIso) : "-"}</TD>
                        <TD className={`whitespace-nowrap text-xs ${late ? "font-medium text-red-700" : ""}`}>{r.due_at ? formatSast(r.due_at) : "-"}{late ? " (overdue)" : ""}</TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
              </>
            )}
            <p className="mt-2 text-xs text-slate-600">Due dates count business days (Monday to Friday, SAST). Public holidays are not modelled.</p>
          </div>
        </Panel>
      )}

      {tab === "notifications" && (
        <Panel className="mt-3">
          <div className="flex items-center justify-between"><PanelTitle>Your approval notifications</PanelTitle><Button size="sm" variant="secondary" loading={acts.isPending("read")} disabled={acts.isPending("read")} onClick={() => void acts.run("read", async () => { const r = await getMyNotificationsAction(true); if (r.ok && r.data) { setNotes(r.data.notifications); load(); } return r; }, { pending: "Marking as read…", success: "All notifications are marked as read." })}>Mark all read</Button></div>
          <ActionFeedback state={acts.stateOf("read")} />
          {notesState === "loading" ? <p className="mt-2 text-sm text-slate-700" role="status">Loading notifications…</p> : notesState === "error" ? <div className="mt-2"><Alert tone="danger">Could not load your notifications. <button type="button" className="underline" onClick={openNotes}>Try again</button></Alert></div> : !notes || notes.length === 0 ? <p className="mt-2 text-sm text-slate-600">No notifications.</p> : (
            <ul className="mt-2 divide-y divide-slate-100">
              {notes.map((n) => (
                <li key={n.id} className={`py-2 text-sm ${n.read_at ? "text-slate-600" : "font-medium text-slate-900"}`}>
                  <Link href={n.request_id ? `/approvals/${n.request_id}` : `/newquip-grower/${n.quote_id}?stage=5`} className="underline">{n.subject}</Link>
                  <span className="ml-2 text-xs text-slate-600">{formatSast(n.created_at)}{n.read_at ? "" : " · unread"}</span>
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
            <p className="mt-1 text-xs text-slate-600">Approval decisions never depend on email. &ldquo;Accepted&rdquo; means the mail provider (Resend) took the message; it is not confirmation that it reached an inbox. A Preview emails only the listed test mailboxes (anyone else gets the in-app notification only, shown here as Suppressed). A Preview has no scheduled sender: use Send pending now, or Retry on a failed one.</p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <Button size="sm" variant="secondary" loading={acts.isPending("mail")} disabled={acts.isPending("mail")} onClick={() => void acts.run("mail", async () => { const r = await getEmailStatusAction(); if (r.ok && r.data) setMail(r.data); return r.ok && r.data ? r : { ok: false, error: r.error ?? "Could not read the email status." }; }, { pending: "Checking the email configuration…", success: "Email configuration read." })}>Check email configuration</Button>
              {mail && (mail.configured
                ? <Status tone="success">Provider configured{mail.senderDomain ? ` (sender @${mail.senderDomain})` : ""}</Status>
                : <Status tone="danger">Not configured: {mail.missing.join(", ")} missing. Approval emails cannot be sent; in-app notifications still work.</Status>)}
              {mail?.configured && <Button size="sm" variant="secondary" loading={acts.isPending("test")} disabled={acts.isPending("test")} onClick={() => void acts.run("test", async () => {
                const r = await sendTestEmailAction();
                if (!r.ok || !r.data) return { ok: false, error: r.error ?? "Could not send a test email." };
                if (r.data.suppressed) return { ok: false, error: `Not sent: ${r.data.error}` };
                if (!r.data.accepted) return { ok: false, error: `The test email was NOT accepted: ${r.data.error ?? "unknown error"}.` };
                return { ok: true, data: r.data };
              }, { pending: "Sending a test email…", success: (r) => { const t = r.data as { to?: string; messageId?: string }; return `The provider accepted a test email to ${t.to}${t.messageId ? ` (id ${t.messageId})` : ""}. Acceptance is not delivery: check that it arrived.`; } })}>Send a test email to me</Button>}
              {mail?.configured && <Button size="sm" variant="secondary" loading={acts.isPending("pending")} disabled={acts.isPending("pending")} onClick={() => void acts.run("pending", async () => { const r = await sendPendingNowAction(); load(); return r.ok && r.data ? r : { ok: false, error: r.error ?? "Could not send the pending emails." }; }, { pending: "Sending the queued emails…", success: (r) => { const x = r.data as DispatchSummary; return `Dispatched queued emails: ${x.sent} accepted by the provider, ${x.failed} failed, ${x.suppressed} suppressed.`; } })}>Send pending now</Button>}
            </div>
            <ActionFeedback state={acts.stateOf("mail")} /><ActionFeedback state={acts.stateOf("test")} /><ActionFeedback state={acts.stateOf("pending")} />
            {mail && <p className="mt-2 text-xs text-slate-600">{mail.restricted ? <>Preview email policy: subjects are marked [PREVIEW] and only these mailboxes are emailed: {mail.allowlist.join(", ")}. </> : "Production email: no recipient restriction. "}{mail.linkBase ? <>Approval links point to {mail.linkBase}. </> : <>No link base is set, so email links would be relative. </>}{mail.suppressed ? `${mail.suppressed} suppressed.` : ""}</p>}
            {d.recentEmails.length === 0 ? <p className="mt-2 text-sm text-slate-600">No approval emails yet.</p> : (
              <ul className="mt-2 space-y-1 text-sm">
                {d.recentEmails.map((n) => {
                  const st: EmailDisplayStatus = displayEmailStatus(n);
                  return (
                    <li key={n.id} className="flex flex-wrap items-center gap-2" title={EMAIL_STATUS_NOTE[st]}>
                      <Status tone={st === "ACCEPTED" ? "success" : st === "QUEUED" || st === "SUPPRESSED" ? "neutral" : "danger"}>{st === "ACCEPTED" ? "Accepted by provider" : st[0] + st.slice(1).toLowerCase()}</Status>
                      <span>{n.subject} to {n.recipient_email}</span>
                      <span className="text-xs text-slate-600">{formatSast(n.sent_at ?? n.created_at)}{n.last_error ? ` · ${n.last_error}` : ""}{n.attempts ? ` · ${n.attempts} attempt(s)` : ""}</span>
                      {(st === "FAILED" || st === "ABANDONED" || st === "SUPPRESSED") && <Button size="sm" variant="secondary" loading={acts.isPending(`retry-${n.id}`)} disabled={acts.isPending(`retry-${n.id}`)} onClick={() => void acts.run(`retry-${n.id}`, async () => { const r = await retryEmailAction(n.id); load(); return r.ok && r.data ? r : { ok: false, error: r.error ?? "Could not retry." }; }, { pending: "Retrying…", success: (r) => { const x = r.data as DispatchSummary; return x.sent ? "Retried: the provider accepted it (acceptance is not inbox delivery)." : x.suppressed ? "Retried: still suppressed by the Preview policy." : "Retried: the provider did not accept it; see the reason in the list."; } })}>Retry</Button>}
                      <div className="w-full"><ActionFeedback state={acts.stateOf(`retry-${n.id}`)} /></div>
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
            <div className="mt-3"><Button size="sm" loading={acts.isPending("save")} disabled={acts.isPending("save")} onClick={() => void acts.run("save", async () => { const r = await saveApprovalSettingsAction({ targetBusinessDays: Number(settings.targetBusinessDays), reminderEveryHours: Number(settings.reminderEveryHours), maxReminders: Number(settings.maxReminders), escalationEmail: settings.escalationEmail.trim() || null }); load(); return r; }, { pending: "Saving the settings…", success: "Settings saved." })}>Save settings</Button></div>
            <ActionFeedback state={acts.stateOf("save")} />
            <p className="mt-2 text-xs text-slate-600">An overdue approval is only reminded about: lateness never approves or rejects anything. Reminders stop when the item is decided, withdrawn or superseded.</p>
          </Panel>
        </div>
      )}
    </main>
  );
}
