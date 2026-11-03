"use client";

import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Spinner } from "@/app/Spinner";
import { Status } from "@/components/ui/Status";
import { Button } from "@/components/ui/Button";
import { formatSast } from "@/lib/approvals/time";
import { chooseQuoteContactAction, clearQuoteCustomerAction, getQuoteCustomerAction, refreshQuoteCustomerAction, searchQuoteCustomersForQuoteAction, selectQuoteCustomerAction, type QuoteCustomerView, type RefreshPreview } from "../customer-actions";
import type { CustomerHit } from "@/lib/newquip-customers/cin7-customer-read";
import { fieldValue, isValidEmail, type Field } from "@/lib/newquip-quotes/customer-snapshot";
import type { Stage1CustomerFacts } from "@/newquip/quote/stage1-steps";

// Cin7 customer lookup, quotation contact and the customer-details snapshot. Cin7 stays the master: nothing here is ever written to Cin7. A field Cin7 did not supply is
// shown as "not in Cin7", never as a blank. The server re-checks the Rep role and the organisation on every action.

const show = (f: Field | undefined): string => (!f || f.state === "missing" ? "not in Cin7" : f.state === "empty" ? "blank in Cin7" : f.value);
const inputCls = "h-11 rounded-md border border-slate-300 bg-white px-2 text-sm";

export function CustomerPanel({ quoteId, editable, onPicked, onFacts }: { quoteId: string; editable: boolean; onPicked: (customerName: string) => void; onFacts?: (facts: Stage1CustomerFacts) => void }) {
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
  const [adding, setAdding] = useState(false);

  // The Stage 1 step rail reads what this panel already loaded (no extra request): the snapshot and whether a contact is chosen.
  const factsRef = useRef(onFacts);
  useEffect(() => { factsRef.current = onFacts; });
  useEffect(() => {
    if (!v) return;
    const chosen = v.snapshot?.chosenContact ?? null;
    const title = v.snapshot ? (v.snapshot.tradingName.state === "present" ? v.snapshot.tradingName.value : v.snapshot.name.state === "present" ? v.snapshot.name.value : null) : null;
    factsRef.current?.({ loaded: true, available: v.available, hasSnapshot: !!v.snapshot, hasContact: !!chosen || !!v.confirmationContact, contactName: chosen?.name ?? v.confirmationContact?.name ?? null, contactEmail: chosen?.email ?? v.confirmationContact?.email ?? null, customerTitle: title });
  }, [v]);

  useEffect(() => {
    let live = true;
    const failed = (message: string) => { setErr(message); factsRef.current?.({ loaded: true, available: true, hasSnapshot: false, hasContact: false, contactName: null, loadError: true }); };
    void getQuoteCustomerAction(quoteId).then((r) => { if (!live) return; if (r.ok && r.data) setV(r.data); else failed(r.error ?? "Could not load the customer details."); }).catch(() => { if (live) failed("Could not load the customer details."); });
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

  if (!v) return <p className="mt-4 text-sm text-slate-600">{err ?? "Loading customer details…"}</p>;
  if (!v.available) return <Alert tone="info">Cin7 customer lookup becomes available once the database update for customer snapshots has been applied. The customer name typed above is used until then.</Alert>;
  const s = v.snapshot;
  const a = s?.billingAddress;
  const canChange = v.editable && editable;
  const showSearch = canChange && (!s || changing);
  return (
    <div className="mt-4 space-y-3 rounded-md border border-slate-200 p-3" data-testid="customer-panel">
      <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold text-slate-800">Cin7 customer</span>{s ? <Status tone="success">Selected</Status> : <Status tone="warning">Not selected</Status>}</div>
      {err && <Alert tone="danger">{err}</Alert>}
      {label && <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-slate-600" data-testid="customer-busy"><Spinner />{label}</p>}
      {!canChange && <Alert tone="info">{v.lockedReason ?? "The customer cannot be changed here."}</Alert>}
      {canChange && s && !changing && !pending && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" className="min-h-11" disabled={busy} onClick={() => setChanging(true)}>Change customer</Button>
          <Button type="button" variant="secondary" className="min-h-11" disabled={busy} onClick={() => setPending({ kind: "clear" })}>Clear selection</Button>
        </div>
      )}
      {pending && (
        <Alert tone="warning">
          <p className="font-medium" data-testid="replace-warning-title">{pending.kind === "replace" ? `Replace ${show(s?.name)} with ${pending.name}?` : `Clear the customer (${show(s?.name)}) from this quotation?`}</p>
          <p className="mt-1 text-sm">Before you confirm, this is what it does:</p>
          <ul className="mt-1 list-disc pl-4 text-sm" data-testid="replace-warning-effects">
            <li>The quotation contact and delivery email chosen for {show(s?.name)} are dropped; choose the contact again for the new customer.</li>
            <li>The price confirmation and any Estimator sign-off are withdrawn.</li>
            <li>{v.changeReturnsToRep ? "This quotation is in Estimator review: it returns to the Rep as a new revision." : "If the quotation is in Estimator review it returns to the Rep as a new revision."}</li>
            <li>The measurements, equipment, quantities and prices you entered are kept. The earlier customer snapshot stays in the history. Nothing is written to Cin7.</li>
          </ul>
          <div className="mt-2 flex gap-2">
            <Button type="button" className="min-h-11" disabled={busy} onClick={confirmPending}>{pending.kind === "replace" ? "Replace customer" : "Clear customer"}</Button>
            <Button type="button" className="min-h-11" variant="secondary" disabled={busy} onClick={() => { setPending(null); setChanging(false); setHits([]); setQ(""); setSearched(null); }}>Cancel</Button>
          </div>
        </Alert>
      )}
      {showSearch && !pending && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-slate-700">Search by name, contact or email</span>
            <input className={inputCls} value={q} onChange={(e) => { setQ(e.target.value); setSearched(null); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void search(); } }} /></label>
          <Button type="button" className="min-h-11" variant="secondary" onClick={() => void search()} disabled={busy || q.trim().length < 2} loading={label?.startsWith("Searching") ?? false}>{label?.startsWith("Searching") ? "Searching…" : "Search Cin7 customers"}</Button>
          {changing && <Button type="button" className="min-h-11" variant="secondary" disabled={busy} onClick={() => { setChanging(false); setHits([]); }}>Keep current customer</Button>}
        </div>
      )}
      {showSearch && !pending && q.trim().length < 2 && <p className="text-sm text-slate-700" data-testid="search-min">Type at least 2 characters to search.</p>}
      {showSearch && !pending && searched !== null && hits.length === 0 && <p className="text-sm text-slate-600" data-testid="no-customer-results">No customers found for “{searched}”. Try part of the name, a contact name or an email.</p>}
      {showSearch && !pending && hits.length > 0 && (
        <ul className="divide-y rounded-md border border-slate-200 text-sm">
          {hits.map((h) => (
            <li key={h.name} className="flex items-center justify-between gap-2 p-2">
              <span><b>{h.name}</b>{h.tradingName ? ` (${h.tradingName})` : ""} · {h.contactName ?? "no contact"} · {h.email ?? "no email"} · {h.currency ?? "no currency"}</span>
              <Button type="button" className="min-h-11" variant="secondary" onClick={() => void pick(h.name)} disabled={busy} loading={picking === h.name}>Select</Button>
            </li>
          ))}
        </ul>
      )}
      {s && (
        <div className="space-y-1" data-testid="customer-summary">
          <h3 className="text-lg font-semibold text-slate-900" data-testid="customer-title">{s.tradingName.state === "present" ? s.tradingName.value : show(s.name)}</h3>
          <p className="text-sm text-slate-700">
            {s.tradingName.state === "present" && <>Registered name: {show(s.name)} · </>}
            Currency {show(s.currency)} · Payment terms {show(s.paymentTerm)} · VAT {show(s.vatNumber)}
          </p>
        </div>
      )}
      {v.currency?.status === "MISSING" && <Alert tone="warning">{v.currency.message}</Alert>}
      {v.currency?.status === "INCOMPATIBLE" && <Alert tone="danger">{v.currency.message}</Alert>}
      {s && v.issues.length > 0 && <Alert tone="warning"><ul className="list-disc pl-4">{v.issues.map((i) => <li key={i}>{i}</li>)}</ul></Alert>}
      {s && (
        <div className="space-y-2" data-testid="contact-chooser">
          <p className="text-sm font-medium text-slate-800" id={`${quoteId}-contact-label`}>Quotation contact</p>
          {s.chosenContact
            ? <p className="text-sm text-slate-800" data-testid="selected-contact" aria-live="polite">
                <Status tone="success">Selected</Status> <b>{s.chosenContact.name}</b>
                {s.chosenContact.source === "ENTERED" ? " (quotation-only contact)" : s.chosenContact.emailCorrection ? " (email corrected for this quotation; Cin7 unchanged)" : ""}
                {notice && <span className="ml-2 text-emerald-700">{notice}</span>}
              </p>
            : <p className="text-sm text-amber-900" data-testid="selected-contact" aria-live="polite">No contact selected yet. Choose one of the Cin7 contacts below, or add a quotation-only contact.</p>}
          {s.chosenContact && <p className="text-sm text-slate-800" data-testid="send-to-line">Quotation will be sent to <b>{s.chosenContact.email}</b></p>}
          {v.editable && editable && (<>
          <div className="flex flex-wrap gap-2" role="group" aria-labelledby={`${quoteId}-contact-label`}>
            {s.contacts.map((c, i) => {
              const em = fieldValue(c.email);
              const bad = !em || !isValidEmail(em);
              const on = v.selectedContactIndex === i;
              const cls = `h-auto! min-h-11 whitespace-normal! py-2 text-left ${on ? "ring-2 ring-emerald-500 border-emerald-500 bg-emerald-50" : ""}`;
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
            <Button type="button" variant="secondary" className={`min-h-11 ${s.chosenContact?.source === "ENTERED" ? "ring-2 ring-emerald-500 border-emerald-500 bg-emerald-50" : ""}`} aria-pressed={s.chosenContact?.source === "ENTERED"} aria-expanded={adding} disabled={busy} onClick={() => setAdding((a) => !a)}>
              {s.chosenContact?.source === "ENTERED" && "✓ Selected · "}Quotation-only contact{s.chosenContact?.source === "ENTERED" ? `: ${s.chosenContact.name}` : "…"}
            </Button>
            {s.contacts.length === 0 && <span className="self-center text-sm text-slate-600">Cin7 holds no contacts for this customer; add a quotation-only contact.</span>}
          </div>
          {fix && (
            <div className="flex flex-wrap items-end gap-2 rounded-md border border-amber-300 bg-amber-50 p-2" data-testid="email-fix">
              <input className={inputCls} aria-label="Corrected email" placeholder="Corrected email" value={fix.email} onChange={(e) => setFix({ ...fix, email: e.target.value })} />
              <input className={inputCls} aria-label="Reason for the correction" placeholder="Reason (e.g. typo in Cin7)" value={fix.reason} onChange={(e) => setFix({ ...fix, reason: e.target.value })} />
              <Button type="button" className="min-h-11" disabled={busy} onClick={() => void run(async () => { const r = await chooseQuoteContactAction(quoteId, { source: "CIN7_CONTACT", contactIndex: fix.index, email: fix.email, correctionReason: fix.reason }); if (r.ok) setFix(null); return r; })}>Use corrected email</Button>
              <Button type="button" className="min-h-11" variant="secondary" disabled={busy} onClick={() => setFix(null)}>Cancel</Button>
              <p className="w-full text-xs text-slate-600">Used on this quotation only and recorded with your reason. The Cin7 contact is not changed.</p>
            </div>
          )}
          {adding && (
            <fieldset className="space-y-2 rounded-md border border-slate-200 p-2">
              <legend className="px-1 text-sm font-medium text-slate-700">Quotation-only contact</legend>
              <div className="flex flex-wrap items-end gap-2">
              <input className={inputCls} aria-label="Contact name" placeholder="Contact name" value={entered.name} onChange={(e) => setEntered({ ...entered, name: e.target.value })} />
              <input className={inputCls} aria-label="Delivery email" placeholder="Delivery email" value={entered.email} onChange={(e) => setEntered({ ...entered, email: e.target.value })} />
              <input className={inputCls} aria-label="Phone (optional)" placeholder="Phone (optional)" value={entered.phone} onChange={(e) => setEntered({ ...entered, phone: e.target.value })} />
              <Button type="button" className="min-h-11" disabled={busy} onClick={() => void run(async () => { const r = await chooseQuoteContactAction(quoteId, { source: "ENTERED", ...entered }); if (r.ok) { setAdding(false); setEntered({ name: "", email: "", phone: "" }); } return r; })}>Use this contact</Button>
              </div>
              <p className="text-xs text-slate-600">For a person who is not in Cin7: recorded in the audit trail and used on this quotation only; it is not written to Cin7.</p>
            </fieldset>
          )}
          </>)}
        </div>
      )}
      {s && (
        <details className="rounded-md border border-slate-200 p-2 text-sm" data-testid="customer-details">
          <summary className="cursor-pointer font-medium text-slate-700">Details (Cin7 reference, address, history)</summary>
          <dl className="mt-2 grid gap-x-6 gap-y-1 md:grid-cols-2">
            <dt className="text-slate-600">Cin7 customer ID</dt><dd className="break-all">{s.cin7CustomerId}</dd>
            <dt className="text-slate-600">Customer snapshot</dt><dd>#{v.seq}</dd>
            <dt className="text-slate-600">Billing address</dt><dd>{a ? [a.line1, a.line2, a.city, a.state, a.postcode, a.country].map((f) => fieldValue(f)).filter(Boolean).join(", ") || "blank in Cin7" : "no billing address in Cin7"}</dd>
          </dl>
          {v.history.length > 0 && <p className="mt-2 text-xs text-slate-600">History: {v.history.map((h) => `#${h.seq}${h.cleared ? " cleared" : ""} ${h.by} ${formatSast(h.at)}`).join(" · ")}</p>}
          {v.editable && editable && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button type="button" className="min-h-11" variant="secondary" disabled={busy} loading={label === "Checking Cin7 for changes…"} onClick={() => void preview(false)}>Check Cin7 for changes</Button>
              {diff && diff.changes.length > 0 && !diff.applied && <Button type="button" className="min-h-11" disabled={busy} onClick={() => void preview(true)}>Apply {diff.changes.length} change{diff.changes.length === 1 ? "" : "s"}</Button>}
            </div>
          )}
          {diff && (diff.changes.length === 0
            ? <p className="mt-2 text-sm text-emerald-700">The snapshot matches Cin7.</p>
            : <ul className="mt-2 list-disc pl-5 text-sm">{diff.changes.map((c) => <li key={c.field}><b>{c.field}</b>: {c.before} → {c.after}{diff.applied ? " (applied)" : ""}</li>)}</ul>)}
        </details>
      )}
    </div>
  );
}
