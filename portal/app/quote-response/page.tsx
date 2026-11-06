"use client";

import { useEffect, useState } from "react";
import { loadQuoteResponsePageAction, submitQuoteResponseAction } from "./actions";
import type { PublicQuotation } from "@/lib/newquip-portal/store";

// The customer's response page. The response token lives in the URL FRAGMENT (#t=...&a=accept|decline|changes): the fragment is never sent to the server or in a Referer, so it is in no
// request log. Merely opening this page (or an email scanner fetching it) shows nothing and records nothing: the quotation details are loaded by the page itself, and a response is
// recorded only when the customer presses the submit button. Possession of the link does not prove authority to accept, so an acceptance asks for the respondent's details and an
// explicit authority confirmation, and is then verified internally before it counts.

type Action = "ACCEPTED" | "DECLINED" | "CHANGES_REQUESTED";
const PRESET: Record<string, Action> = { accept: "ACCEPTED", decline: "DECLINED", changes: "CHANGES_REQUESTED" };
const zar = (n: number) => `R ${n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const inputCls = "h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-base sm:text-sm";
const LABEL: Record<Action, string> = { ACCEPTED: "Accepted", DECLINED: "Declined", CHANGES_REQUESTED: "Changes requested" };
const when = (iso: string) => new Date(iso).toLocaleString("en-ZA", { dateStyle: "long", timeStyle: "short", timeZone: "Africa/Johannesburg" }) + " (SAST)";

export default function QuoteResponsePage() {
  const [token, setToken] = useState("");
  const [data, setData] = useState<PublicQuotation | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<Action>("ACCEPTED");
  const [f, setF] = useState({ fullName: "", company: "", email: "", reason: "", authority: false, revisionOk: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ action: Action; quoteRef: string; revision: number; submittedAt: string } | null>(null);

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

  const brand = data?.companyName || "NewQuip";
  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-slate-50 text-slate-900" data-surface="customer-response">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-2xl items-center gap-3 px-4 py-4 sm:px-6">
          <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#1e3a5f] text-lg font-bold text-white">{brand.slice(0, 1).toUpperCase()}</span>
          <div className="min-w-0"><p className="truncate text-base font-bold leading-tight">{brand}</p><p className="text-xs text-slate-500">Secure quotation response</p></div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 sm:py-10">{children}</main>
      <footer className="mx-auto w-full max-w-2xl px-4 pb-8 text-xs text-slate-500 sm:px-6">This page is personal to the recipient of the quotation email. Please do not forward the link.</footer>
    </div>
  );
  if (loading) return shell(<p className="text-sm text-slate-600" role="status">Loading your quotation…</p>);
  if (done) {
    return shell(
      <div className="rounded-xl border border-emerald-200 bg-white p-6" role="status">
        <h1 className="text-xl font-bold">Response successfully received</h1>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-slate-500">Quotation</dt><dd className="font-medium">{done.quoteRef}, revision {done.revision}</dd>
          <dt className="text-slate-500">Your response</dt><dd className="font-medium">{LABEL[done.action]}</dd>
          <dt className="text-slate-500">Received</dt><dd className="font-medium">{when(done.submittedAt)}</dd>
        </dl>
        <p className="mt-4 text-sm text-slate-700">{brand} will review your response and be in touch. You do not need to do anything else, and you can close this page.</p>
      </div>,
    );
  }
  if (!data) return shell(<div className="rounded-xl border border-slate-200 bg-white p-6" role="alert"><h1 className="text-lg font-bold">Quotation response</h1><p className="mt-2 text-sm text-slate-700">{problem ?? "This link is not valid."}</p></div>);

  const accept = action === "ACCEPTED";
  const opt = (a: Action, label: string) => data.actions.includes(a) && (
    <button type="button" key={a} onClick={() => setAction(a)} aria-pressed={action === a}
      className={`h-11 flex-1 rounded-md border px-3 text-sm font-semibold ${action === a ? "border-[#1e3a5f] bg-[#1e3a5f] text-white" : "border-slate-300 bg-white text-slate-800 hover:bg-slate-50"}`}>{label}</button>
  );
  return shell(
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6" aria-label="Quotation summary">
        <h1 className="text-2xl font-bold">Quotation {data.quoteRef}</h1>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-slate-500">Prepared for</dt><dd className="text-right font-medium">{data.customerName}</dd>
          <dt className="text-slate-500">Revision</dt><dd className="text-right">{data.revision}</dd>
          <dt className="text-slate-500">Issued</dt><dd className="text-right">{data.issuedOn}</dd>
          <dt className="text-slate-500">Valid until</dt><dd className="text-right">{data.validUntil}</dd>
        </dl>
        <dl className="mt-4 grid grid-cols-[1fr_auto] gap-y-1 border-t border-slate-100 pt-4 text-sm">
          <dt className="text-slate-500">Total excluding VAT</dt><dd className="tabular-nums">{zar(data.subtotalExVat)}</dd>
          <dt className="text-slate-500">VAT</dt><dd className="tabular-nums">{zar(data.vat)}</dd>
          <dt className="text-base font-bold">Total including VAT ({data.currency})</dt><dd className="text-base font-bold tabular-nums">{zar(data.totalIncVat)}</dd>
        </dl>
        {data.schedule.length > 0 && (
          <div className="mt-4 border-t border-slate-100 pt-4 text-sm">
            <h2 className="font-semibold">Payment milestones</h2>
            <ul className="mt-1 space-y-0.5 text-slate-700">{data.schedule.map((s) => <li key={s.name} className="flex justify-between gap-3"><span>{s.name} ({s.percent}%)</span><span className="tabular-nums">{zar(s.amountExVat)} ex VAT</span></li>)}</ul>
          </div>
        )}
        <form method="post" action="/api/quote-response/document" target="_blank" className="mt-5">
          <input type="hidden" name="token" value={token} />
          <button type="submit" className="inline-flex h-12 w-full items-center justify-center rounded-md bg-[#1e3a5f] px-5 text-base font-semibold text-white hover:bg-[#16304f]">View quotation PDF</button>
        </form>
      </section>

      <form onSubmit={submit} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 sm:p-6" aria-label="Your response">
        <h2 className="text-lg font-bold">Your response</h2>
        <div className="flex flex-col gap-2 sm:flex-row" role="group" aria-label="Choose your response">
          {opt("ACCEPTED", "Accept quotation")}{opt("DECLINED", "Decline quotation")}{opt("CHANGES_REQUESTED", "Request changes")}
        </div>
        <label className="block text-sm"><span className="font-medium text-slate-700">Your full name</span><input className={inputCls} value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} autoComplete="name" required /></label>
        <label className="block text-sm"><span className="font-medium text-slate-700">Company</span><input className={inputCls} value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} autoComplete="organization" required /></label>
        <label className="block text-sm"><span className="font-medium text-slate-700">Your email address</span><input type="email" className={inputCls} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" required /></label>
        {!accept && (
          <label className="block text-sm"><span className="font-medium text-slate-700">{action === "DECLINED" ? "Why are you declining?" : "What changes would you like?"}</span>
            <textarea className="min-h-24 w-full rounded-md border border-slate-300 p-3 text-base sm:text-sm" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} required /></label>
        )}
        {accept && (
          <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
            <label className="flex items-start gap-3"><input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={f.authority} onChange={(e) => setF({ ...f, authority: e.target.checked })} /> <span>I confirm that I am authorised to accept this quotation on behalf of {data.customerName}.</span></label>
            <label className="flex items-start gap-3"><input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={f.revisionOk} onChange={(e) => setF({ ...f, revisionOk: e.target.checked })} /> <span>I accept quotation {data.quoteRef}, revision {data.revision}, for a total of {zar(data.totalIncVat)} including VAT.</span></label>
            <p className="text-xs text-slate-600">Your acceptance is recorded and then checked by {brand} before it is confirmed.</p>
          </div>
        )}
        {err && <p className="text-sm text-red-700" role="alert">{err}</p>}
        <button type="submit" disabled={busy} className="inline-flex h-12 w-full items-center justify-center rounded-md bg-emerald-700 px-5 text-base font-semibold text-white hover:bg-emerald-800 disabled:opacity-60">
          {busy ? "Submitting…" : accept ? "Confirm acceptance" : action === "DECLINED" ? "Confirm decline" : "Send change request"}
        </button>
        <p className="text-xs text-slate-500">Nothing is recorded until you press this button.</p>
      </form>
    </div>,
  );
}
