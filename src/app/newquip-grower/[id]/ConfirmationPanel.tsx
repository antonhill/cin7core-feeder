"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { formatSast } from "@/lib/approvals/time";
import { getQuoteCustomerAction, type QuoteCustomerView } from "../customer-actions";
import { fieldValue } from "@/lib/newquip-quotes/customer-snapshot";
import type { ConfirmationInput } from "@/lib/newquip-quotes/confirmation-contact";

// Step 4: the PRE-APPROVAL price confirmation. It is NOT the customer's formal acceptance of the issued quotation (recorded separately, after Manager approval). The contact
// defaults to the quotation contact chosen in Step 1; the delivery contact is shown separately and is never changed here. The server resolves the contact from the saved
// snapshot, so nothing typed here can impersonate a Cin7 contact.

const inputCls = "h-9 rounded-md border border-slate-300 bg-white px-2 text-sm";

export function ConfirmationPanel({ quoteId, amountLabel, canAct, ready, loading, refreshKey, recorded, onConfirm }: {
  quoteId: string; amountLabel: string | null; canAct: boolean; ready: boolean; loading: boolean; refreshKey: string; recorded: boolean; onConfirm: (c: ConfirmationInput) => void;
}) {
  const [v, setV] = useState<QuoteCustomerView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [choice, setChoice] = useState<"default" | "alt" | number>("default");
  const [alt, setAlt] = useState({ name: "", email: "", reason: "" });

  useEffect(() => {
    let live = true;
    void getQuoteCustomerAction(quoteId).then((r) => { if (!live) return; if (r.ok && r.data) { setV(r.data); setErr(null); } else setErr(r.error ?? "Could not load the customer contacts."); });
    return () => { live = false; };
  }, [quoteId, refreshKey]);

  if (!v) return <p className="text-sm text-slate-500">{err ?? "Loading the confirmation contact…"}</p>;
  const s = v.snapshot;
  const customer = s ? fieldValue(s.name) ?? "(no name in Cin7)" : null;
  const rc = v.confirmationContact;

  if (recorded) {
    return (
      <div className="rounded-md border border-slate-200 p-3 text-sm" data-testid="confirmation-recorded">
        <div className="flex items-center gap-2 font-medium text-slate-800">Pre-approval price confirmation {rc ? <Badge tone="success">Recorded</Badge> : <Badge tone="warning">Contact not on record</Badge>}</div>
        {rc ? (
          <p className="mt-1 text-slate-700">{rc.name}{rc.email ? ` <${rc.email}>` : ""} · {rc.origin}{rc.reason ? ` · reason: ${rc.reason}` : ""} · confirmed by {rc.selectedBy} on {formatSast(rc.selectedAt)}</p>
        ) : <p className="mt-1 text-slate-600">No structured contact record (confirmed before contact selection existed).</p>}
        <p className="mt-1 text-xs text-slate-500">This is the pre-approval price confirmation. The customer&apos;s formal acceptance of the issued quotation is recorded separately after Manager approval.</p>
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
  const blocked = !v.available ? null : !s ? "Select the Cin7 customer and quotation contact in Step 1 (Customer & site) first." : null;
  const radio = "flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm";

  return (
    <div className="space-y-3 rounded-md border border-slate-200 p-3" data-testid="confirmation-panel">
      <p className="text-sm font-medium text-slate-800">Pre-approval price confirmation</p>
      <p className="text-xs text-slate-500">Record who at the customer confirmed the commercial amount. This is not the customer&apos;s formal acceptance of the issued quotation, which is recorded after Manager approval.</p>
      {err && <Alert tone="danger">{err}</Alert>}
      {blocked && <Alert tone="warning">{blocked}</Alert>}
      {customer && <p className="text-sm text-slate-700">Customer: <b>{customer}</b></p>}
      {s && (
        <fieldset className="space-y-2" disabled={!canAct || loading}>
          <legend className="text-sm font-medium text-slate-700">Confirmation contact</legend>
          <label className={`${radio} ${choice === "default" ? "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-500" : "border-slate-300"}`}>
            <input type="radio" name="confirm-contact" checked={choice === "default"} onChange={() => setChoice("default")} />
            <span>Quotation contact (default): {quotationContact ? <b>{quotationContact.name} &lt;{quotationContact.email}&gt;</b> : <i>not chosen in Step 1</i>}</span>
          </label>
          {cin7Contacts.map((c) => (
            <label key={c.i} className={`${radio} ${choice === c.i ? "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-500" : "border-slate-300"}`}>
              <input type="radio" name="confirm-contact" checked={choice === c.i} onChange={() => setChoice(c.i)} />
              <span>Cin7 contact: <b>{c.name}</b>{c.email ? ` <${c.email}>` : " (no email)"}</span>
            </label>
          ))}
          <label className={`${radio} ${choice === "alt" ? "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-500" : "border-slate-300"}`}>
            <input type="radio" name="confirm-contact" checked={choice === "alt"} onChange={() => setChoice("alt")} />
            <span>Someone not listed (alternative contact)</span>
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
      )}
      {quotationContact && <p className="text-xs text-slate-500">Delivery contact for the PDF (unchanged by this): {quotationContact.name} &lt;{quotationContact.email}&gt;</p>}
      <div className="border-t border-slate-100 pt-3 text-sm">
        <p>Pre-approval amount confirmed: <b>{amountLabel ? `${amountLabel} ex VAT` : "not available yet"}</b></p>
        <p>Confirmation contact: <b>{picked ? `${picked.name}${picked.email ? ` <${picked.email}>` : ""}` : "—"}</b>{picked && <span className="text-slate-500"> · {picked.origin}</span>}</p>
        <div className="mt-2">
          <Button loading={loading} disabled={!canAct || !ready || !amountLabel || !input || (v.available && !s)} onClick={() => input && onConfirm(input)}>Record pre-approval price confirmation &amp; send to Estimator</Button>
        </div>
        {!ready && <p className="mt-1 text-xs text-amber-700">The quote must be READY before the amount can be confirmed.</p>}
        {choice === "default" && !quotationContact && s && <p className="mt-1 text-xs text-amber-700">No quotation contact is chosen yet: choose one in Step 1, or pick a contact above.</p>}
      </div>
    </div>
  );
}
