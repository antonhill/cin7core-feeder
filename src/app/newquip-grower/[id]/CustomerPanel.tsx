"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Spinner } from "@/app/Spinner";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { formatSast } from "@/lib/approvals/time";
import { chooseQuoteContactAction, clearQuoteCustomerAction, getQuoteCustomerAction, refreshQuoteCustomerAction, searchQuoteCustomersForQuoteAction, selectQuoteCustomerAction, type QuoteCustomerView, type RefreshPreview } from "../customer-actions";
import type { CustomerHit } from "@/lib/newquip-customers/cin7-customer-read";
import { fieldValue, isValidEmail, type Field } from "@/lib/newquip-quotes/customer-snapshot";

// Cin7 customer lookup, quotation contact and the customer-details snapshot. Cin7 stays the master: nothing here is ever written to Cin7. A field Cin7 did not supply is
// shown as "not in Cin7", never as a blank. The server re-checks the Rep role and the organisation on every action.

const show = (f: Field | undefined): string => (!f || f.state === "missing" ? "not in Cin7" : f.state === "empty" ? "blank in Cin7" : f.value);
const inputCls = "h-9 rounded-md border border-slate-300 bg-white px-2 text-sm";

export function CustomerPanel({ quoteId, editable, onPicked }: { quoteId: string; editable: boolean; onPicked: (customerName: string) => void }) {
  const [v, setV] = useState<QuoteCustomerView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // What the server is doing right now (null = idle). Every button that waits on the server shows it: a click is never silent.
  const [label, setLabel] = useState<string | null>(null);
  const busy = label !== null;
  const [searched, setSearched] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CustomerHit[]>([]);
  const [entered, setEntered] = useState({ name: "", email: "", phone: "" });
  const [diff, setDiff] = useState<RefreshPreview | null>(null);
  const [changing, setChanging] = useState(false);
  const [pending, setPending] = useState<{ kind: "replace"; name: string } | { kind: "clear" } | null>(null);
  const [fix, setFix] = useState<{ index: number; email: string; reason: string } | null>(null);

  useEffect(() => {
    let live = true;
    void getQuoteCustomerAction(quoteId).then((r) => { if (!live) return; if (r.ok && r.data) setV(r.data); else setErr(r.error ?? "Could not load the customer details."); });
    return () => { live = false; };
  }, [quoteId]);

  const run = async (fn: () => Promise<{ ok: boolean; error?: string; data?: QuoteCustomerView }>, what = "Saving…") => {
    setLabel(what); setErr(null); setNotice(null);
    try { const r = await fn(); if (r.ok && r.data) { setV(r.data); setDiff(null); } else setErr(r.error ?? "Failed."); } catch { setErr("Something went wrong. Please try again."); } finally { setLabel(null); setPicking(null); }
  };
  const search = async () => {
    setErr(null); setLabel("Searching Cin7 customers…"); setHits([]); setSearched(null);
    try { const r = await searchQuoteCustomersForQuoteAction(q); if (r.ok) { setHits(r.data ?? []); setSearched(q.trim()); } else setErr(r.error ?? "Search failed."); }
    catch { setErr("Search failed. Please try again."); } finally { setLabel(null); }
  };
  const finishPick = (name: string, confirmReplace: boolean) => { setPicking(name); return run(async () => {
    const r = await selectQuoteCustomerAction(quoteId, name, confirmReplace);
    if (r.ok) { onPicked(r.data?.snapshot?.name.state === "present" ? r.data.snapshot.name.value : name); setHits([]); setQ(""); setChanging(false); setPending(null); }
    return r;
  }, "Reading the customer from Cin7…"); };
  // The first selection needs no confirmation; replacing an existing customer asks first (and the server insists on it too).
  const pick = (name: string) => { if (v?.snapshot) setPending({ kind: "replace", name }); else void finishPick(name, false); };
  const confirmPending = () => {
    if (!pending) return;
    if (pending.kind === "replace") void finishPick(pending.name, true);
    else void run(async () => { const r = await clearQuoteCustomerAction(quoteId, true); if (r.ok) { onPicked(""); setHits([]); setChanging(false); setPending(null); } return r; }, "Clearing the customer…");
  };
  const preview = async (apply: boolean) => {
    setLabel(apply ? "Applying the Cin7 changes…" : "Checking Cin7 for changes…"); setErr(null);
    try {
      const r = await refreshQuoteCustomerAction(quoteId, apply);
      if (r.ok && r.data) { setDiff(r.data.preview); setV(r.data.view); } else setErr(r.error ?? "Refresh failed.");
    } catch { setErr("Refresh failed. Please try again."); } finally { setLabel(null); }
  };

  if (!v) return <p className="mt-4 text-sm text-slate-500">{err ?? "Loading customer details…"}</p>;
  if (!v.available) return <Alert tone="info">Cin7 customer lookup becomes available once the database update for customer snapshots has been applied. The customer name above is used until then.</Alert>;
  const s = v.snapshot;
  const a = s?.billingAddress;
  const canChange = v.editable && editable;
  const showSearch = canChange && (!s || changing);
  return (
    <div className="mt-4 space-y-3 rounded-md border border-slate-200 p-3" data-testid="customer-panel">
      <div className="flex items-center gap-2"><span className="text-sm font-semibold text-slate-800">Cin7 customer</span>{s ? <Badge tone="success">Snapshot #{v.seq}</Badge> : <Badge tone="warning">Not selected</Badge>}</div>
      {err && <Alert tone="danger">{err}</Alert>}
      {label && <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-slate-600" data-testid="customer-busy"><Spinner />{label}</p>}
      {!canChange && <Alert tone="info">{v.lockedReason ?? "The customer cannot be changed here."}</Alert>}
      {canChange && s && !changing && !pending && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={() => setChanging(true)}>Change customer</Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => setPending({ kind: "clear" })}>Clear selection</Button>
        </div>
      )}
      {pending && (
        <Alert tone="warning">
          <p className="font-medium">{pending.kind === "replace" ? `Replace ${show(s?.name)} with ${pending.name}?` : `Clear the customer (${show(s?.name)}) from this quotation?`}</p>
          <ul className="mt-1 list-disc pl-4 text-sm">
            <li>The selected contact, delivery email and the other customer-specific details of {show(s?.name)} are removed from this quotation. The earlier snapshot stays in the history.</li>
            <li>{v.changeReturnsToRep ? "This quotation is in estimator review: it goes back to the Rep as a new revision, and the customer's confirmed amount and the estimator's sign-off are withdrawn." : "Any estimator sign-off is withdrawn."}</li>
            <li>Scope, packages and pricing are not changed. Nothing is written to Cin7.</li>
          </ul>
          <div className="mt-2 flex gap-2">
            <Button type="button" disabled={busy} onClick={confirmPending}>{pending.kind === "replace" ? "Replace customer" : "Clear customer"}</Button>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setPending(null)}>Cancel</Button>
          </div>
        </Alert>
      )}
      {showSearch && !pending && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-slate-700">Search by name, contact or email</span>
            <input className={inputCls} value={q} onChange={(e) => { setQ(e.target.value); setSearched(null); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void search(); } }} /></label>
          <Button type="button" variant="secondary" onClick={() => void search()} disabled={busy || q.trim().length < 2} loading={label?.startsWith("Searching") ?? false}>{label?.startsWith("Searching") ? "Searching…" : "Search Cin7 customers"}</Button>
          {changing && <Button type="button" variant="secondary" disabled={busy} onClick={() => { setChanging(false); setHits([]); }}>Keep current customer</Button>}
        </div>
      )}
      {showSearch && !pending && searched !== null && hits.length === 0 && <p className="text-sm text-slate-600" data-testid="no-customer-results">No Cin7 customers matched “{searched}”. Try part of the name, a contact name or an email.</p>}
      {showSearch && !pending && hits.length > 0 && (
        <ul className="divide-y rounded-md border border-slate-200 text-sm">
          {hits.map((h) => (
            <li key={h.name} className="flex items-center justify-between gap-2 p-2">
              <span><b>{h.name}</b>{h.tradingName ? ` (${h.tradingName})` : ""} · {h.contactName ?? "no contact"} · {h.email ?? "no email"} · {h.currency ?? "no currency"}</span>
              <Button type="button" variant="secondary" onClick={() => void pick(h.name)} disabled={busy} loading={picking === h.name}>Select</Button>
            </li>
          ))}
        </ul>
      )}
      {s && (
        <dl className="grid gap-x-6 gap-y-1 text-sm md:grid-cols-2">
          <dt className="text-slate-500">Customer (Cin7 ID {s.cin7CustomerId})</dt><dd>{show(s.name)}</dd>
          <dt className="text-slate-500">Trading name</dt><dd>{show(s.tradingName)}</dd>
          <dt className="text-slate-500">Billing address</dt><dd>{a ? [a.line1, a.line2, a.city, a.state, a.postcode, a.country].map((f) => fieldValue(f)).filter(Boolean).join(", ") || "blank in Cin7" : "no billing address in Cin7"}</dd>
          <dt className="text-slate-500">VAT number</dt><dd>{show(s.vatNumber)}</dd>
          <dt className="text-slate-500">Currency</dt><dd>{show(s.currency)}</dd>
          <dt className="text-slate-500">Payment terms</dt><dd>{show(s.paymentTerm)}</dd>
          <dt className="text-slate-500">Quotation contact</dt><dd>{s.chosenContact ? `${s.chosenContact.name} <${s.chosenContact.email}>${s.chosenContact.source === "ENTERED" ? " (entered by you)" : s.chosenContact.emailCorrection ? " (email corrected for this quotation; Cin7 unchanged)" : ""}` : "not chosen"}</dd>
        </dl>
      )}
      {v.currency?.status === "MISSING" && <Alert tone="warning">{v.currency.message}</Alert>}
      {v.currency?.status === "INCOMPATIBLE" && <Alert tone="danger">{v.currency.message}</Alert>}
      {s && v.issues.length > 0 && <Alert tone="warning"><ul className="list-disc pl-4">{v.issues.map((i) => <li key={i}>{i}</li>)}</ul></Alert>}
      {s && v.editable && editable && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-slate-700">Quotation contact and delivery email</p>
          <div className={`rounded-md border p-2 text-sm ${s.chosenContact ? "border-emerald-300 bg-emerald-50" : "border-amber-300 bg-amber-50"}`} data-testid="selected-contact" aria-live="polite">
            {s.chosenContact
              ? <><b>Selected: {s.chosenContact.name}</b> &lt;{s.chosenContact.email}&gt; — the quotation is addressed, and the send dialog defaults, to this contact.</>
              : "No contact selected yet. Pick one of the Cin7 contacts below."}
            {notice && <span className="ml-2 text-emerald-700">{notice}</span>}
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Cin7 contacts">
            {s.contacts.map((c, i) => {
              const em = fieldValue(c.email);
              const bad = !em || !isValidEmail(em);
              const on = v.selectedContactIndex === i;
              const cls = on ? "ring-2 ring-emerald-500 border-emerald-500 bg-emerald-50" : "";
              return bad ? (
                <Button key={i} type="button" variant="secondary" className={cls} aria-pressed={on} disabled={busy} onClick={() => setFix({ index: i, email: em ?? "", reason: "" })}>
                  {on && "✓ Selected · "}{show(c.name)} · {show(c.email)} — correct email for this quotation
                </Button>
              ) : (
                <Button key={i} type="button" variant="secondary" className={cls} aria-pressed={on} disabled={busy} loading={picking === `contact-${i}`}
                  onClick={() => { setPicking(`contact-${i}`); setNotice(null); void run(async () => { const r = await chooseQuoteContactAction(quoteId, { source: "CIN7_CONTACT", contactIndex: i }); if (r.ok) setNotice(`Contact set to ${show(c.name)}.`); return r; }, "Saving the quotation contact…"); }}>
                  {on && "✓ Selected · "}{show(c.name)} · {show(c.email)}
                </Button>
              );
            })}
            {s.contacts.length === 0 && <span className="text-sm text-slate-500">Cin7 holds no contacts for this customer; add one below.</span>}
          </div>
          {fix && (
            <div className="flex flex-wrap items-end gap-2 rounded-md border border-amber-300 bg-amber-50 p-2" data-testid="email-fix">
              <input className={inputCls} aria-label="Corrected email" placeholder="Corrected email" value={fix.email} onChange={(e) => setFix({ ...fix, email: e.target.value })} />
              <input className={inputCls} aria-label="Reason for the correction" placeholder="Reason (e.g. typo in Cin7)" value={fix.reason} onChange={(e) => setFix({ ...fix, reason: e.target.value })} />
              <Button type="button" disabled={busy} onClick={() => void run(async () => { const r = await chooseQuoteContactAction(quoteId, { source: "CIN7_CONTACT", contactIndex: fix.index, email: fix.email, correctionReason: fix.reason }); if (r.ok) setFix(null); return r; })}>Use corrected email</Button>
              <Button type="button" variant="secondary" disabled={busy} onClick={() => setFix(null)}>Cancel</Button>
              <p className="w-full text-xs text-slate-600">Used on this quotation only and recorded with your reason. The Cin7 contact is not changed.</p>
            </div>
          )}
          <fieldset className="space-y-2 rounded-md border border-slate-200 p-2">
            <legend className="px-1 text-sm font-medium text-slate-700">Add or correct contact</legend>
            <div className="flex flex-wrap items-end gap-2">
            <input className={inputCls} placeholder="Contact name" value={entered.name} onChange={(e) => setEntered({ ...entered, name: e.target.value })} />
            <input className={inputCls} placeholder="Delivery email" value={entered.email} onChange={(e) => setEntered({ ...entered, email: e.target.value })} />
            <input className={inputCls} placeholder="Phone (optional)" value={entered.phone} onChange={(e) => setEntered({ ...entered, phone: e.target.value })} />
            <Button type="button" variant="secondary" disabled={busy} onClick={() => void run(() => chooseQuoteContactAction(quoteId, { source: "ENTERED", ...entered }))}>Use this contact</Button>
            </div>
            <p className="text-xs text-slate-500">Separate from the Cin7 contacts above. Entered contacts are validated and audited, used on this quotation only, and never written to Cin7.</p>
          </fieldset>
          <div className="flex items-center gap-2">
            <Button type="button" variant="secondary" disabled={busy} loading={label === "Checking Cin7 for changes…"} onClick={() => void preview(false)}>Check Cin7 for changes</Button>
            {diff && diff.changes.length > 0 && !diff.applied && <Button type="button" disabled={busy} onClick={() => void preview(true)}>Apply {diff.changes.length} change{diff.changes.length === 1 ? "" : "s"}</Button>}
          </div>
          {diff && (diff.changes.length === 0
            ? <p className="text-sm text-emerald-700">The snapshot matches Cin7.</p>
            : <ul className="list-disc pl-5 text-sm">{diff.changes.map((c) => <li key={c.field}><b>{c.field}</b>: {c.before} → {c.after}{diff.applied ? " (applied)" : ""}</li>)}</ul>)}
        </div>
      )}
      {v.history.length > 0 && <p className="text-xs text-slate-500">History: {v.history.map((h) => `#${h.seq}${h.cleared ? " cleared" : ""} ${h.by} ${formatSast(h.at)}`).join(" · ")}</p>}
    </div>
  );
}
