"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import type { ProjectView } from "@/lib/projects/project-view";
import { getPhysicalStatusAction, type PhysicalActionResult } from "../physical-actions";

// PHYSICAL progress, read live from Cin7 (nothing here writes). Manual assembly and fulfilment happen in Cin7; this is visibility only, and it is
// deliberately independent of the commercial progress percentages - a 65% manufacturing claim says nothing about how many units exist.
const q = (n: number | null) => (n === null ? "?" : String(n));

export function PhysicalPanel({ view }: { view: ProjectView }) {
  const [res, setRes] = useState<PhysicalActionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => { setBusy(true); setRes(await getPhysicalStatusAction(view.project.id)); setBusy(false); };

  return (
    <div className="mt-6 space-y-6">
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PanelTitle>Physical delivery (live from Cin7)</PanelTitle>
          <Button size="sm" variant="secondary" disabled={busy} onClick={load}>{busy ? "Reading Cin7…" : res ? "Refresh from Cin7" : "Read from Cin7"}</Button>
        </div>
        <p className="mt-1 text-xs text-slate-500">Read-only. Assembly, picking and shipping are done in Cin7. Stock and assembly figures are account-wide for the SKU, not attributable to this Sale; the shortfall is an estimate. &quot;?&quot; means Cin7 did not return a readable number - it is never treated as zero.</p>
        {res && !res.ok && <Alert tone="danger">{res.error}</Alert>}
        {res?.ok && res.data && !res.data.linked && <Alert tone="info">This project has no linked Cin7 Sale yet.</Alert>}
        {res?.ok && res.data?.linked && (
          <>
            <p className="mt-3 text-sm text-slate-600">Sale {res.data.saleNumber ?? ""} · as of {res.data.asOf ? new Date(res.data.asOf).toLocaleString() : ""}</p>
            {res.data.exceptions && res.data.exceptions.length > 0 && (
              <div className="mt-3 space-y-1">{res.data.exceptions.map((e, i) => <Alert key={i} tone="warning">{e.code}: {e.message}</Alert>)}</div>
            )}
            <div className="mt-4 overflow-x-auto">
              <Table>
                <THead><TR><TH>SKU</TH><TH align="right">Ordered</TH><TH align="right">Invoiced</TH><TH align="right">Shipped</TH><TH align="right">Remaining</TH><TH align="right">On hand</TH><TH align="right">Available</TH><TH align="right">Shortfall (est.)</TH><TH align="right">Assembly in progress</TH><TH align="right">Assembly completed</TH></TR></THead>
                <TBody>
                  {(res.data.rows ?? []).map((r) => (
                    <TR key={r.sku}>
                      <TD><div className="font-mono">{r.sku}</div><div className="text-xs text-slate-500">{r.name}</div></TD>
                      {[r.ordered, r.invoiced, r.shipped, r.remaining, r.onHand, r.available, r.shortfall].map((v, i) => <TD key={i} align="right" className="tabular-nums">{q(v)}</TD>)}
                      <TD align="right" className="tabular-nums">{r.hasAssemblyRecords ? q(r.assemblyInProgress) : "–"}</TD>
                      <TD align="right" className="tabular-nums">{r.hasAssemblyRecords ? q(r.assemblyCompleted) : "–"}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}
