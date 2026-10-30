"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { formatSast } from "@/lib/approvals/time";
import { getQuoteDeliveryAction, recordCustomerResponseAction, reviewCustomerResponseAction, revokeResponseLinksAction, type DeliveryView, type ResponseRow } from "../delivery-actions";
import { EVIDENCE_ACCEPT, EVIDENCE_MAX_BYTES, EVIDENCE_MAX_FILES, EVIDENCE_MAX_TOTAL } from "@/lib/newquip-quotes/response-evidence-limits";
import type { DeliveryGate } from "./DeliveryPanel";
import { postFormToOwnRoute } from "@/lib/browser/same-origin-upload";

// Stage 5 - Customer Acceptance. Records the customer's response to the ISSUED quotation (who responded, evidence files, the date), shows responses that arrived through the customer's
// emailed link and lets a Rep or Manager VERIFY or REJECT an emailed acceptance. Only a recorded-with-evidence or a verified acceptance of the current issued document opens Project
// Handover; Manager approval, a send, or an unverified emailed acceptance never does. Nothing here touches Cin7 or creates a Project. The server re-checks every permission.
const inputCls = "h-9 rounded-md border border-slate-300 bg-white px-2 text-sm";
const STANDING_TONE: Record<string, BadgeTone> = { RECORDED: "success", VERIFIED: "success", PENDING_VERIFICATION: "warning", EVIDENCE_MISSING: "warning", REJECTED: "danger" };
const STANDING_LABEL: Record<string, string> = { RECORDED: "Recorded", VERIFIED: "Verified", PENDING_VERIFICATION: "Verification pending", EVIDENCE_MISSING: "Evidence needed", REJECTED: "Rejected on verification" };
const RESPONSE_LABEL: Record<string, string> = { ACCEPTED: "Accepted", DECLINED: "Declined", CHANGES_REQUESTED: "Changes requested" };
type ContactChoice = "delivery" | "alt" | number;
const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;

export function AcceptancePanel({ quoteId, onGate }: { quoteId: string; onGate: (g: DeliveryGate) => void }) {
  const [d, setD] = useState<DeliveryView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [response, setResponse] = useState<"ACCEPTED" | "DECLINED" | "CHANGES_REQUESTED">("ACCEPTED");
  const [choice, setChoice] = useState<ContactChoice>("delivery");
  const [alt, setAlt] = useState({ name: "", email: "", reason: "" });
  const [f, setF] = useState({ respondedOn: new Date().toISOString().slice(0, 10), evidenceRef: "", note: "" });
  const [files, setFiles] = useState<File[]>([]);
  const [review, setReview] = useState<Record<string, string>>({});
  const [revokeReason, setRevokeReason] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(async () => {
    const b = await getQuoteDeliveryAction(quoteId);
    if (b.ok && b.data) { setD(b.data); onGate({ requires: b.data.requiresAcceptance, accepted: b.data.accepted, status: b.data.status, hasDocument: b.data.latestDocumentId != null, linkState: b.data.links.state }); } else setErr(b.error ?? "Could not load the customer responses.");
  }, [quoteId, onGate]);
  useEffect(() => { let live = true; void (async () => { if (live) await reload(); })(); return () => { live = false; }; }, [reload]);

  const work = async (what: string, fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
    setBusy(what); setErr(null); setNote(null);
    try { const r = await fn(); if (r.ok) { setNote(done); await reload(); } else setErr(r.error ?? "Failed."); } catch { setErr("Something went wrong. Please try again."); } finally { setBusy(null); }
  };
  const upload = (form: FormData) => postFormToOwnRoute("/api/newquip-quote-responses", form);

  if (!d) return <Panel><PanelTitle>Customer response</PanelTitle><p className="mt-2 text-sm text-slate-500">{err ?? "Loading…"}</p></Panel>;
  if (!d.available) return <Panel><PanelTitle>Customer response</PanelTitle><Alert tone="info">Customer responses become available once the database update for customer quotations (migration 0115) has been applied.</Alert></Panel>;

  const statusTone: BadgeTone = d.status === "CUSTOMER_ACCEPTED" ? "success" : d.status === "ACCEPTANCE_PENDING_VERIFICATION" ? "warning" : d.status === "CUSTOMER_DECLINED" || d.status === "CHANGES_REQUESTED" || d.status === "ACCEPTANCE_REJECTED" ? "danger" : "neutral";
  const needsFile = response === "ACCEPTED" && d.portal;
  const altOk = alt.name.trim().length >= 2 && alt.reason.trim().length >= 5;
  const canSubmit = !!d.latestDocumentId && f.evidenceRef.trim().length >= 3 && (choice !== "alt" || altOk) && (!needsFile || files.length > 0) && (response !== "CHANGES_REQUESTED" || f.note.trim().length >= 3);

  const pick = (list: FileList | null) => {
    const picked = [...(list ?? [])];
    const tooBig = picked.find((x) => x.size > EVIDENCE_MAX_BYTES);
    if (picked.length > EVIDENCE_MAX_FILES) { setErr(`Attach at most ${EVIDENCE_MAX_FILES} files at a time.`); return; }
    if (tooBig) { setErr(`"${tooBig.name}" is larger than ${EVIDENCE_MAX_BYTES / 1024 / 1024} MB.`); return; }
    if (picked.reduce((a, x) => a + x.size, 0) > EVIDENCE_MAX_TOTAL) { setErr(`The files together are larger than ${EVIDENCE_MAX_TOTAL / 1024 / 1024} MB. Attach fewer now and add the rest afterwards.`); return; }
    setErr(null); setFiles(picked);
  };
  const contactJson = () => JSON.stringify(choice === "delivery" ? { source: "DELIVERY_CONTACT" } : choice === "alt" ? { source: "ALTERNATIVE", name: alt.name, email: alt.email, reason: alt.reason } : { source: "CIN7_CONTACT", contactIndex: choice });
  const record = () => work("record", async () => {
    const form = new FormData();
    form.set("intent", "record"); form.set("quoteId", quoteId); form.set("documentId", d.latestDocumentId ?? ""); form.set("response", response); form.set("contact", contactJson());
    form.set("respondedOn", f.respondedOn); form.set("evidenceRef", f.evidenceRef); form.set("note", f.note);
    for (const x of files) form.append("files", x);
    const r = await upload(form);
    if (r.ok) { setFiles([]); if (fileRef.current) fileRef.current.value = ""; setF({ ...f, evidenceRef: "", note: "" }); setAlt({ name: "", email: "", reason: "" }); setChoice("delivery"); }
    return r;
  }, "Customer response recorded.");
  const attach = (r: ResponseRow, input: HTMLInputElement | null) => {
    const picked = [...(input?.files ?? [])];
    if (!picked.length) { setErr("Choose a file to attach."); return; }
    void work(`attach-${r.id}`, async () => {
      const form = new FormData(); form.set("intent", "attach"); form.set("quoteId", quoteId); form.set("responseId", r.id);
      for (const x of picked) form.append("files", x);
      const res = await upload(form); if (res.ok && input) input.value = ""; return res;
    }, "Evidence attached.");
  };
  // legacy (migration 0117 not applied): the contact is recorded as a name only
  const recordLegacy = () => work("record", async () => {
    const name = choice === "alt" ? alt.name : choice === "delivery" ? d.deliveryContact?.name ?? "" : d.responseContacts.find((c) => c.index === choice)?.name ?? "";
    return recordCustomerResponseAction(quoteId, { documentId: d.latestDocumentId ?? "", response, contactName: name, respondedOn: f.respondedOn, evidenceRef: f.evidenceRef, note: f.note });
  }, "Customer response recorded.");

  const pending = d.responses.filter((r) => r.standing === "PENDING_VERIFICATION" && r.documentId === d.latestDocumentId);
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-2"><PanelTitle>Customer response</PanelTitle><Badge tone={statusTone}>{d.statusLabel}</Badge></div>
      <p className="mt-1 text-xs text-slate-500">Record what the customer answered and keep the evidence. Manager approval is not the customer&apos;s acceptance, and an acceptance that arrives by the emailed link only counts once it has been verified here.</p>
      {err && <Alert tone="danger">{err}</Alert>}
      {note && <Alert tone="success">{note}</Alert>}
      {busy && <p role="status" className="mt-2 text-sm text-slate-600">Working…</p>}
      {!d.portal && <Alert tone="info">Choosing the responding contact from Cin7, attaching evidence files and responses from the emailed link become available once the database update for customer responses (migration 0117) has been applied. Responses can still be recorded below.</Alert>}
      {d.portal && d.status !== "CUSTOMER_ACCEPTED" && (
        <p className="mt-2 text-xs text-slate-600" data-testid="link-state">
          {d.links.state === "ACTIVE" ? `The customer's emailed response link is active until ${d.links.expiresOn}.`
            : d.links.state === "EXPIRED" ? "The customer's emailed response link has expired. Send the quotation again (with a reason) to issue a new link."
            : d.links.state === "REVOKED" ? "The customer's emailed response links were withdrawn or replaced. Send the quotation again to issue a new link."
            : "No emailed response link has been issued for the current quotation yet (it is created when the quotation is sent)."}
          {d.links.state === "ACTIVE" && d.canReview && (
            <span className="ml-2 inline-flex items-center gap-2">
              <input className={`${inputCls} w-56`} aria-label="Reason for withdrawing the links" placeholder="Reason to withdraw the links" value={revokeReason} onChange={(e) => setRevokeReason(e.target.value)} />
              <Button type="button" variant="secondary" loading={busy === "revoke"} disabled={revokeReason.trim().length < 3} onClick={() => void work("revoke", () => revokeResponseLinksAction(quoteId, revokeReason), "The response links were withdrawn.")}>Withdraw links</Button>
            </span>
          )}
        </p>
      )}

      {pending.map((r) => (
        <div key={r.id} className="mt-3 space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm" data-testid="pending-acceptance">
          <p className="font-semibold text-slate-900">The customer accepted by email: verification required</p>
          <p>{r.contact}{r.company ? `, ${r.company}` : ""} · {r.contactEmail ?? "no email"} · {formatSast(r.at)}</p>
          <p className="text-slate-700">They confirmed they are authorised to accept for the customer and accepted this exact revision. Check that they really can bind the customer (for example contact them on a known number) before verifying. Nothing is created until you open Project Handover.</p>
          {d.canReview ? (
            <div className="flex flex-wrap items-end gap-2">
              <input className={`${inputCls} w-72`} aria-label="Verification note" placeholder="Note (required to reject)" value={review[r.id] ?? ""} onChange={(e) => setReview({ ...review, [r.id]: e.target.value })} />
              <Button type="button" loading={busy === `v-${r.id}`} onClick={() => void work(`v-${r.id}`, () => reviewCustomerResponseAction(quoteId, { responseId: r.id, decision: "VERIFIED", note: review[r.id] ?? "" }), "Acceptance verified. Project Handover is now available.")}>Verify acceptance</Button>
              <Button type="button" variant="secondary" loading={busy === `r-${r.id}`} disabled={(review[r.id] ?? "").trim().length < 3} onClick={() => void work(`r-${r.id}`, () => reviewCustomerResponseAction(quoteId, { responseId: r.id, decision: "REJECTED", note: review[r.id] ?? "" }), "Acceptance rejected.")}>Reject acceptance</Button>
            </div>
          ) : <p className="text-xs text-slate-600">A Rep or Manager verifies this.</p>}
        </div>
      ))}

      <h3 className="mt-5 text-sm font-semibold text-slate-800">Record a response</h3>
      {d.canRecord && !d.accepted ? (
        <div className="mt-2 space-y-3" data-testid="record-form">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-slate-700">Customer response</span>
              <select className={inputCls} value={response} onChange={(e) => setResponse(e.target.value as typeof response)}>
                <option value="ACCEPTED">Customer accepted</option><option value="DECLINED">Customer declined</option><option value="CHANGES_REQUESTED">Changes requested</option>
              </select></label>
            <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-slate-700">Response date</span><input className={inputCls} type="date" value={f.respondedOn} onChange={(e) => setF({ ...f, respondedOn: e.target.value })} /></label>
          </div>
          <fieldset className="space-y-1.5" disabled={!!busy}>
            <legend className="text-sm font-medium text-slate-700">Who responded</legend>
            {d.deliveryContact && <label className={`flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm ${choice === "delivery" ? "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-500" : "border-slate-300"}`}><input type="radio" name="resp-contact" checked={choice === "delivery"} onChange={() => setChoice("delivery")} /> The contact who received the quotation: <b>{d.deliveryContact.name}</b> &lt;{d.deliveryContact.email}&gt;</label>}
            {d.responseContacts.filter((c) => c.name !== d.deliveryContact?.name || c.email !== d.deliveryContact?.email).map((c) => (
              <label key={c.index} className={`flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm ${choice === c.index ? "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-500" : "border-slate-300"}`}><input type="radio" name="resp-contact" checked={choice === c.index} onChange={() => setChoice(c.index)} /> Another contact of this customer: <b>{c.name}</b>{c.email ? ` <${c.email}>` : ""}</label>
            ))}
            <label className={`flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm ${choice === "alt" ? "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-500" : "border-slate-300"}`}><input type="radio" name="resp-contact" checked={choice === "alt"} onChange={() => setChoice("alt")} /> Someone not listed (exception)</label>
            {choice === "alt" && (
              <div className="flex flex-wrap items-end gap-2 pl-6">
                <input className={inputCls} aria-label="Name" placeholder="Name" value={alt.name} onChange={(e) => setAlt({ ...alt, name: e.target.value })} />
                <input className={inputCls} aria-label="Email (optional)" placeholder="Email (optional)" value={alt.email} onChange={(e) => setAlt({ ...alt, email: e.target.value })} />
                <input className={`${inputCls} w-72`} aria-label="Reason for the exception" placeholder="Reason (required)" value={alt.reason} onChange={(e) => setAlt({ ...alt, reason: e.target.value })} />
                <p className="w-full text-xs text-slate-600">Recorded with your name and the time. This does not create or change a Cin7 contact.</p>
              </div>
            )}
          </fieldset>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-slate-700">Evidence reference</span><input className={`${inputCls} w-80`} placeholder="Email date / subject, or signed copy number" value={f.evidenceRef} onChange={(e) => setF({ ...f, evidenceRef: e.target.value })} /></label>
            <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-slate-700">{response === "CHANGES_REQUESTED" ? "What changes were requested" : "Notes (optional)"}</span><input className={`${inputCls} w-80`} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
          </div>
          {d.portal && (
            <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-slate-700">Supporting evidence{response === "ACCEPTED" ? " (required for an acceptance)" : " (optional)"}</span>
              <input ref={fileRef} type="file" multiple accept={EVIDENCE_ACCEPT} onChange={(e) => pick(e.target.files)} className="text-sm" />
              <span className="text-xs text-slate-500">PDF, JPG, PNG or EML (saved email). Up to {EVIDENCE_MAX_FILES} files, {EVIDENCE_MAX_TOTAL / 1024 / 1024} MB in total per upload (add more later with Add evidence). Stored privately and never overwritten.</span>
              {files.length > 0 && <span className="text-xs text-slate-700">{files.map((x) => `${x.name} (${kb(x.size)})`).join(", ")}</span>}
            </label>
          )}
          <Button type="button" loading={busy === "record"} disabled={!canSubmit} onClick={() => void (d.portal ? record() : recordLegacy())}>Record response</Button>
          {needsFile && files.length === 0 && <p className="text-xs text-amber-700">Attach the evidence (for example the signed quotation or the customer&apos;s confirming email) to record an acceptance.</p>}
        </div>
      ) : <p className="mt-2 text-sm text-slate-500">{d.accepted ? "Accepted: this acceptance is final." : "A response can be recorded once the quotation has been issued. Only a Rep or Manager can record it."}</p>}

      <h3 className="mt-5 text-sm font-semibold text-slate-800">Response history</h3>
      {d.responses.length === 0 ? <p className="mt-2 text-sm text-slate-500">No response has been received yet.</p> : (
        <ul className="mt-2 divide-y rounded-md border border-slate-200 text-sm" data-testid="response-history">
          {d.responses.map((r) => (
            <li key={r.id} className="space-y-1 p-2">
              <div className="flex flex-wrap items-center gap-2">
                <b>{RESPONSE_LABEL[r.response]}</b> <Badge tone={STANDING_TONE[r.standing]}>{STANDING_LABEL[r.standing]}</Badge>
                <span className="text-xs text-slate-500">{r.origin === "CUSTOMER_LINK" ? "via the customer's emailed link" : "recorded by staff"}</span>
              </div>
              <div>{r.contact}{r.company ? `, ${r.company}` : ""}{r.contactEmail ? ` <${r.contactEmail}>` : ""}{r.contactSource ? ` · ${r.contactSource === "DELIVERY_CONTACT" ? "contact who received the quotation" : r.contactSource === "CIN7_CONTACT" ? "Cin7 contact" : r.contactSource === "ALTERNATIVE" ? "alternative contact" : "details given by the customer"}` : ""} · {r.respondedOn} · {r.origin === "CUSTOMER_LINK" ? "received" : "recorded by"} {r.recordedBy} · {formatSast(r.at)}</div>
              {r.exceptionReason && <div className="text-xs text-amber-800">Exception reason: {r.exceptionReason}</div>}
              <div className="text-slate-700">Evidence: {r.evidence}{r.note ? ` · ${r.note}` : ""}{r.origin === "CUSTOMER_LINK" && r.response === "ACCEPTED" ? ` · authority confirmed: ${r.authorityConfirmed ? "yes" : "no"}` : ""}</div>
              {r.review && <div className="text-xs text-slate-600">{r.review.decision === "VERIFIED" ? "Verified" : "Rejected"} by {r.review.by} · {formatSast(r.review.at)}{r.review.note ? ` · ${r.review.note}` : ""}</div>}
              {r.files.length > 0 && (
                <ul className="list-disc pl-5 text-xs">
                  {r.files.map((x) => <li key={x.id}><a className="text-indigo-700 underline" href={`/api/newquip-response-evidence/${x.id}`}>{x.fileName}</a> · {kb(x.bytes)} · uploaded by {x.uploadedBy} · sha256 {x.sha256.slice(0, 12)}…</li>)}
                </ul>
              )}
              {d.portal && d.canRecord && r.origin === "STAFF" && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <input type="file" multiple accept={EVIDENCE_ACCEPT} id={`att-${r.id}`} />
                  <Button type="button" size="sm" variant="secondary" loading={busy === `attach-${r.id}`} onClick={() => attach(r, document.getElementById(`att-${r.id}`) as HTMLInputElement | null)}>Add evidence</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {(d.status === "CHANGES_REQUESTED" || d.status === "CUSTOMER_DECLINED" || d.status === "ACCEPTANCE_REJECTED") && <Alert tone="warning">Changes after approval follow the normal revision rules: an approved quotation is frozen, so prepare a revised quotation and take it through Estimator and Manager approval again.</Alert>}
    </Panel>
  );
}
