"use client";

import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { inspectSaleSo00028Action } from "./actions";
import type { SaleInspection } from "@/lib/projects/sale-inspection";

// TEMPORARY (UAT-027) read-only diagnostic. Reads SO-00028 from Cin7 once per click; stores nothing, writes nothing. Remove after the investigation.

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));

export default function Uat027Page() {
  const [result, setResult] = useState<SaleInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  function run() {
    start(async () => {
      const r = await inspectSaleSo00028Action();
      if (r.ok && r.data) { setResult(r.data); setError(null); } else { setResult(null); setError(r.error ?? "Unknown error"); }
    });
  }

  return (
    <main className="mx-auto w-full max-w-[1100px] px-6 py-12">
      <h1 className="text-xl font-semibold text-slate-900">UAT-027 — inspect Cin7 Sale SO-00028 (temporary, read-only)</h1>
      <p className="mt-2 max-w-3xl text-sm text-slate-600">
        One read-only request to Cin7 for the Sale linked to PRJ-NQ-Q-0017-V001. Nothing is written to Cin7 or to the Toolbox, and nothing is stored. Organisation owners and admins only.
      </p>
      <div className="mt-4"><Button onClick={run} loading={busy}>Read SO-00028 from Cin7</Button></div>
      {error && <div className="mt-6"><Alert tone="danger">{error}</Alert></div>}
      {result && (
        <div className="mt-6 space-y-4" data-testid="inspection">
          <Panel>
            <PanelTitle>Sale</PanelTitle>
            <dl className="mt-3 grid grid-cols-[12rem_1fr] gap-y-1 text-sm">
              <dt className="text-slate-500">Cin7 Sale ID</dt><dd className="font-mono text-xs">{result.saleId}</dd>
              <dt className="text-slate-500">Type</dt><dd>{show(result.type)}</dd>
              <dt className="text-slate-500">Order status</dt><dd>{show(result.orderStatus)}</dd>
              <dt className="text-slate-500">Customer</dt><dd>{show(result.customer)}</dd>
              <dt className="text-slate-500">ExternalID</dt><dd className="font-mono text-xs">{show(result.externalId)}</dd>
              <dt className="text-slate-500">Tax rule</dt><dd>{show(result.taxRule)}</dd>
              <dt className="text-slate-500">Order totals (ex VAT / VAT / total)</dt><dd>{show(result.orderTotals.exVat)} / {show(result.orderTotals.vat)} / {show(result.orderTotals.total)}</dd>
              <dt className="text-slate-500">Order product lines</dt><dd>{result.orderProductLineCount}</dd>
              <dt className="text-slate-500">Invoices</dt><dd>{result.invoiceCount}{result.invoices.length ? ` (${result.invoices.map((i) => `${show(i.number)} ${show(i.status)}`).join(", ")})` : ""}</dd>
              <dt className="text-slate-500">Fulfilments</dt><dd className="font-semibold">{result.fulfilmentCount}</dd>
            </dl>
          </Panel>
          <Panel>
            <PanelTitle>Additional charges</PanelTitle>
            {result.additionalCharges.length === 0 ? <p className="mt-2 text-sm text-slate-500">None.</p> : (
              <ul className="mt-2 text-sm">{result.additionalCharges.map((c, i) => <li key={i}>{show(c.description)} — qty {show(c.quantity)}, price {show(c.priceExVat)}, VAT {show(c.vat)}, total {show(c.total)}</li>)}</ul>
            )}
          </Panel>
          {result.orderProductLines.length > 0 && (
            <Panel>
              <PanelTitle>Order product lines</PanelTitle>
              <ul className="mt-2 text-sm">{result.orderProductLines.map((l, i) => <li key={i}>{show(l.sku)} — qty {show(l.quantity)}, price {show(l.priceExVat)}</li>)}</ul>
            </Panel>
          )}
          {result.fulfilments.map((f, i) => (
            <Panel key={i}>
              <PanelTitle>Fulfilment {show(f.number)} {f.looksEmpty ? "— no physical activity" : "— HAS physical activity"}</PanelTitle>
              <dl className="mt-3 grid grid-cols-[12rem_1fr] gap-y-1 text-sm">
                <dt className="text-slate-500">Fulfilment status</dt><dd>{show(f.status)}</dd>
                <dt className="text-slate-500">Linked invoice</dt><dd>{show(f.linkedInvoice)}</dd>
                <dt className="text-slate-500">Pick</dt><dd>{show(f.pick.status)} — {f.pick.lineCount} line(s), quantity {f.pick.totalQuantity}</dd>
                <dt className="text-slate-500">Pack</dt><dd>{show(f.pack.status)} — {f.pack.lineCount} line(s), quantity {f.pack.totalQuantity}</dd>
                <dt className="text-slate-500">Ship</dt><dd>{show(f.ship.status)} — {f.ship.lineCount} line(s), {f.ship.shippedLineCount} shipped, shipment date {f.ship.hasShipmentDate ? "present" : "none"}</dd>
              </dl>
              {[...f.pick.lines.map((l) => ({ ...l, stage: "Pick" })), ...f.pack.lines.map((l) => ({ ...l, stage: "Pack" }))].length > 0 && (
                <ul className="mt-2 text-sm">
                  {[...f.pick.lines.map((l) => ({ ...l, stage: "Pick" })), ...f.pack.lines.map((l) => ({ ...l, stage: "Pack" }))].map((l, j) => <li key={j}>{l.stage}: {show(l.sku)} × {show(l.quantity)}</li>)}
                </ul>
              )}
            </Panel>
          ))}
        </div>
      )}
    </main>
  );
}
