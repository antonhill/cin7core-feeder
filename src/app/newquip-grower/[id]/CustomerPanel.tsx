"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { formatSast } from "@/lib/approvals/time";
import { chooseQuoteContactAction, getQuoteCustomerAction, refreshQuoteCustomerAction, searchQuoteCustomersForQuoteAction, selectQuoteCustomerAction, type QuoteCustomerView, type RefreshPreview } from "../customer-actions";
import type { CustomerHit } from "@/lib/newquip-customers/cin7-customer-read";
import { fieldValue, type Field } from "@/lib/newquip-quotes/customer-snapshot";

// Cin7 customer lookup, quotation contact and the customer-details snapshot. Cin7 stays the master: nothing here is ever written to Cin7. A field Cin7 did not supply is
// shown as "not in Cin7", never as a blank. The server re-checks the Rep role and the organisation on every action.

const show = (f: Field | undefined): string => (!f || f.state === "missing" ? "not in Cin7" : f.state === "empty" ? "blank in Cin7" : f.value);
const inputCls = "h-9 rounded-md border border-slate-300 bg-white px-2 text-sm";

export function CustomerPanel({ quoteId, editable, onPicked }: { quoteId: string; editable: boolean; onPicked: (customerName: string) => void }) {
  const [v, setV] = useState<QuoteCustomerView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CustomerHit[]>([]);
  const [entered, setEntered] = useState({ name: "", email: "", phone: "" });
  const [diff, setDiff] = useState<RefreshPreview | null>(null);

  useEffect(() => {
    let live = true;
    void getQuoteCustomerAction(quoteId).then((r) => { if (!live) return; if (r.ok && r.data) setV(r.data); else setErr(r.error ?? "Could not load the customer details."); });
    return () => { live = false; };
  }, [quoteId]);

  const run = async (fn: () => Promise<{ ok: boolean; error?: string; data?: QuoteCustomerView }>) => {
    setBusy(true); setErr(null);
    try { const r = await fn(); if (r.ok && r.data) { setV(r.data); setDiff(null); } else setErr(r.error ?? "Failed."); } finally { setBusy(false); }
  };
  const search = async () => { setErr(null); const r = await searchQuoteCustomersForQuoteAction(q); if (r.ok) setHits(r.data ?? []); else setErr(r.error ?? "Search failed."); };
  const pick = (name: string) => run(async () => { const r = await selectQuoteCustomerAction(quoteId, name); if (r.ok) { onPicked(name); setHits([]); setQ(""); } return r; });
  const preview = async (apply: boolean) => {
    setBusy(true); setErr(null);
    try {
      const r = await refreshQuoteCustomerAction(quoteId, apply);
      if (r.ok && r.data) { setDiff(r.data.preview); setV(r.data.view); } else setErr(r.error ?? "Refresh failed.");
    } finally { setBusy(false); }
  };

  if (!v) return <p className="mt-4 text-sm text-slate-500">{err ?? "Loading customer details…"}</p>;
  if (!v.available) return <Alert tone="info">Cin7 customer lookup becomes available once the database update for customer snapshots has been applied. The customer name above is used until then.</Alert>;
  const s = v.snapshot;
  const a = s?.billingAddress;
  return (
    <div className="mt-4 space-y-3 rounded-md border border-slate-200 p-3" data-testid="customer-panel">
      <div className="flex items-center gap-2"><span className="text-sm font-semibold text-slate-800">Cin7 customer</span>{s ? <Badge tone="success">Snapshot #{v.seq}</Badge> : <Badge tone="warning">Not selected</Badge>}</div>
      {err && <Alert tone="danger">{err}</Alert>}
      {v.editable && editable && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-slate-700">Search by name, contact or email</span>
            <input className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void search(); } }} /></label>
          <Button type="button" variant="secondary" onClick={() => void search()} disabled={busy || q.trim().length < 2}>Search Cin7 customers</Button>
        </div>
      )}
      {hits.length > 0 && (
        <ul className="divide-y rounded-md border border-slate-200 text-sm">
          {hits.map((h) => (
            <li key={h.name} className="flex items-center justify-between gap-2 p-2">
              <span><b>{h.name}</b>{h.tradingName ? ` (${h.tradingName})` : ""} · {h.contactName ?? "no contact"} · {h.email ?? "no email"} · {h.currency ?? "no currency"}</span>
              <Button type="button" variant="secondary" onClick={() => void pick(h.name)} disabled={busy}>Select</Button>
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
          <dt className="text-slate-500">Quotation contact</dt><dd>{s.chosenContact ? `${s.chosenContact.name} <${s.chosenContact.email}>${s.chosenContact.source === "ENTERED" ? " (entered by you)" : ""}` : "not chosen"}</dd>
        </dl>
      )}
      {v.currency?.status === "MISSING" && <Alert tone="warning">{v.currency.message}</Alert>}
      {v.currency?.status === "INCOMPATIBLE" && <Alert tone="danger">{v.currency.message}</Alert>}
      {s && v.issues.length > 0 && <Alert tone="warning"><ul className="list-disc pl-4">{v.issues.map((i) => <li key={i}>{i}</li>)}</ul></Alert>}
      {s && v.editable && editable && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-slate-700">Quotation contact and delivery email</p>
          <div className="flex flex-wrap gap-2">
            {s.contacts.map((c, i) => (
              <Button key={i} type="button" variant="secondary" disabled={busy} onClick={() => void run(() => chooseQuoteContactAction(quoteId, { source: "CIN7_CONTACT", contactIndex: i }))}>
                {show(c.name)} · {show(c.email)}
              </Button>
            ))}
            {s.contacts.length === 0 && <span className="text-sm text-slate-500">Cin7 holds no contacts for this customer; enter one below.</span>}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <input className={inputCls} placeholder="Contact name" value={entered.name} onChange={(e) => setEntered({ ...entered, name: e.target.value })} />
            <input className={inputCls} placeholder="Delivery email" value={entered.email} onChange={(e) => setEntered({ ...entered, email: e.target.value })} />
            <input className={inputCls} placeholder="Phone (optional)" value={entered.phone} onChange={(e) => setEntered({ ...entered, phone: e.target.value })} />
            <Button type="button" variant="secondary" disabled={busy} onClick={() => void run(() => chooseQuoteContactAction(quoteId, { source: "ENTERED", ...entered }))}>Use this contact</Button>
          </div>
          <p className="text-xs text-slate-500">Entered contacts are validated and audited. They are used on this quotation only and are never written to Cin7.</p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="secondary" disabled={busy} onClick={() => void preview(false)}>Check Cin7 for changes</Button>
            {diff && diff.changes.length > 0 && !diff.applied && <Button type="button" disabled={busy} onClick={() => void preview(true)}>Apply {diff.changes.length} change{diff.changes.length === 1 ? "" : "s"}</Button>}
          </div>
          {diff && (diff.changes.length === 0
            ? <p className="text-sm text-emerald-700">The snapshot matches Cin7.</p>
            : <ul className="list-disc pl-5 text-sm">{diff.changes.map((c) => <li key={c.field}><b>{c.field}</b>: {c.before} → {c.after}{diff.applied ? " (applied)" : ""}</li>)}</ul>)}
        </div>
      )}
      {v.history.length > 0 && <p className="text-xs text-slate-500">History: {v.history.map((h) => `#${h.seq} ${h.by} ${formatSast(h.at)}`).join(" · ")}</p>}
    </div>
  );
}
