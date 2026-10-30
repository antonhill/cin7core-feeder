"use client";

import { useEffect, useState } from "react";
import { loadQuoteResponsePageAction, submitQuoteResponseAction } from "./actions";
import type { PublicQuotation } from "@/lib/newquip-quotes/customer-response";

// The customer's response page. The response token lives in the URL FRAGMENT (#t=...&a=accept|decline|changes): the fragment is never sent to the server or in a Referer, so it is in no
// request log. Merely opening this page (or an email scanner fetching it) shows nothing and records nothing: the quotation details are loaded by the page itself, and a response is
// recorded only when the customer presses the submit button. Possession of the link does not prove authority to accept, so an acceptance asks for the respondent's details and an
// explicit authority confirmation, and is then verified internally before it counts.

type Action = "ACCEPTED" | "DECLINED" | "CHANGES_REQUESTED";
const PRESET: Record<string, Action> = { accept: "ACCEPTED", decline: "DECLINED", changes: "CHANGES_REQUESTED" };
const zar = (n: number) => `R ${n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const inputCls = "h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm";

export default function QuoteResponsePage() {
  const [token, setToken] = useState("");
  const [data, setData] = useState<PublicQuotation | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<Action>("ACCEPTED");
  const [f, setF] = useState({ fullName: "", company: "", email: "", reason: "", authority: false, revisionOk: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ action: Action; quoteRef: string } | null>(null);

  useEffect(() => {
    let live = true;
    const h = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const t = h.get("t") ?? "";
    const preset = PRESET[(h.get("a") ?? "").toLowerCase()];
    void (async () => {
      if (live && preset) setAction(preset);
      if (!t) { if (live) { setProblem("This link is incomplete. Please use the link in the original email."); setLoading(false); } return; }
      if (live) setToken(t);
      const r = await loadQuoteResponsePageAction(t);
      if (!live) return;
      if (r.ok) setData(r.data); else setProblem(r.error);
      setLoading(false);
    })();
    return () => { live = false; };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!data) return;
    setBusy(true); setErr(null);
    try {
      const r = await submitQuoteResponseAction({ token, action, fullName: f.fullName, company: f.company, email: f.email, authorityConfirmed: f.authority, revisionConfirmed: f.revisionOk, revision: data.revision, reason: f.reason });
      if (r.ok) { setDone(r.data); setToken(""); } else if (r.reason === "INVALID_INPUT" || r.reason === "RATE_LIMITED") setErr(r.error); else { setProblem(r.error); setData(null); }
    } catch { setErr("Something went wrong. Please try again."); } finally { setBusy(false); }
  }

  const shell = (children: React.ReactNode) => <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">{children}</main>;
  if (loading) return shell(<p className="text-sm text-slate-600" role="status">Loading your quotation…</p>);
  if (done) {
    return shell(
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6" role="status">
        <h1 className="text-xl font-bold text-slate-900">Thank you</h1>
        <p className="mt-2 text-sm text-slate-700">
          {done.action === "ACCEPTED" ? `Your acceptance of quotation ${done.quoteRef} has been received. It will be checked by the sender before it is confirmed; you do not need to do anything else.`
            : done.action === "DECLINED" ? `Your response to quotation ${done.quoteRef} has been received. Thank you for letting us know.`
            : `Your request for changes to quotation ${done.quoteRef} has been received. The sender will be in touch.`}
        </p>
      </div>,
    );
  }
  if (!data) return shell(<div className="rounded-xl border border-slate-200 bg-white p-6" role="alert"><h1 className="text-lg font-bold text-slate-900">Quotation response</h1><p className="mt-2 text-sm text-slate-700">{problem ?? "This link is not valid."}</p></div>);

  const accept = action === "ACCEPTED";
  return shell(
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-wide text-slate-500">{data.companyName}</p>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">Quotation {data.quoteRef} <span className="text-base font-medium text-slate-500">· revision {data.revision}</span></h1>
        <p className="text-sm text-slate-600">Prepared for {data.customerName}</p>
      </header>

      <section className="rounded-xl border border-slate-200 bg-white p-5 text-sm" aria-label="Quotation summary">
        <dl className="grid grid-cols-2 gap-y-1">
          <dt className="text-slate-500">Subtotal (ex VAT)</dt><dd className="text-right tabular-nums">{zar(data.subtotalExVat)}</dd>
          <dt className="text-slate-500">VAT</dt><dd className="text-right tabular-nums">{zar(data.vat)}</dd>
          <dt className="font-semibold text-slate-900">Total ({data.currency})</dt><dd className="text-right font-semibold tabular-nums">{zar(data.totalIncVat)}</dd>
          <dt className="text-slate-500">Issued</dt><dd className="text-right">{data.issuedOn}</dd>
          <dt className="text-slate-500">Valid until</dt><dd className="text-right">{data.validUntil}</dd>
        </dl>
        {data.schedule.length > 0 && <ul className="mt-3 space-y-0.5 border-t border-slate-100 pt-3 text-slate-700">{data.schedule.map((s) => <li key={s.name}>{s.name}: {s.percent}% · {zar(s.amountExVat)} ex VAT</li>)}</ul>}
        <form method="post" action="/api/quote-response/document" target="_blank" className="mt-4">
          <input type="hidden" name="token" value={token} />
          <button type="submit" className="inline-flex h-10 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-50">View the full quotation (PDF)</button>
        </form>
      </section>

      <form onSubmit={submit} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5" aria-label="Your response">
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold text-slate-900">Your response</legend>
          {data.actions.includes("ACCEPTED") && <label className="flex items-center gap-2 text-sm"><input type="radio" name="action" checked={action === "ACCEPTED"} onChange={() => setAction("ACCEPTED")} /> Accept the quotation</label>}
          {data.actions.includes("DECLINED") && <label className="flex items-center gap-2 text-sm"><input type="radio" name="action" checked={action === "DECLINED"} onChange={() => setAction("DECLINED")} /> Decline the quotation</label>}
          {data.actions.includes("CHANGES_REQUESTED") && <label className="flex items-center gap-2 text-sm"><input type="radio" name="action" checked={action === "CHANGES_REQUESTED"} onChange={() => setAction("CHANGES_REQUESTED")} /> Request changes</label>}
        </fieldset>
        <label className="block text-sm"><span className="font-medium text-slate-700">Your full name</span><input className={inputCls} value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} autoComplete="name" required /></label>
        <label className="block text-sm"><span className="font-medium text-slate-700">Company</span><input className={inputCls} value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} autoComplete="organization" required /></label>
        <label className="block text-sm"><span className="font-medium text-slate-700">Your email address</span><input type="email" className={inputCls} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" required /></label>
        {!accept && (
          <label className="block text-sm"><span className="font-medium text-slate-700">{action === "DECLINED" ? "Why are you declining?" : "What changes would you like?"}</span>
            <textarea className="min-h-24 w-full rounded-md border border-slate-300 p-3 text-sm" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required /></label>
        )}
        {accept && (
          <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
            <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={f.authority} onChange={(e) => setF({ ...f, authority: e.target.checked })} /> <span>I confirm that I am authorised to accept this quotation on behalf of {data.customerName}.</span></label>
            <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={f.revisionOk} onChange={(e) => setF({ ...f, revisionOk: e.target.checked })} /> <span>I accept quotation {data.quoteRef}, revision {data.revision}, for a total of {zar(data.totalIncVat)} including VAT.</span></label>
            <p className="text-xs text-slate-600">Your acceptance is recorded and then checked by the sender before it is confirmed.</p>
          </div>
        )}
        {err && <p className="text-sm text-red-700" role="alert">{err}</p>}
        <button type="submit" disabled={busy} className="inline-flex h-10 items-center rounded-md bg-indigo-600 px-5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
          {busy ? "Submitting…" : accept ? "Accept quotation" : action === "DECLINED" ? "Decline quotation" : "Send change request"}
        </button>
        <p className="text-xs text-slate-500">Nothing is recorded until you press the button above.</p>
      </form>
    </div>,
  );
}
