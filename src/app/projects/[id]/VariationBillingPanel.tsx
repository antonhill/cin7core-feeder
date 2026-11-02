"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Alert } from "@/components/ui/Alert";
import { ScopeTag, Status, statusText } from "@/components/ui/Status";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { Block } from "./LoadingSkeletons";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { VariationProductPicker } from "./VariationProductPicker";
import { useUnsavedGuard } from "@/lib/use-unsaved-guard";
import { formatCents, type ProjectView } from "@/lib/projects/project-view";
import { amendVariationScheduleAction, getVariationBillingAction, saveVariationScheduleAction, startVariationBillingAction, type VariationBillingState } from "../variation-billing-actions";

// Variation BILLING: each approved variation has its own percentage schedule (default one 100% stage) and, once a manager starts billing,
// its own billing project and Cin7 Sale. Consolidated figures sum the base and variation billing projects. Nothing here writes to Cin7.
type Run = (fn: () => Promise<{ ok: boolean; error?: string }>, done?: string) => Promise<boolean>;
type Row = { name: string; percent: string };

/** The Cin7 Sale line: a stored number, or an honest account of why there is none. A failed lookup is never reported as "no Sale". */
function saleLine(state: VariationBillingState, variationId: string, billingStarted: boolean) {
  const n = state.saleNumberByVariation?.[variationId];
  if (n) return <span className="font-mono font-medium text-slate-900">{n}</span>;
  if (!billingStarted) return <span className="text-slate-600">billing not started</span>; // no billing project means there is nothing to look up: a failed lookup is irrelevant
  if (state.saleLookupFailed) return <span className="text-slate-600">number unavailable (could not be loaded)</span>;
  if (n === null) return <span className="text-slate-600">linked, number not recorded</span>;
  return <span className="text-slate-600">not created yet</span>;
}

const pct = (bps: number) => (bps / 100).toFixed(2).replace(/\.00$/, "");
const rowsOf = (s: Array<{ name: string; bps: number }> | undefined): Row[] => (s && s.length ? s.map((x) => ({ name: x.name, percent: pct(x.bps) })) : [{ name: "Variation", percent: "100" }]);
/** Shown beside every control that is disabled only because a server action is running. */
export const BUSY = "Another action is in progress.";
/** Rows as the server would see them (trimmed names, numeric percents), so "50.0" or " Deposit " equals the saved "50" / "Deposit". */
const normRows = (rows: Row[]) => rows.map((x) => ({ name: x.name.trim(), percent: Number(x.percent.trim()) }));
const totalOf = (rows: Row[]) => Math.round(rows.reduce((n, r) => n + (Number(r.percent) || 0), 0) * 100) / 100;

export function VariationBillingPanel({ view, isAdmin, run, working, renderDecision }: { view: ProjectView; isAdmin: boolean; run: Run; working: boolean; renderDecision?: (v: ProjectView["variations"][number]) => React.ReactNode }) {
  const projectId = view.project.id;
  const [state, setState] = useState<VariationBillingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<Record<string, Row[]>>({});
  const [reason, setReason] = useState<Record<string, string>>({});
  const [prods, setProds] = useState<Record<string, Array<{ sku: string; description: string; quantity: string }>>>({});

  const [version, setVersion] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null); // the ONE variation whose detailed workspace is expanded; nothing is expanded until asked
  const [everOpened, setEverOpened] = useState<Record<string, boolean>>({}); // a hidden workspace stays mounted so an action in flight in it is never lost
  const variationKey = view.variations.map((v) => `${v.id}:${v.status}`).join(",");
  useEffect(() => {
    if (view.variations.length === 0) return; // nothing to bill: no read
    let live = true;
    void getVariationBillingAction(projectId).then((r) => {
      if (!live) return;
      if (r.ok && r.data) { setState(r.data); setError(null); } else setError(r.error ?? "Could not load variation billing.");
    });
    return () => { live = false; };
  }, [projectId, variationKey, version, view.variations.length]);

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>, done: string): Promise<boolean> => { const ok = await run(fn, done); if (ok) setVersion((n) => n + 1); return ok; };
  const dropEdit = (id: string) => setEdit((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== id))); // after a successful save the reloaded schedule is the truth; the typed strings are discarded
  const c = state?.consolidated;
  const variations = view.variations.filter((v) => v.status !== "REJECTED");

  // Unsaved-work guard. Dirty = an EDITABLE schedule whose rows differ from the saved schedule, or a typed amendment reason. Read-only (locked) schedules never guard;
  // a successful save makes the reloaded schedule equal the rows, a successful amendment also clears the reason, so the guard releases.
  const scheduleDirty = !!state && variations.some((v) => {
    const locked = (v.status === "APPROVED" && !isAdmin) || (!!state.billingProjectByVariation[v.id] && v.status === "APPROVED");
    if (locked) return false;
    const rowsChanged = edit[v.id] !== undefined && JSON.stringify(normRows(edit[v.id])) !== JSON.stringify(normRows(rowsOf(state.schedules[v.id])));
    return rowsChanged || (v.status !== "DRAFT" && (reason[v.id] ?? "").trim() !== "");
  });
  useUnsavedGuard(scheduleDirty);
  if (view.variations.length === 0) return null; // the Variations tab says so itself

  return (
    <div className="space-y-4">
      {state && error && (
        <Alert tone="warning">The billing figures could not be refreshed ({error}); what is shown may be out of date.<span className="ml-2"><Button size="sm" variant="secondary" onClick={() => setVersion((n) => n + 1)}>Try again</Button></span></Alert>
      )}

      {variations.length === 0 ? null : variations.map((v) => {
        const sched = state?.schedules[v.id];
        const rows = edit[v.id] ?? rowsOf(sched);
        const total = totalOf(rows);
        const billingId = state?.billingProjectByVariation[v.id];
        const legacy = !!state && v.status === "APPROVED" && (!sched || sched.length === 0);
        const scope = billingId && c ? c.scopes.find((x) => x.projectId === billingId) : undefined;
        const wsOpen = openId === v.id; // ONE detailed workspace is expanded at a time, and only on request (one workspace's reads, not every variation's)
        const canToggle = !!state && v.status === "APPROVED" && !!billingId && isAdmin;
        const stagesLocked = (v.status === "APPROVED" && !isAdmin) || (!!billingId && v.status === "APPROVED");
        const reasonText = reason[v.id] ?? "";
        const sid = (k: string) => `${k}-${v.id}`;
        return (
          <section key={v.id} aria-label={`${v.code} variation`} className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <PanelTitle><span className="inline-flex flex-wrap items-center gap-2">{v.code} – {v.title} <ScopeTag scope="VARIATION" /><Status tone={v.status === "APPROVED" ? "success" : "neutral"}>{statusText(v.status)}</Status></span></PanelTitle>
                {v.description && <p className="mt-1 text-sm text-slate-600">{v.description}</p>}
                {state && v.status === "APPROVED" && (
                  <p className="mt-1 text-sm text-slate-700">
                    <span className="text-slate-600">Cin7 Sale: </span>
                    {saleLine(state, v.id, !!billingId)}
                  </p>
                )}
              </div>
              <div className="flex flex-col items-end gap-2 text-right">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">{v.status === "APPROVED" ? "Approved value (ex VAT)" : "Proposed value (ex VAT)"}</p>
                  <p className="whitespace-nowrap text-xl font-bold tabular-nums text-slate-900">{formatCents(v.amount_cents)}</p>
                </div>
                {canToggle && (
                  <Button size="sm" variant="secondary" aria-expanded={wsOpen} aria-controls={`ws-${v.id}`} onClick={() => { if (wsOpen) setOpenId(null); else { setOpenId(v.id); setEverOpened((e) => ({ ...e, [v.id]: true })); } }}>{wsOpen ? "Hide billing workspace" : "Open billing workspace"}</Button>
                )}
              </div>
            </div>
            {legacy && <div className="mt-3"><Alert tone="warning">This variation was approved before billing schedules existed. A manager must set its schedule (an audited amendment) before billing can start. Nothing is created automatically.</Alert></div>}
            {!state ? (
              error
                ? <div className="mt-3"><Alert tone="warning">The billing figures for this variation could not be loaded ({error}). The decision controls below still work.</Alert><div className="mt-2"><Button size="sm" variant="secondary" onClick={() => setVersion((n) => n + 1)}>Try again</Button></div></div>
                : <div role="status" aria-busy="true" className="mt-3"><p className="text-sm text-slate-600">Loading the billing position…</p><Block className="mt-2 h-12 w-full" /></div>
            ) : scope ? (
              <div className="mt-3 border-t border-slate-200 pt-3">
              <p className="text-xs text-slate-600">Billing position of this variation only, ex VAT</p>
              <dl className="mt-1 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3 lg:grid-cols-5" aria-label={`${v.code} billing position (ex VAT)`}>
                {([["Earned", scope.earnedCents], ["Billed / committed", scope.committedCents], ["Claimable now", scope.claimableCents], ["Remaining", scope.remainingCents]] as const).map(([k, n]) => (
                  <div key={k}><dt className="text-xs text-slate-600">{k}</dt><dd className="font-semibold tabular-nums text-slate-900">{formatCents(n)}</dd></div>
                ))}
                <div><dt className="text-xs text-slate-600">Reconciliation</dt><dd className="text-sm text-slate-700">{isAdmin ? "Per invoice, in the billing workspace" : "Checked by a manager"}</dd></div>
              </dl>
              </div>
            ) : <p className="mt-3 text-sm text-slate-600">{v.status === "APPROVED" ? "Billing has not started for this variation." : "Counts for nothing until a manager approves it."}</p>}
            <div className="mt-3">{renderDecision ? renderDecision(v) : null}</div>
            {state && v.status === "APPROVED" && (
              <div className="mt-4">
                {billingId ? (
                  isAdmin ? null : <span className="text-sm text-slate-600">Billing for {v.code} is active; a manager operates it.</span>
                ) : isAdmin ? (
                  <div className="space-y-2">
                    <details>
                      <summary className="cursor-pointer py-1.5 text-sm font-medium text-slate-800">Products in this variation (picked once from Cin7; the Sale and invoices inherit them)</summary>
                      <div className="mt-2"><VariationProductPicker picked={prods[v.id] ?? []} onChange={(next) => setProds({ ...prods, [v.id]: next })} disabled={working} /></div>
                    </details>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button disabled={working || legacy} aria-describedby={legacy ? sid("start-why") : working ? sid("start-busy") : undefined} onClick={() => act(() => startVariationBillingAction(projectId, v.id, (prods[v.id] ?? []).map((p) => ({ sku: p.sku, description: p.description, quantity: Number(p.quantity) }))), `Started billing for ${v.code}. Create its Cin7 Sale below.`)}>Start variation billing</Button>
                      {legacy ? <p id={sid("start-why")} className="text-sm text-slate-700">Set the billing schedule first (this variation was approved before schedules existed).</p>
                        : working ? <p id={sid("start-busy")} className="text-sm text-slate-700">{BUSY}</p> : null}
                    </div>
                  </div>
                ) : <span className="text-xs text-slate-600">A manager starts variation billing.</span>}
              </div>
            )}
            {state && <details className="mt-4 border-t border-slate-200 pt-1" open={legacy}>
              <summary className="cursor-pointer py-1.5 text-sm font-medium text-slate-800">Billing schedule</summary>
            <p className="mt-1 text-xs text-slate-600">{v.status === "APPROVED" ? "Approved" : "Proposed"} value {formatCents(v.amount_cents)} ex VAT. Percentages are applied to this value in whole cents (largest remainder), so the stages always sum to it exactly.</p>
            <div className="mt-3 space-y-2">
              {rows.map((r, i) => (
                <div key={i} className="flex flex-wrap items-end gap-2">
                  <Input label="Stage" value={r.name} disabled={stagesLocked} onChange={(e) => setEdit({ ...edit, [v.id]: rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                  <Input label="%" value={r.percent} disabled={stagesLocked} onChange={(e) => setEdit({ ...edit, [v.id]: rows.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)) })} />
                </div>
              ))}
              <p className={`text-sm ${total === 100 ? "text-slate-600" : "font-semibold text-red-700"}`}>Total {total}% {total === 100 ? "" : "- must be exactly 100%"}</p>
              {stagesLocked && !billingId && <p className="text-xs text-slate-600">Only a manager can change an approved variation&apos;s schedule.</p>}
              {(v.status === "DRAFT" || (isAdmin && !billingId)) && (
                <div className="space-y-2">
                <div className="flex flex-wrap items-end gap-2">
                  <Button size="sm" variant="secondary" disabled={working} aria-describedby={working ? sid("sched-busy") : undefined} onClick={() => setEdit({ ...edit, [v.id]: [...rows, { name: "", percent: "" }] })}>Add stage</Button>
                  {rows.length > 1 && <Button size="sm" variant="secondary" disabled={working} aria-describedby={working ? sid("sched-busy") : undefined} onClick={() => setEdit({ ...edit, [v.id]: rows.slice(0, -1) })}>Remove last</Button>}
                  {v.status === "DRAFT" ? (
                    <Button size="sm" disabled={working || total !== 100} aria-describedby={working ? sid("sched-busy") : total !== 100 ? sid("sched-total") : undefined} onClick={async () => { if (await act(() => saveVariationScheduleAction(projectId, v.id, rows), `Saved the ${v.code} billing schedule.`)) dropEdit(v.id); }}>Save schedule</Button>
                  ) : (
                    <>
                      <Input label="Reason for amendment" value={reasonText} onChange={(e) => setReason({ ...reason, [v.id]: e.target.value })} />
                      <Button size="sm" disabled={working || total !== 100 || !reasonText.trim()} aria-describedby={working ? sid("sched-busy") : total !== 100 ? sid("sched-total") : !reasonText.trim() ? sid("sched-reason") : undefined} onClick={async () => { if (await act(() => amendVariationScheduleAction(projectId, v.id, rows, reason[v.id]), `Amended the ${v.code} schedule (audited).`)) { setReason((m) => ({ ...m, [v.id]: "" })); dropEdit(v.id); } }}>Amend schedule</Button>
                    </>
                  )}
                </div>
                {working ? <p id={sid("sched-busy")} className="text-sm text-slate-700">{BUSY}</p>
                  : total !== 100 ? <p id={sid("sched-total")} className="text-sm text-slate-700">Total must be exactly 100% to {v.status === "DRAFT" ? "save" : "amend"} the schedule.</p>
                  : v.status !== "DRAFT" && !reasonText.trim() ? <p id={sid("sched-reason")} className="text-sm text-slate-700">Enter a reason to amend.</p> : null}
                </div>
              )}
              {v.status === "APPROVED" && billingId && <p className="text-xs text-slate-600">Billing has started. The schedule can no longer be amended once the billing project has claims or progress; the database refuses.</p>}
            </div>
            </details>}
            {canToggle && (wsOpen || everOpened[v.id]) && <div id={`ws-${v.id}`} className={wsOpen ? "mt-4 border-t border-slate-200 pt-2" : "hidden"}><ProjectWorkspace key={billingId} id={billingId!} embedded /></div>}
          </section>
        );
      })}

      {state && c && (() => { const cc = c; return (
        <>
      <Panel>
        <PanelTitle>Consolidated billing (base + variations)</PanelTitle>
        <div className="mt-4 overflow-x-auto">
          <Table>
            <THead><TR><TH>Scope</TH><TH align="right">Contract</TH><TH align="right">Earned</TH><TH align="right">Billed / committed</TH><TH align="right">Claimable now</TH><TH align="right">Remaining</TH></TR></THead>
            <TBody>
              {cc.scopes.map((s) => (
                <TR key={s.projectId}>
                  <TD>{s.scope === "BASE" ? "Original contract" : isAdmin ? <Link className="underline" href={`/projects/${s.projectId}`}>{s.variationCode} billing</Link> : `${s.variationCode} variation`}</TD>
                  <TD align="right" className="whitespace-nowrap tabular-nums">{formatCents(s.contractCents)}</TD>
                  <TD align="right" className="whitespace-nowrap tabular-nums">{formatCents(s.earnedCents)}</TD>
                  <TD align="right" className="whitespace-nowrap tabular-nums">{formatCents(s.committedCents)}</TD>
                  <TD align="right" className="whitespace-nowrap tabular-nums">{formatCents(s.claimableCents)}</TD>
                  <TD align="right" className="whitespace-nowrap tabular-nums">{formatCents(s.remainingCents)}</TD>
                </TR>
              ))}
              <TR>
                <TD className="font-semibold">Total (billable)</TD>
                {[cc.totals.contractCents, cc.totals.earnedCents, cc.totals.committedCents, cc.totals.claimableCents, cc.totals.remainingCents].map((n, i) => <TD key={i} align="right" className="whitespace-nowrap font-semibold tabular-nums">{formatCents(n)}</TD>)}
              </TR>
            </TBody>
          </Table>
        </div>
        {cc.unbilledApprovedVariations.length > 0 && (
          <Alert tone="warning">Approved but not yet billable (no billing started): {cc.unbilledApprovedVariations.map((v) => `${v.code} ${formatCents(v.amountCents)}`).join(", ")}. They are in the revised contract value but not in the billable totals above.</Alert>
        )}
      </Panel>

      {isAdmin && cc.closureBlockers.length > 0 && (
        <Alert tone="info">This project cannot be completed or closed yet: {cc.closureBlockers.join("; ")}.</Alert>
      )}
      <Alert tone="info">Negative variations (credits, omissions, cancellations) are not supported: Toolbox never creates a credit note or a negative Sale. Handle a reduction in scope manually in Cin7.</Alert>
        </>
      ); })()}
    </div>
  );
}
