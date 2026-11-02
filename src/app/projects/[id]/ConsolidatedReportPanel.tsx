"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { buildConsolidatedPhysical, type ConsolidatedCommercial } from "@/lib/projects/consolidated-report";
import { formatCents, type ProjectView } from "@/lib/projects/project-view";
import { getPhysicalStatusAction, type PhysicalActionResult } from "../physical-actions";
import { getConsolidatedCommercialAction } from "../variation-billing-actions";

// CONSOLIDATED view of the original project: the original contract and every approved variation, each counted once. Commercial figures come from
// Toolbox records only. "Remaining contract value" (everything still to be billed) is deliberately separate from "Claimable now" (what approved
// progress currently allows). Physical quantities are read from Cin7 on request; "?" means unknown, never zero.
const q = (n: number | null) => (n === null ? "?" : String(n));

export function ConsolidatedReportPanel({ view }: { view: ProjectView }) {
  const [rep, setRep] = useState<ConsolidatedCommercial | null>(null);
  const [phys, setPhys] = useState<PhysicalActionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loadCommercial = async () => { setBusy(true); const r = await getConsolidatedCommercialAction(view.project.id); if (r.ok && r.data) { setRep(r.data); setError(null); } else setError(r.error ?? "Could not load."); setBusy(false); };
  const loadPhysical = async () => { setBusy(true); setPhys(await getPhysicalStatusAction(view.project.id)); setBusy(false); };
  const physical = phys?.ok && phys.data ? buildConsolidatedPhysical(phys.data.sections.map((s) => ({ label: s.label, scope: s.scope, linked: s.linked, rows: s.rows.map((r) => ({ sku: r.sku, name: r.name, quoted: r.quoted, ordered: r.ordered, invoiced: r.invoiced, shipped: r.shipped, remainingToDeliver: r.remainingToDeliver })) }))) : null;

  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PanelTitle>Consolidated project position (original + approved variations)</PanelTitle>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={loadCommercial}>{rep ? "Refresh" : "Show commercial position"}</Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={loadPhysical}>{physical ? "Refresh physical (Cin7)" : "Add physical products (reads Cin7)"}</Button>
        </div>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {rep && (
        <div className="mt-3 space-y-4 text-sm">
          {rep.warnings.map((w, i) => <Alert key={i} tone="warning">{w}</Alert>)}
          <dl className="grid max-w-2xl grid-cols-2 gap-y-1 tabular-nums">
            <dt className="text-slate-600">Original contract value</dt><dd className="text-right">{formatCents(rep.contract.originalCents)}</dd>
            <dt className="text-slate-600">Approved variations</dt><dd className="text-right">{formatCents(rep.contract.approvedVariationsCents)}</dd>
            <dt className="font-semibold">Revised contract value</dt><dd className="text-right font-semibold">{formatCents(rep.contract.revisedCents)}</dd>
            <dt className="text-slate-600">Invoiced - original contract</dt><dd className="text-right">{formatCents(rep.invoiced.originalCents)}</dd>
            <dt className="text-slate-600">Invoiced - variations</dt><dd className="text-right">{formatCents(rep.invoiced.variationsCents)}</dd>
            <dt className="font-semibold">Total invoiced (ex VAT, in Cin7)</dt><dd className="text-right font-semibold">{formatCents(rep.invoiced.totalCents)}</dd>
            <dt className="font-semibold">Remaining contract value</dt><dd className="text-right font-semibold">{formatCents(rep.remainingContractCents)}</dd>
            <dt className="text-slate-600">of which claimable now (approved progress)</dt><dd className="text-right">{formatCents(rep.claimableNowCents)}</dd>
          </dl>
          <div className="overflow-x-auto">
            <Table>
              <THead><TR><TH>Scope</TH><TH align="right">Contract</TH><TH align="right">Invoiced</TH><TH>Cin7 invoices</TH><TH align="right">Remaining</TH><TH>Claims</TH></TR></THead>
              <TBody>{rep.scopes.map((s) => (
                <TR key={s.projectId}>
                  <TD>{s.label} {s.scope === "VARIATION" && <Badge tone="warning">VARIATION</Badge>}{!s.billingStarted && <div className="text-xs text-amber-700">billing not started</div>}</TD>
                  <TD align="right" className="tabular-nums">{formatCents(s.contractCents)}</TD><TD align="right" className="tabular-nums">{formatCents(s.invoicedCents)}</TD>
                  <TD className="font-mono text-xs">{s.invoiceNumbers.join(", ") || "-"}</TD><TD align="right" className="tabular-nums">{formatCents(s.remainingCents)}</TD>
                  <TD className="text-xs">{s.claims.length === 0 ? "-" : s.claims.map((c) => `${c.claimNumber} ${c.status}${c.invoiceNumber ? ` (${c.invoiceNumber})` : ""} ${formatCents(c.subtotalCents)}`).join("; ")}</TD>
                </TR>))}</TBody>
            </Table>
          </div>
        </div>
      )}
      {phys && !phys.ok && <Alert tone="danger">{phys.error}</Alert>}
      {physical && (
        <div className="mt-4 space-y-3 text-sm">
          <p className="font-medium text-slate-800">Physical products by billing scope - outstanding to deliver: {physical.outstandingUnits === null ? "unknown (some quantities unreadable or no Sale linked)" : physical.outstandingUnits}</p>
          {physical.sections.map((s) => (
            <div key={s.label}>
              <p className="text-slate-700">{s.label}: {s.linked ? `outstanding ${s.outstandingUnits === null ? "unknown" : s.outstandingUnits}` : "no Cin7 Sale linked yet"}</p>
              {s.rows.length > 0 && <ul className="text-xs text-slate-600">{s.rows.map((r) => <li key={r.sku} className="tabular-nums"><span className="font-mono">{r.sku}</span> quoted {q(r.quoted)} · ordered {q(r.ordered)} · invoiced {q(r.invoiced)} · shipped {q(r.shipped)} · to deliver {q(r.remainingToDeliver)}</li>)}</ul>}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
