"use client";

import type { ReactNode } from "react";
import { rand } from "./phase-ux-format";

// PHASE 3 · THE MANAGER'S DECISION on ONE screen. It replaces the stack that used to precede the approval controls (owner strip, readiness alert, Rep summary, evidence table, Estimator result block) with five
// short facts and the list of what is still open. Presentational: every value is passed in from data the page already holds, the approval controls and their gates are the existing ones (passed as children), and
// the margin is only passed to roles that may see it.
export interface DecisionEvidence { label: string; recorded: boolean }

function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return <div className="min-w-0 flex-[1_1_13rem] rounded-lg border border-slate-200 bg-white px-4 py-3"><p className="text-xs font-semibold uppercase tracking-wider text-slate-600">{label}</p><div className="mt-1 text-sm text-slate-900" data-testid={testId}>{children}</div></div>;
}

export function ManagerDecision({ decider, statusLine, totals, verification, margin, signoff, evidence, exceptions, afterFacts, children }: {
  decider: string; statusLine: string;
  totals: { exVat: number | null; vat: number | null; incVat: number | null };
  verification: { required: number; verified: number } | null;
  margin: { value: string; note: string } | null;
  signoff: { by: string | null; at: string | null; state: "current" | "stale" | "none" };
  evidence: DecisionEvidence[]; exceptions: string[]; afterFacts?: ReactNode; children?: ReactNode;
}) {
  const evidenceOpen = evidence.filter((e) => !e.recorded).length;
  return (
    <div className="mt-4 space-y-4" data-testid="manager-decision">
      <section className="rounded-xl border border-slate-200 bg-white px-5 py-4" aria-label="Decision status">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">Phase 3 · Approve or Return</p>
        <p className="mt-1 text-base font-semibold text-slate-900" role="status" aria-live="polite" data-testid="decision-status">{statusLine}</p>
        <p className="mt-1 text-sm text-slate-700">Decision owner: {decider}.</p>
      </section>

      <div className="flex flex-wrap gap-3" data-testid="decision-facts">
        <Fact label="Selling total" testId="decision-totals">
          <p className="text-lg font-bold tabular-nums">{totals.exVat == null ? "—" : rand(totals.exVat)} <span className="text-xs font-medium text-slate-700">ex VAT</span></p>
          <p className="tabular-nums text-slate-800">VAT {totals.vat == null ? "—" : rand(totals.vat)} · inc VAT {totals.incVat == null ? "—" : rand(totals.incVat)}</p>
        </Fact>
        <Fact label="Supplier-cost verification" testId="decision-verification">
          {verification == null ? <span className="text-slate-700">Not applicable to this quotation</span>
            : <><p className="text-lg font-bold tabular-nums">{verification.verified} of {verification.required} verified</p><p className="text-slate-800">{verification.verified >= verification.required ? "Every supplier cost is independently verified." : "Verified independently of the Estimator."}</p></>}
        </Fact>
        {margin && <Fact label="Commercial margin" testId="decision-margin"><p className="text-lg font-bold tabular-nums">{margin.value}</p><p className="text-slate-800">{margin.note}</p></Fact>}
        <Fact label="Estimator sign-off" testId="decision-signoff">
          {signoff.state === "current" ? <><p className="font-semibold text-emerald-900">Signed off</p><p className="text-slate-800">{signoff.by ?? "Estimator"}{signoff.at ? ` · ${signoff.at}` : ""}</p></>
            : signoff.state === "stale" ? <p className="font-semibold text-amber-900">Out of date: the quotation changed after sign-off.</p>
            : <p className="font-semibold text-amber-900">Not signed off yet.</p>}
        </Fact>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white px-5 py-4" aria-labelledby="decision-open" data-testid="decision-open">
        <h3 id="decision-open" className="text-base font-bold text-slate-900">Outstanding {exceptions.length === 0 ? <span className="text-emerald-800">· nothing open</span> : <span className="text-amber-900">· {exceptions.length}</span>}</h3>
        {exceptions.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-900">{exceptions.map((e) => <li key={e}>{e}</li>)}</ul>}
        {evidence.length > 0 && <p className="mt-2 text-sm text-slate-700" data-testid="decision-evidence">Pricing evidence: {evidence.length - evidenceOpen} of {evidence.length} recorded.</p>}
      </section>

      {afterFacts}
      {children}
    </div>
  );
}

// The Manager's supporting detail (the Rep's submission, per-line pricing evidence, the Estimator's result with exceptions and overrides) stays available, collapsed, under the decision facts.
export function SupportingDetail({ wrap, label, children }: { wrap: boolean; label: string; children: ReactNode }) {
  if (!wrap) return <>{children}</>;
  return <details className="rounded-xl border border-slate-200 bg-white px-5 py-2" data-testid="decision-supporting"><summary className="min-h-11 cursor-pointer py-2.5 text-sm font-semibold text-slate-900">{label}</summary><div className="space-y-3 pb-3">{children}</div></details>;
}
