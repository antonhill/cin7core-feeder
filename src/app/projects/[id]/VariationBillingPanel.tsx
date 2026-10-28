"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { formatCents, type ProjectView } from "@/lib/projects/project-view";
import { amendVariationScheduleAction, getVariationBillingAction, saveVariationScheduleAction, startVariationBillingAction, type VariationBillingState } from "../variation-billing-actions";

// Variation BILLING: each approved variation has its own percentage schedule (default one 100% stage) and, once a manager starts billing,
// its own billing project and Cin7 Sale. Consolidated figures sum the base and variation billing projects. Nothing here writes to Cin7.
type Run = (fn: () => Promise<{ ok: boolean; error?: string }>, done?: string) => Promise<boolean>;
type Row = { name: string; percent: string };

const pct = (bps: number) => (bps / 100).toFixed(2).replace(/\.00$/, "");
const rowsOf = (s: Array<{ name: string; bps: number }> | undefined): Row[] => (s && s.length ? s.map((x) => ({ name: x.name, percent: pct(x.bps) })) : [{ name: "Variation", percent: "100" }]);
const totalOf = (rows: Row[]) => Math.round(rows.reduce((n, r) => n + (Number(r.percent) || 0), 0) * 100) / 100;

export function VariationBillingPanel({ view, isAdmin, run, working }: { view: ProjectView; isAdmin: boolean; run: Run; working: boolean }) {
  const projectId = view.project.id;
  const [state, setState] = useState<VariationBillingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<Record<string, Row[]>>({});
  const [reason, setReason] = useState<Record<string, string>>({});

  const [version, setVersion] = useState(0);
  const variationKey = view.variations.map((v) => `${v.id}:${v.status}`).join(",");
  useEffect(() => {
    let live = true;
    void getVariationBillingAction(projectId).then((r) => {
      if (!live) return;
      if (r.ok && r.data) { setState(r.data); setError(null); } else setError(r.error ?? "Could not load variation billing.");
    });
    return () => { live = false; };
  }, [projectId, variationKey, version]);

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => { if (await run(fn, done)) setVersion((n) => n + 1); };
  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!state) return <p className="text-sm text-slate-500">Loading variation billing…</p>;
  const c = state.consolidated;
  const variations = view.variations.filter((v) => v.status !== "REJECTED");

  return (
    <div className="space-y-6">
      <Panel>
        <PanelTitle>Consolidated billing (base + variations)</PanelTitle>
        <div className="mt-4 overflow-x-auto">
          <Table>
            <THead><TR><TH>Scope</TH><TH align="right">Contract</TH><TH align="right">Earned</TH><TH align="right">Billed / committed</TH><TH align="right">Claimable now</TH><TH align="right">Remaining</TH></TR></THead>
            <TBody>
              {c.scopes.map((s) => (
                <TR key={s.projectId}>
                  <TD>{s.scope === "BASE" ? "Original contract" : <Link className="underline" href={`/projects/${s.projectId}`}>{s.variationCode} billing</Link>}</TD>
                  <TD align="right" className="whitespace-nowrap tabular-nums">{formatCents(s.contractCents)}</TD>
                  <TD align="right" className="whitespace-nowrap tabular-nums">{formatCents(s.earnedCents)}</TD>
                  <TD align="right" className="whitespace-nowrap tabular-nums">{formatCents(s.committedCents)}</TD>
                  <TD align="right" className="whitespace-nowrap tabular-nums">{formatCents(s.claimableCents)}</TD>
                  <TD align="right" className="whitespace-nowrap tabular-nums">{formatCents(s.remainingCents)}</TD>
                </TR>
              ))}
              <TR>
                <TD className="font-semibold">Total (billable)</TD>
                {[c.totals.contractCents, c.totals.earnedCents, c.totals.committedCents, c.totals.claimableCents, c.totals.remainingCents].map((n, i) => <TD key={i} align="right" className="whitespace-nowrap font-semibold tabular-nums">{formatCents(n)}</TD>)}
              </TR>
            </TBody>
          </Table>
        </div>
        {c.unbilledApprovedVariations.length > 0 && (
          <Alert tone="warning">Approved but not yet billable (no billing started): {c.unbilledApprovedVariations.map((v) => `${v.code} ${formatCents(v.amountCents)}`).join(", ")}. They are in the revised contract value but not in the billable totals above.</Alert>
        )}
      </Panel>

      {variations.length === 0 ? <p className="text-sm text-slate-600">No variations to bill.</p> : variations.map((v) => {
        const sched = state.schedules[v.id];
        const rows = edit[v.id] ?? rowsOf(sched);
        const total = totalOf(rows);
        const billingId = state.billingProjectByVariation[v.id];
        const legacy = v.status === "APPROVED" && (!sched || sched.length === 0);
        return (
          <Panel key={v.id}>
            <PanelTitle>{v.code} – {v.title} <Badge tone={v.status === "APPROVED" ? "success" : "neutral"}>{v.status}</Badge></PanelTitle>
            <p className="mt-1 text-xs text-slate-500">Approved value {formatCents(v.amount_cents)} ex VAT. Percentages are applied to this value in whole cents (largest remainder), so the stages always sum to it exactly.</p>
            {legacy && <Alert tone="warning">This variation was approved before billing schedules existed. A manager must set its schedule (an audited amendment) before billing can start. Nothing is created automatically.</Alert>}
            <div className="mt-3 space-y-2">
              {rows.map((r, i) => (
                <div key={i} className="flex flex-wrap items-end gap-2">
                  <Input label="Stage" value={r.name} disabled={v.status === "APPROVED" && !isAdmin || !!billingId && v.status === "APPROVED"} onChange={(e) => setEdit({ ...edit, [v.id]: rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                  <Input label="%" value={r.percent} disabled={v.status === "APPROVED" && !isAdmin || !!billingId && v.status === "APPROVED"} onChange={(e) => setEdit({ ...edit, [v.id]: rows.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)) })} />
                </div>
              ))}
              <p className={`text-sm ${total === 100 ? "text-slate-600" : "font-semibold text-red-700"}`}>Total {total}% {total === 100 ? "" : "- must be exactly 100%"}</p>
              {(v.status === "DRAFT" || (isAdmin && !billingId)) && (
                <div className="flex flex-wrap items-end gap-2">
                  <Button size="sm" variant="secondary" disabled={working} onClick={() => setEdit({ ...edit, [v.id]: [...rows, { name: "", percent: "" }] })}>Add stage</Button>
                  {rows.length > 1 && <Button size="sm" variant="secondary" disabled={working} onClick={() => setEdit({ ...edit, [v.id]: rows.slice(0, -1) })}>Remove last</Button>}
                  {v.status === "DRAFT" ? (
                    <Button size="sm" disabled={working || total !== 100} onClick={() => act(() => saveVariationScheduleAction(projectId, v.id, rows), `Saved the ${v.code} billing schedule.`)}>Save schedule</Button>
                  ) : (
                    <>
                      <Input label="Reason for amendment" value={reason[v.id] ?? ""} onChange={(e) => setReason({ ...reason, [v.id]: e.target.value })} />
                      <Button size="sm" disabled={working || total !== 100 || !(reason[v.id] ?? "").trim()} onClick={() => act(() => amendVariationScheduleAction(projectId, v.id, rows, reason[v.id]), `Amended the ${v.code} schedule (audited).`)}>Amend schedule</Button>
                    </>
                  )}
                </div>
              )}
              {v.status === "APPROVED" && billingId && <p className="text-xs text-slate-500">Billing has started. The schedule can no longer be amended once the billing project has claims or progress; the database refuses.</p>}
            </div>
            {v.status === "APPROVED" && (
              <div className="mt-4">
                {billingId ? (
                  <Link className="text-sm underline" href={`/projects/${billingId}`}>Open the {v.code} billing project (claims, progress, Cin7 Sale link)</Link>
                ) : isAdmin ? (
                  <Button disabled={working || legacy} onClick={() => act(() => startVariationBillingAction(projectId, v.id), `Started billing for ${v.code}. Link its Cin7 Sale from the billing project.`)}>Start variation billing</Button>
                ) : <span className="text-xs text-slate-500">A manager starts variation billing.</span>}
              </div>
            )}
          </Panel>
        );
      })}
    </div>
  );
}
