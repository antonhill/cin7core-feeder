"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import type { ProjectView } from "@/lib/projects/project-view";
import { DeliveryAllocationPanel } from "./DeliveryAllocationPanel";
import { getPhysicalStatusAction, type PhysicalActionResult } from "../physical-actions";

// PRODUCTS & FULFILMENT: the approved product scope (inherited from the quotation / variation - never re-typed) against what Cin7 actually holds,
// read live and read-only. Assembly, picking and shipping are done in Cin7. "?" = Cin7 did not return a readable number (never treated as zero);
// "-" = not applicable. Commercial progress percentages play no part.
const q = (n: number | null) => (n === null ? "?" : String(n));

export function PhysicalPanel({ view }: { view: ProjectView }) {
  const [res, setRes] = useState<PhysicalActionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => { setBusy(true); setRes(await getPhysicalStatusAction(view.project.id)); setBusy(false); };

  return (
    <div className="mt-6 space-y-6">
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PanelTitle>Products &amp; fulfilment</PanelTitle>
          <Button size="sm" variant="secondary" disabled={busy} onClick={load}>{busy ? "Reading Cin7…" : res ? "Refresh from Cin7" : "Read from Cin7"}</Button>
        </div>
        <p className="mt-1 text-xs text-slate-500">Quoted = the approved scope. Ordered, Invoiced (non-voided invoices), Shipped, Available and Assembled come from Cin7 and are read-only. Available and Assembled are account-wide for the SKU, not attributable to this Sale; the shortfall is an estimate. &quot;?&quot; means unknown, never zero.</p>
        {res && !res.ok && <Alert tone="danger">{res.error}</Alert>}
        {res?.ok && res.data?.sections.map((sec) => (
          <div key={sec.label} className="mt-5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium text-slate-900">{sec.label}</p>
              <Badge tone={sec.scope === "BASE" ? "neutral" : "warning"}>{sec.scope}</Badge>
              <span className="text-sm text-slate-600">{sec.linked ? `Cin7 Sale ${sec.saleNumber ?? ""}` : "No Cin7 Sale linked yet - quantities from Cin7 are unknown"} · as of {new Date(sec.asOf).toLocaleString()}</span>
            </div>
            {sec.scopeBlockers.length > 0 && <div className="mt-2"><Alert tone="warning">Unmapped scope (not yet orderable): {sec.scopeBlockers.join(" | ")}</Alert></div>}
            {sec.exceptions.length > 0 && <div className="mt-2 space-y-1">{sec.exceptions.map((e, i) => <Alert key={i} tone="warning">{e.code}: {e.message}</Alert>)}</div>}
            {sec.rows.length === 0 ? <p className="mt-2 text-sm text-slate-600">No physical products in this scope.</p> : (
              <div className="mt-2 overflow-x-auto">
                <Table>
                  <THead><TR><TH>SKU</TH><TH align="right">Quoted</TH><TH align="right">Ordered</TH><TH align="right">Assembled</TH><TH align="right">Available</TH><TH align="right">Invoiced</TH><TH align="right">Shipped</TH><TH align="right">Remaining to invoice</TH><TH align="right">Remaining to deliver</TH><TH align="right">Shortfall (est.)</TH></TR></THead>
                  <TBody>
                    {sec.rows.map((r) => (
                      <TR key={r.sku}>
                        <TD><div className="font-mono">{r.sku}</div><div className="text-xs text-slate-500">{r.name}</div></TD>
                        <TD align="right" className="tabular-nums">{r.quoted === null ? "-" : r.quoted}</TD>
                        {[r.ordered, null].slice(0, 1).map((v, i) => <TD key={i} align="right" className="tabular-nums">{q(v)}</TD>)}
                        <TD align="right" className="tabular-nums">{r.hasAssemblyRecords ? q(r.assemblyCompleted) : "-"}{r.hasAssemblyRecords && r.assemblyInProgress ? <span className="text-xs text-slate-500"> (+{r.assemblyInProgress} in progress)</span> : null}</TD>
                        {[r.available, r.invoiced, r.shipped, r.remainingToInvoice, r.remainingToDeliver, r.shortfall].map((v, i) => <TD key={i} align="right" className="tabular-nums">{q(v)}</TD>)}
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
          </div>
        ))}
      </Panel>
      <DeliveryAllocationPanel view={view} />
    </div>
  );
}
