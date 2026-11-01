"use client";

import { Fragment } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import type { QuoteDraft } from "@/newquip/grower/draft";
import type { BudgetQuote } from "@/newquip/grower/quote-bridge";
import type { GrowerItemKey } from "@/newquip/grower/types";
import type { AcceptedBaseline } from "@/newquip/quote/baseline";
import { buildMarginSheet, NO_AMOUNT_YET, previewCostOverrides, type MarginFigures, type MarginSheet } from "@/newquip/quote/margin";
import { fmtCents, NumField, TextField } from "../fields";

// INTERNAL margin sheet (managers only - the page renders this only when the viewer may see commercials; the server also redacts the data for
// everyone else). Product, assembly/package, section and project margins, ex VAT, with the reporting basis stated. Once the quote is final it
// shows the sheet FROZEN at approval, not a live recalculation. Never shown on the customer quote.

const pct = (n: number | null) => (n === null ? "-" : `${n.toFixed(2)}%`);
const Cells = ({ m }: { m: MarginFigures }) => (
  <>
    <td className="py-2 pr-3 text-right tabular-nums">{fmtCents(m.sellingCents)}</td>
    <td className="py-2 pr-3 text-right tabular-nums">{fmtCents(m.costCents)}</td>
    <td className="py-2 pr-3 text-right tabular-nums">{fmtCents(m.gpCents)}</td>
    <td className="py-2 pr-3 text-right tabular-nums">{pct(m.marginPct)}</td>
    <td className="py-2 text-right tabular-nums">{pct(m.markupPct)}</td>
  </>
);
const Head = ({ first }: { first: string }) => (
  <thead><tr className="border-b text-left text-xs uppercase tracking-wide text-slate-500">
    <th className="py-2 pr-3">{first}</th><th className="py-2 pr-3 text-right">Selling</th><th className="py-2 pr-3 text-right">Est. cost</th><th className="py-2 pr-3 text-right">Gross profit</th><th className="py-2 pr-3 text-right">Margin</th><th className="py-2 text-right">Markup</th>
  </tr></thead>
);

export function MarginPanel({ budget, draft, final, frozen, editable, edit }: {
  budget: BudgetQuote; draft: QuoteDraft; final: boolean; frozen: AcceptedBaseline["internalMargin"] | undefined; editable: boolean;
  edit: (fn: (d: QuoteDraft) => void) => void;
}) {
  let sheet: MarginSheet | null = null;
  let error: string | null = null;
  if (final) sheet = frozen ?? null;
  // Incomplete overrides are reported beside their own inputs and left out of the live sheet; they never blank the sheet or the inputs.
  const preview = previewCostOverrides(draft.estimator.costOverrides);
  if (!final) { try { sheet = buildMarginSheet(budget, preview.usable); } catch (e) { error = e instanceof Error ? e.message : "Invalid cost override"; } }
  if (final && !sheet) return <Alert tone="info">This quote was approved before margins were frozen with the baseline; no frozen margin sheet exists.</Alert>;

  const setOverride = (key: string, patch: { rands?: number | null; reason?: string }) => edit((d) => {
    const cur = d.estimator.costOverrides?.[key as GrowerItemKey];
    const rands = patch.rands !== undefined ? patch.rands : cur && cur.lineCostCents >= 0 ? cur.lineCostCents / 100 : null;
    const reason = patch.reason !== undefined ? patch.reason : cur?.reason ?? "";
    const next = { ...(d.estimator.costOverrides ?? {}) };
    if (rands == null && !reason) delete next[key as GrowerItemKey];
    else next[key as GrowerItemKey] = { lineCostCents: rands == null ? NO_AMOUNT_YET : Math.round(rands * 100), reason, by: cur?.by ?? "", at: cur?.at ?? "" };
    d.estimator.costOverrides = next;
  });

  return (
    <Panel>
      <PanelTitle>Internal margins - workbook basis {final ? "(frozen at approval)" : "(live estimate)"}</PanelTitle>
      {sheet && <p className="mt-1 text-xs text-slate-500">Costs here come from the NewQuip Master workbook (landed cost), by quote line. A separate margin on Cin7 latest cost per physical SKU is shown in the next panel; the two are never combined. {sheet.reportingBasis}</p>}
      {error && <Alert tone="danger">{error}</Alert>}
      {sheet && (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-sm">
              <Head first="Project" />
              <tbody>
                <tr className="font-semibold"><td className="py-2 pr-3">Costed scope</td><Cells m={sheet.project} /></tr>
                <tr className="text-slate-600"><td className="py-2 pr-3">Services without a cost (delivery, installation) - selling value only</td><td className="py-2 pr-3 text-right tabular-nums">{fmtCents(sheet.project.uncostedChargesCents)}</td><td colSpan={4} /></tr>
                <tr className="border-t font-semibold"><td className="py-2 pr-3">Contract total (ex VAT)</td><td className="py-2 pr-3 text-right tabular-nums">{fmtCents(sheet.project.contractSellingCents)}</td><td colSpan={4} /></tr>
              </tbody>
            </table>
          </div>
          {sheet.project.incomplete && <Alert tone="warning">No project margin is shown because {sheet.project.missingCostLines.length} costed line(s) have no cost: {sheet.project.missingCostLines.join("; ")}. A partial total is never presented as the project margin.</Alert>}

          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <Head first="Section" />
              <tbody>{sheet.sections.map((s) => <tr key={s.section} className="border-b border-slate-100"><td className="py-2 pr-3">{s.section} <span className="text-xs text-slate-400">({s.lineCount})</span></td><Cells m={s} /></tr>)}</tbody>
            </table>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <Head first="Product / assembly" />
              <tbody>
                {sheet.lines.map((l) => (
                  <Fragment key={l.itemKey}>
                    <tr className="border-b border-slate-100 align-top">
                      <td className="py-2 pr-3">{l.label} {l.costBasis && <Badge tone={l.costBasis === "OVERRIDE" ? "warning" : "neutral"}>{l.costBasis}</Badge>}
                        {l.overrideReason && <div className="text-xs text-slate-500">Override: {l.overrideReason}</div>}</td>
                      <Cells m={l} />
                    </tr>
                    {l.components?.map((c, i) => (
                      <tr key={`${l.itemKey}-${i}`} className="text-xs text-slate-600"><td className="py-1 pl-6 pr-3">{c.sku ?? "-"} {c.description}</td><Cells m={c} /></tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!final && editable && (
        <div className="mt-5 space-y-3">
          <p className="text-sm font-medium text-slate-800">Cost overrides (audited: reason, who and when are recorded)</p>
          <p className="text-xs text-slate-500">Enter the total cost for a whole line (ex VAT) where the price source has none or is wrong. This changes the estimated cost only - never the selling price.</p>
          {Object.keys(preview.errors).length > 0 && <Alert tone="warning">Some cost overrides are incomplete and are not applied yet. Fix the highlighted lines, then Save.</Alert>}
          {sheet && [...sheet.lines.map((l) => ({ key: l.itemKey, label: l.label })), ...(budget.charges.filter((c) => c.amountExTax).map((c) => ({ key: c.key as string, label: c.label })))].map((l) => {
            const cur = draft.estimator.costOverrides?.[l.key as GrowerItemKey];
            return (
              <div key={l.key} className="grid gap-2 md:grid-cols-[1fr_12rem_1fr] md:items-end">
                <span className="text-sm text-slate-700">{l.label}</span>
                <NumField label="Line cost" unit="R ex VAT" value={cur && cur.lineCostCents >= 0 ? cur.lineCostCents / 100 : null} onChange={(v) => setOverride(l.key, { rands: v })} />
                <TextField label="Reason" value={cur?.reason ?? ""} onChange={(v) => setOverride(l.key, { reason: v })} hint={preview.errors[l.key]} />
                {cur?.by && <span className="text-xs text-slate-400 md:col-span-3">Recorded by {cur.by} at {cur.at}</span>}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
