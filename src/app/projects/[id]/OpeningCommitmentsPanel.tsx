"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { formatCents, type ProjectView } from "@/lib/projects/project-view";
import { setOpeningCommitmentsAction } from "../actions";

// Opening commitments: value already committed / certified BEFORE this project entered the Toolbox claim workflow.
// Local record only — no claim, no Cin7 invoice. Managers/admins set them; they freeze once any claim exists.

const DEFAULT_REASON = "POC opening commercial commitments / prior certified amounts";
type Run = (fn: () => Promise<{ ok: boolean; error?: string }>, done?: string) => Promise<boolean>;

export function OpeningCommitmentsPanel({ view, isAdmin, run, working }: { view: ProjectView; isAdmin: boolean; run: Run; working: boolean }) {
  const existing = new Map(view.openingCommitments.map((o) => [o.stage_id, o.amount_cents]));
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(view.stages.map((s) => [s.id, existing.has(s.id) ? String((existing.get(s.id) as number) / 100) : ""])));
  const [reason, setReason] = useState(view.openingCommitments[0]?.reason ?? DEFAULT_REASON);
  const locked = view.openingCommitmentsLocked;
  const [expanded, setExpanded] = useState(false); // collapsed by default: most Projects have no opening commitments
  const has = view.openingCommitments.length > 0;
  const total = view.openingCommitments.reduce((n, o) => n + o.amount_cents, 0);
  if (!isAdmin && view.openingCommitments.length === 0) return null;

  return (
    <Panel>
      <PanelTitle>Opening commitments</PanelTitle>
      <p className="mt-1 text-sm text-slate-500">Value already committed / certified before this project entered the Toolbox claim workflow. Counts toward &quot;Billed / committed&quot;.</p>
      <div className="mt-3"><Alert tone="info">These values represent amounts already committed before the current Toolbox claim workflow. They do not create Cin7 invoices or claims.</Alert></div>
      {locked ? (
        <p className="mt-3 text-sm text-slate-600">Frozen — a claim exists. Total opening commitments: <strong className="tabular-nums">{formatCents(total)}</strong>.</p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        {has
          ? <span className="text-slate-700">Recorded: <strong className="tabular-nums">{formatCents(total)}</strong> across {view.openingCommitments.length} stage{view.openingCommitments.length === 1 ? "" : "s"}.</span>
          : <span className="text-slate-600">None recorded.</span>}
        {(has || (isAdmin && !locked)) && (
          <Button size="sm" variant="secondary" onClick={() => setExpanded((v) => !v)}>{expanded ? "Hide details" : has ? (isAdmin && !locked ? "View / edit" : "View details") : "Add Opening Commitments"}</Button>
        )}
      </div>
      {expanded && <>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full max-w-xl text-sm">
          <thead><tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500"><th className="py-2 text-left">Stage</th><th className="py-2 text-right">Stage value</th><th className="py-2 text-right">Opening committed (R)</th></tr></thead>
          <tbody>
            {view.stages.map((s) => (
              <tr key={s.id} className="border-b border-slate-100">
                <td className="py-2">{s.name}</td>
                <td className="py-2 text-right tabular-nums whitespace-nowrap text-slate-500">{formatCents(s.valueCents)}</td>
                <td className="py-2 text-right">
                  {isAdmin && !locked ? (
                    <input value={vals[s.id] ?? ""} onChange={(e) => setVals({ ...vals, [s.id]: e.target.value })} inputMode="decimal" placeholder="0" aria-label={`${s.name} opening committed`}
                      className="h-8 w-40 rounded-md border border-slate-300 px-2 text-right tabular-nums" />
                  ) : <span className="tabular-nums whitespace-nowrap">{formatCents(existing.get(s.id) ?? 0)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {isAdmin && !locked && (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="flex min-w-[320px] flex-1 flex-col gap-1 text-sm"><span className="font-medium text-slate-700">Reason</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} className="h-9 rounded-md border border-slate-300 px-3" /></label>
          <Button loading={working} disabled={!reason.trim()} onClick={() => run(() => setOpeningCommitmentsAction(view.project.id, view.stages.map((s) => ({ stageId: s.id, rands: vals[s.id] ?? "" })), reason), "Opening commitments saved. They now count toward billed / committed.")}>Save opening commitments</Button>
        </div>
      )}
      </>}
      {!isAdmin && <p className="mt-3 text-xs text-slate-500">Only a manager (org owner/admin) can set opening commitments.</p>}
    </Panel>
  );
}
