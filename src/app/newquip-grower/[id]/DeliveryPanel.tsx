"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { formatSast } from "@/lib/approvals/time";
import { getQuoteDocumentsAction, issueQuoteDocumentAction, type QuoteDocumentsView } from "../document-actions";
import { getQuoteDeliveryAction, recordCustomerResponseAction, retryQuoteSendAction, sendQuoteToCustomerAction, type DeliveryView } from "../delivery-actions";
import { resolveScheduleChoice, type ScheduleChoice } from "@/newquip/quote/billing-schedule";
import { ScheduleChooser } from "./ScheduleChooser";

// The customer-facing half of an APPROVED quotation: issue the PDF, review it, send it (Rep), then record the customer's response. Manager approval authorises issue;
// it is NOT customer acceptance. "Accepted by the email provider" means the provider took the message - it is not proof that the customer received it. Nothing here
// touches Cin7. The server re-checks every permission, the organisation and the approved revision on each action.
const inputCls = "h-9 rounded-md border border-slate-300 bg-white px-2 text-sm";
const SEND_LABEL: Record<string, string> = { ACCEPTED: "Accepted by the email provider (not proof of inbox delivery)", FAILED: "Failed", SUPPRESSED: "Not sent: recipient not permitted from this environment", QUEUED: "Queued / outcome unconfirmed" };
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function DeliveryPanel({ quoteId, contractCents, onGate }: { quoteId: string; contractCents: number; onGate: (g: { requires: boolean; accepted: boolean }) => void }) {
  const [docs, setDocs] = useState<QuoteDocumentsView | null>(null);
  const [d, setD] = useState<DeliveryView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<ScheduleChoice | undefined>(undefined);
  const [to, setTo] = useState(""); const [cc, setCc] = useState(""); const [message, setMessage] = useState(""); const [reviewed, setReviewed] = useState(false);
  const [key, setKey] = useState(newKey); const [altReason, setAltReason] = useState(""); const [resendOf, setResendOf] = useState<string | null>(null); const [resendReason, setResendReason] = useState("");
  const [resp, setResp] = useState({ response: "ACCEPTED" as "ACCEPTED" | "DECLINED" | "CHANGES_REQUESTED", contactName: "", respondedOn: new Date().toISOString().slice(0, 10), evidenceRef: "", note: "" });

  const reload = useCallback(async () => {
    const [a, b] = await Promise.all([getQuoteDocumentsAction(quoteId), getQuoteDeliveryAction(quoteId)]);
    if (a.ok && a.data) setDocs(a.data); else setErr(a.error ?? "Could not load documents.");
    if (b.ok && b.data) { setD(b.data); onGate({ requires: b.data.requiresAcceptance, accepted: b.data.accepted }); if (!to && b.data.defaultTo) setTo(b.data.defaultTo); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteId, onGate]);
  useEffect(() => { let live = true; void (async () => { if (live) await reload(); })(); return () => { live = false; }; }, [reload]);

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
    setBusy(true); setErr(null); setNote(null);
    try { const r = await fn(); if (r.ok) { setNote(done); await reload(); } else setErr(r.error ?? "Failed."); } finally { setBusy(false); }
  };

  if (!docs || !d) return <Panel><PanelTitle>Customer quotation</PanelTitle><p className="mt-2 text-sm text-slate-500">{err ?? "Loading…"}</p></Panel>;
  if (!docs.available || !d.available) return <Panel><PanelTitle>Customer quotation</PanelTitle><Alert tone="info">Sending a quotation to the customer becomes available once the database update for customer quotations (migration 0115) has been applied.</Alert></Panel>;
  const latest = docs.documents[0];
  const split = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
  const altNeeded = d.policy.production ? [...split(to), ...split(cc)].filter((a) => !d.contactEmails.includes(a.toLowerCase())) : [];
  const statusTone = d.status === "CUSTOMER_ACCEPTED" ? "success" : d.status === "CUSTOMER_DECLINED" || d.status === "CHANGES_REQUESTED" ? "warning" : "neutral";
  return (
    <Panel>
      <div className="flex items-center gap-2"><PanelTitle>Customer quotation</PanelTitle><Badge tone={statusTone}>{d.statusLabel}</Badge></div>
      <p className="mt-1 text-xs text-slate-500">Manager approval lets the quotation be issued. It is not the customer&apos;s acceptance: a Project for a new quotation needs the customer&apos;s recorded acceptance.</p>
      {err && <Alert tone="danger">{err}</Alert>}
      {note && <Alert tone="success">{note}</Alert>}

      <h3 className="mt-4 text-sm font-semibold text-slate-800">1 · Quotation PDF</h3>
      {docs.blockers.length > 0 && <Alert tone="warning"><ul className="list-disc pl-4">{docs.blockers.map((b) => <li key={b}>{b}</li>)}</ul><Link className="underline" href="/newquip-grower/company-profile">Company details</Link></Alert>}
      {docs.documents.length > 0 && (
        <ul className="mt-2 divide-y rounded-md border border-slate-200 text-sm">
          {docs.documents.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 p-2">
              <span>Revision {x.revision} · version {x.version} · issued {formatSast(x.issuedAt)} by {x.issuedBy} · {(x.byteSize / 1024).toFixed(0)} KB · sha256 {x.contentHash.slice(0, 12)}…</span>
              <a className="text-indigo-700 underline" href={`/api/newquip-quote-documents/${x.id}`} target="_blank" rel="noreferrer">Open PDF</a>
            </li>
          ))}
        </ul>
      )}
      {docs.canIssue && !d.accepted && (
        <div className="mt-3 space-y-2">
          {!d.requiresAcceptance ? null : <p className="text-xs text-slate-500">The billing schedule you choose here is printed on the quotation and is the one the Project will use once the customer accepts.</p>}
          {!latest && <ScheduleChooser contractCents={contractCents} onChange={setChoice} />}
          <Button type="button" variant="secondary" loading={busy} disabled={!latest && !resolveScheduleChoice(choice).ok} onClick={() => void run(() => issueQuoteDocumentAction(quoteId, choice), latest ? "Checked: the PDF is current (a new version is created only if an input changed)." : "Quotation PDF generated.")}>
            {latest ? "Re-check / issue a new version if inputs changed" : "Generate customer quotation PDF"}
          </Button>
        </div>
      )}

      <h3 className="mt-5 text-sm font-semibold text-slate-800">2 · Send to the customer</h3>
      {d.policy.restricted && <Alert tone="info">Preview environment: only {d.policy.allowlist.join(", ")} will be emailed. Any other address is recorded as not sent, never redirected. Subjects are marked [PREVIEW].</Alert>}
      {!d.policy.emailConfigured && <Alert tone="warning">Email is not configured in this environment.</Alert>}
      {d.canSend && latest ? (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap gap-2">
            <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-slate-700">To (confirm the customer&apos;s address)</span><input className={`${inputCls} w-80`} value={to} onChange={(e) => setTo(e.target.value)} /></label>
            <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-slate-700">CC (optional)</span><input className={`${inputCls} w-80`} value={cc} onChange={(e) => setCc(e.target.value)} /></label>
          </div>
          <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-slate-700">Message</span><textarea className="min-h-20 rounded-md border border-slate-300 p-2 text-sm" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Optional. Do not mention costs or margins." /></label>
          {resendOf && <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-slate-700">Reason for sending again</span><input className={`${inputCls} w-full`} value={resendReason} onChange={(e) => setResendReason(e.target.value)} /></label>}
          {altNeeded.length > 0 && <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-amber-800">{altNeeded.join(", ")} {altNeeded.length === 1 ? "is" : "are"} not a Cin7 contact of this customer. Reason for approving {altNeeded.length === 1 ? "this address" : "these addresses"} (audited)</span><input className={`${inputCls} w-full`} value={altReason} onChange={(e) => setAltReason(e.target.value)} /></label>}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} /> I have opened and reviewed the PDF, and these are the right recipients.</label>
          <Button type="button" loading={busy} disabled={!reviewed || split(to).length === 0 || (altNeeded.length > 0 && altReason.trim().length < 5) || (!!resendOf && resendReason.trim().length < 3)} onClick={() => void run(async () => {
            const r = await sendQuoteToCustomerAction(quoteId, { documentId: latest.id, to: split(to), cc: split(cc), message, idempotencyKey: key, alternativeReason: altNeeded.length ? altReason : undefined, resendOfId: resendOf ?? undefined, resendReason: resendOf ? resendReason : undefined });
            if (r.ok && r.data) { setKey(newKey()); setResendOf(null); setResendReason(""); setReviewed(false); }
            return r.ok && r.data ? { ok: true } : r;
          }, "Send recorded. See the history below for the outcome.")}>{resendOf ? "Send again" : "Send quotation to customer"}</Button>
        </div>
      ) : <p className="mt-2 text-sm text-slate-500">{d.status === "CUSTOMER_ACCEPTED" ? "The customer has accepted; nothing further to send." : "Issue the quotation PDF first. Only a Rep can send it."}</p>}
      {d.sends.length > 0 && (
        <ul className="mt-3 divide-y rounded-md border border-slate-200 text-sm" data-testid="send-history">
          {d.sends.map((s) => (
            <li key={s.id} className="space-y-1 p-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span><Badge tone={s.status === "ACCEPTED" ? "success" : s.status === "FAILED" ? "danger" : "warning"}>{s.status}</Badge> {SEND_LABEL[s.status]} · {formatSast(s.at)} · by {s.sentBy}</span>
                <span className="flex gap-2">
                  {s.status === "FAILED" && d.canSend && <Button type="button" variant="secondary" loading={busy} onClick={() => void run(() => retryQuoteSendAction(quoteId, s.id), "Retry recorded.")}>Retry</Button>}
                  {s.status === "ACCEPTED" && d.canSend && <Button type="button" variant="secondary" onClick={() => { setResendOf(s.id); setKey(newKey()); setReviewed(false); }}>Send again…</Button>}
                </span>
              </div>
              <div className="text-xs text-slate-600">To {s.to.join(", ")}{s.cc.length ? ` · CC ${s.cc.join(", ")}` : ""}{s.suppressed.length ? ` · not sent to: ${s.suppressed.join(", ")}` : ""}{s.alternatives.length ? ` · approved non-contact recipients: ${s.alternatives.join(", ")} (reason: ${s.alternativeReason})` : ""}{s.error ? ` · ${s.error}` : ""}{s.resendReason ? ` · re-send reason: ${s.resendReason}` : ""}</div>
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-5 text-sm font-semibold text-slate-800">3 · Customer response</h3>
      {d.responses.length > 0 && (
        <ul className="mt-2 divide-y rounded-md border border-slate-200 text-sm">
          {d.responses.map((r) => <li key={r.id} className="p-2"><b>{r.response.replace("_", " ")}</b> by {r.contact} on {r.respondedOn} · evidence: {r.evidence}{r.note ? ` · ${r.note}` : ""} · recorded by {r.recordedBy}</li>)}
        </ul>
      )}
      {d.canRecord && !d.accepted ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <select className={inputCls} value={resp.response} onChange={(e) => setResp({ ...resp, response: e.target.value as typeof resp.response })}>
            <option value="ACCEPTED">Customer accepted</option><option value="DECLINED">Customer declined</option><option value="CHANGES_REQUESTED">Changes requested</option>
          </select>
          <input className={inputCls} placeholder="Customer contact who responded" value={resp.contactName} onChange={(e) => setResp({ ...resp, contactName: e.target.value })} />
          <input className={inputCls} type="date" value={resp.respondedOn} onChange={(e) => setResp({ ...resp, respondedOn: e.target.value })} />
          <input className={`${inputCls} w-72`} placeholder="Evidence reference (email date / subject, signed copy no.)" value={resp.evidenceRef} onChange={(e) => setResp({ ...resp, evidenceRef: e.target.value })} />
          <input className={`${inputCls} w-72`} placeholder={resp.response === "CHANGES_REQUESTED" ? "What changes were requested" : "Note (optional)"} value={resp.note} onChange={(e) => setResp({ ...resp, note: e.target.value })} />
          <Button type="button" loading={busy} onClick={() => void run(() => recordCustomerResponseAction(quoteId, { documentId: d.latestDocumentId ?? "", ...resp }), "Customer response recorded.")}>Record response</Button>
        </div>
      ) : <p className="mt-2 text-sm text-slate-500">{d.accepted ? "Accepted: this acceptance is final." : "A response can be recorded once the quotation has been issued."}</p>}
      {(d.status === "CHANGES_REQUESTED" || d.status === "CUSTOMER_DECLINED") && <Alert tone="warning">Changes after approval follow the normal revision rules: an approved quotation is frozen, so prepare a revised quotation and take it through Estimator and Manager approval again.</Alert>}
    </Panel>
  );
}
