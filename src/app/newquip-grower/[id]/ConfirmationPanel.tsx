"use client";

import { DisabledReason } from "@/components/ApprovalDisabledReason";
import { useEffect, useId, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Status } from "@/components/ui/Status";
import { Button } from "@/components/ui/Button";
import { formatSast } from "@/lib/approvals/time";
import { getQuoteCustomerAction, type QuoteCustomerView } from "../customer-actions";
import { fieldValue } from "@/lib/newquip-quotes/customer-snapshot";
import type { ConfirmationInput } from "@/lib/newquip-quotes/confirmation-contact";

// Step 5 (Submit to Estimator): the PRE-APPROVAL price confirmation. It is NOT the customer's formal acceptance of the issued quotation (recorded separately, after Manager approval). The contact
// defaults to the quotation contact chosen in step 1 (shown read-only; "someone else confirmed" stays available, collapsed); the delivery contact is shown separately and is never changed here. The server resolves the contact from the saved
// snapshot, so nothing typed here can impersonate a Cin7 contact.

const inputCls = "h-11 rounded-md border border-slate-300 bg-white px-2 text-sm";

export function ConfirmationPanel({ quoteId, amountLabel, canAct, ready, loading, otherBusy = false, refreshKey, recorded, onConfirm, indicativeLines = 0 }: {
  /** UX-007: ANOTHER action is running - the send button waits (without a spinner of its own) so two actions cannot overlap. */ otherBusy?: boolean;
  /** > 0: the total is INDICATIVE while this many lines await the Estimator (the Rep confirms the current figure). */ indicativeLines?: number;
  quoteId: string; amountLabel: string | null; canAct: boolean; ready: boolean; loading: boolean; refreshKey: string; recorded: boolean; onConfirm: (c: ConfirmationInput) => void;
}) {
  const [v, setV] = useState<QuoteCustomerView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [choice, setChoice] = useState<"default" | "alt" | number>("default");
  const [alt, setAlt] = useState({ name: "", email: "", reason: "" });
  // Explicit client-side confirmation: the Rep ticks that the named person confirmed THIS total. It is bound to the total and the person, so changing either clears it. The action itself is unchanged.
  const [ackFor, setAckFor] = useState<string | null>(null);
  const ackId = useId();

  useEffect(() => {
    let live = true;
    void getQuoteCustomerAction(quoteId).then((r) => { if (!live) return; if (r.ok && r.data) { setV(r.data); setErr(null); } else setErr(r.error ?? "Could not load the customer contacts."); });
    return () => { live = false; };
  }, [quoteId, refreshKey]);

  if (!v) return <p className="text-sm text-slate-600">{err ?? "Loading the confirmation contact…"}</p>;
  const s = v.snapshot;
  const customer = s ? fieldValue(s.name) ?? "(no name in Cin7)" : null;
  const rc = v.confirmationContact;

  if (recorded) {
    return (
      <div className="rounded-md border border-slate-200 p-3 text-sm" data-testid="confirmation-recorded">
        <div className="flex items-center gap-2 font-medium text-slate-800">Customer price confirmation {rc ? <Status tone="success">Recorded</Status> : <Status tone="warning">Contact not on record</Status>}</div>
        {rc ? (
          <p className="mt-1 text-slate-700">{rc.name}{rc.email ? ` <${rc.email}>` : ""} · {rc.origin}{rc.reason ? ` · reason: ${rc.reason}` : ""} · confirmed by {rc.selectedBy} on {formatSast(rc.selectedAt)}</p>
        ) : <p className="mt-1 text-slate-600">No structured contact record (confirmed before contact selection existed).</p>}
        <p className="mt-1 text-xs text-slate-600">This is the customer price confirmation. The customer&apos;s formal acceptance of the issued quotation is recorded separately after Manager approval.</p>
      </div>
    );
  }

  const quotationContact = s?.chosenContact ?? null;
  const cin7Contacts = (s?.contacts ?? []).map((c, i) => ({ i, name: fieldValue(c.name), email: fieldValue(c.email) })).filter((c) => c.name);
  let picked: { name: string; email: string | null; origin: string } | null = null;
  let input: ConfirmationInput | null = null;
  if (choice === "default") {
    if (quotationContact) { picked = { name: quotationContact.name, email: quotationContact.email, origin: quotationContact.source === "ENTERED" || quotationContact.emailCorrection ? "Quotation-only contact (audited; not written to Cin7)" : "Cin7 contact" }; input = { source: "QUOTATION_CONTACT" }; }
  } else if (choice === "alt") {
    if (alt.name.trim().length >= 2 && alt.reason.trim().length >= 5) { picked = { name: alt.name.trim(), email: alt.email.trim() || null, origin: "Alternative contact (not listed)" }; input = { source: "ALTERNATIVE", name: alt.name, email: alt.email, reason: alt.reason }; }
  } else {
    const c = cin7Contacts.find((x) => x.i === choice);
    if (c) { picked = { name: c.name!, email: c.email, origin: "Cin7 contact" }; input = { source: "CIN7_CONTACT", contactIndex: c.i }; }
  }
  const ackKey = `${amountLabel ?? ""}|${picked?.name ?? ""}|${picked?.email ?? ""}`;
  const blocked = !v.available ? null : !s ? "Select the Cin7 customer and quotation contact in step 1 (Customer & contact) first." : null;
  const sendWhy = loading ? "Submitting to the Estimator is in progress. Please wait."
    : otherBusy ? "Another action is in progress. Please wait."
    : !canAct ? "Only a Rep can record the price confirmation and send the quote to the Estimator."
    : !ready ? "The quotation must be complete (nothing outstanding) before the price can be confirmed."
    : !amountLabel ? "The quote total is not available yet, so there is no amount to confirm."
    : v.available && !s ? "Select the Cin7 customer and quotation contact in step 1 (Customer & contact) first."
    : !input ? "Choose who confirmed the price (for someone not listed enter a name and a reason)."
    : ackFor !== ackKey ? "Tick the confirmation above to enable Submit to Estimator."
    : undefined;
  const radio = "flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm";

  return (
    <div className="space-y-3" data-testid="confirmation-panel">
      {err && <Alert tone="danger">{err}</Alert>}
      {blocked && <Alert tone="warning">{blocked}</Alert>}
      <div className="text-sm" data-testid="confirmed-by-line">
        {choice === "default" && quotationContact
          ? <p>Customer price confirmed by <b>{quotationContact.name}</b> &lt;{quotationContact.email}&gt; <span className="text-slate-600">· the quotation contact from step 1{customer ? ` at ${customer}` : ""}</span></p>
          : choice === "default" ? <p className="text-amber-900">No quotation contact is chosen yet: choose one in step 1, or say who else confirmed the price below.</p>
          : <p>Customer price confirmed by <b>{picked ? `${picked.name}${picked.email ? ` <${picked.email}>` : ""}` : "—"}</b>{picked && <span className="text-slate-600"> · {picked.origin}</span>}</p>}
      </div>
      {s && (
        <details className="rounded-md border border-slate-200 p-2 text-sm" data-testid="alt-confirmer" open={choice !== "default" ? true : undefined}>
          <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-slate-700">Price confirmed by someone other than the quotation contact (optional)</summary>
          <p className="mt-2 text-xs text-slate-600">Use this only if a different person at the customer confirmed the price. It records who confirmed; it does not change who the quotation is sent to (the contact from step 1).</p>
          <fieldset className="mt-2 space-y-2" disabled={!canAct || loading}>
            <legend className="sr-only">Who confirmed the price</legend>
            <label className={`${radio} ${choice === "default" ? "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-500" : "border-slate-300"}`}>
              <input type="radio" className="size-6" name="confirm-contact" checked={choice === "default"} onChange={() => setChoice("default")} />
              <span>The quotation contact (default): {quotationContact ? <b>{quotationContact.name} &lt;{quotationContact.email}&gt;</b> : <i>not chosen in step 1</i>}</span>
            </label>
            {cin7Contacts.map((c) => (
              <label key={c.i} className={`${radio} ${choice === c.i ? "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-500" : "border-slate-300"}`}>
                <input type="radio" className="size-6" name="confirm-contact" checked={choice === c.i} onChange={() => setChoice(c.i)} />
                <span>Another Cin7 contact: <b>{c.name}</b>{c.email ? ` <${c.email}>` : " (no email)"}</span>
              </label>
            ))}
            <label className={`${radio} ${choice === "alt" ? "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-500" : "border-slate-300"}`}>
              <input type="radio" className="size-6" name="confirm-contact" checked={choice === "alt"} onChange={() => setChoice("alt")} />
              <span>Someone not listed in Cin7</span>
            </label>
            {choice === "alt" && (
              <div className="flex flex-wrap items-end gap-2 pl-6">
                <input className={inputCls} aria-label="Alternative contact name" placeholder="Name" value={alt.name} onChange={(e) => setAlt({ ...alt, name: e.target.value })} />
                <input className={inputCls} aria-label="Alternative contact email (optional)" placeholder="Email (optional)" value={alt.email} onChange={(e) => setAlt({ ...alt, email: e.target.value })} />
                <input className={`${inputCls} min-w-64`} aria-label="Reason for using another contact" placeholder="Reason (required)" value={alt.reason} onChange={(e) => setAlt({ ...alt, reason: e.target.value })} />
                <p className="w-full text-xs text-slate-600">Recorded with your name and the time. This does not create or change a Cin7 contact.</p>
              </div>
            )}
          </fieldset>
        </details>
      )}
      <div className="border-t border-slate-100 pt-3 text-sm">
        <p>{indicativeLines > 0 ? "Indicative total confirmed (ex VAT)" : "Quote total confirmed (ex VAT)"}: <b>{amountLabel ?? "not available yet"}</b></p>
        <p className="mt-1 text-xs text-slate-700" data-testid="submit-effects">Submitting records the customer&apos;s price confirmation above, notifies the Estimator and moves the quotation to Estimator review. Any unsaved edits are saved first. This is not an approval and not the customer&apos;s formal acceptance, which comes after Manager approval.</p>
        {picked && amountLabel && (
          <label htmlFor={ackId} className="mt-3 flex min-h-11 cursor-pointer items-start gap-2 rounded-md border border-slate-300 p-2 text-sm text-slate-900" data-testid="confirm-ack">
            <input id={ackId} type="checkbox" className="mt-0.5 size-6 shrink-0" checked={ackFor === ackKey} disabled={!canAct || loading || !ready} onChange={(e) => setAckFor(e.target.checked ? ackKey : null)} />
            <span>I confirm that <b>{picked.name}</b> has confirmed the {indicativeLines > 0 ? "indicative " : ""}quotation total of <b>{amountLabel}</b> ex VAT.</span>
          </label>
        )}
        <div className="mt-3">
          <Button className="min-h-11" loading={loading} aria-describedby={sendWhy ? "send-estimator-why" : undefined} disabled={otherBusy || !canAct || !ready || !amountLabel || !input || (v.available && !s) || ackFor !== ackKey} onClick={() => input && onConfirm(input)}>Submit to Estimator</Button>
        </div>
        {!recorded && <div className="mt-1"><DisabledReason id="send-estimator-why">{sendWhy}</DisabledReason></div>}
      </div>
    </div>
  );
}
