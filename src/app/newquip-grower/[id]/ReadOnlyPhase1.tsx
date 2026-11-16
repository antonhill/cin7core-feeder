"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { rand } from "./phase-ux-format";

// PHASE 1 FOR SOMEONE WHO DOES NOT OWN IT (the Estimator or Manager): a concise READ-ONLY summary of what the Rep configured. It never renders the Rep's editable customer, equipment or quantity forms, and it
// shows only customer-facing selling amounts: no supplier cost, rate, freight, margin or internal evidence is passed in.
export interface Phase1Line { key: string; label: string; sku: string | null; quantity: number | null; unitPrice: number | null; amountExVat: number | null; note?: string }
export interface Phase1Charge { label: string; amountExVat: number }

export function ReadOnlyPhase1({ owner, statusLine, customer, contact, site, rooms, extras, lines, charges, totals, nextLabel, onNext, moreDetail }: {
  owner: string; statusLine: string; customer: string; contact: string | null; site: string; rooms: number; extras: string[]; lines: Phase1Line[]; charges: Phase1Charge[];
  totals: { exVat: number | null; vat: number | null; incVat: number | null }; nextLabel: string | null; onNext?: () => void; moreDetail?: ReactNode;
}) {
  return (
    <div className="mt-4 space-y-4" data-testid="phase1-readonly">
      <section className="rounded-xl border border-slate-200 bg-white px-5 py-4" aria-label="Configuration status">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">Phase 1 · Configure &amp; Submit · read-only</p>
        <p className="mt-1 text-base font-semibold text-slate-900" data-testid="phase1-status">{statusLine}</p>
        <p className="mt-1 text-sm text-slate-700">This phase belongs to {owner}. You can see what was configured, not change it.</p>
        {nextLabel && onNext && <div className="mt-3"><Button type="button" className="min-h-11" onClick={onNext} data-testid="phase1-next">{nextLabel}</Button></div>}
      </section>

      <div className="flex flex-wrap items-start gap-4">
        <section className="min-w-0 flex-[1_1_28rem] rounded-xl border border-slate-200 bg-white" aria-labelledby="p1-products">
          <h3 id="p1-products" className="border-b border-slate-200 px-5 py-3 text-base font-bold text-slate-900">Included products <span className="font-medium text-slate-600">· {lines.length} line{lines.length === 1 ? "" : "s"}</span></h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm" data-testid="phase1-lines">
              <thead><tr className="text-left text-xs uppercase tracking-wide text-slate-600"><th className="px-5 py-2 font-semibold">Product</th><th className="px-2 py-2 text-right font-semibold">Quantity</th><th className="px-2 py-2 text-right font-semibold">Unit (ex VAT)</th><th className="px-5 py-2 text-right font-semibold">Amount (ex VAT)</th></tr></thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.key} className="border-t border-slate-100 align-top">
                    <td className="px-5 py-2"><span className="font-medium text-slate-900">{l.label}</span>{l.sku && <span className="ml-2 text-xs text-slate-600">{l.sku}</span>}{l.note && <span className="block text-xs text-slate-700">{l.note}</span>}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{l.quantity == null ? "—" : l.quantity.toLocaleString("en-US")}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{l.unitPrice == null ? "—" : rand(l.unitPrice)}</td>
                    <td className="whitespace-nowrap px-5 py-2 text-right font-semibold tabular-nums">{l.amountExVat == null ? <span className="font-medium text-amber-900">Not yet priced</span> : rand(l.amountExVat)}</td>
                  </tr>
                ))}
                {charges.map((c) => (
                  <tr key={c.label} className="border-t border-slate-100 bg-slate-50"><td className="px-5 py-2 text-slate-800" colSpan={3}>{c.label}</td><td className="whitespace-nowrap px-5 py-2 text-right tabular-nums">{rand(c.amountExVat)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="min-w-0 flex-[1_1_17rem] space-y-4">
          <section className="rounded-xl border border-slate-200 bg-white px-5 py-4" aria-label="Customer and site">
            <h3 className="text-base font-bold text-slate-900">Customer and site</h3>
            <dl className="mt-2 space-y-1 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-slate-700">Customer</dt><dd className="text-right font-medium text-slate-900" data-testid="phase1-customer">{customer || "—"}</dd></div>
              {contact && <div className="flex justify-between gap-3"><dt className="text-slate-700">Contact</dt><dd className="text-right font-medium text-slate-900">{contact}</dd></div>}
              <div className="flex justify-between gap-3"><dt className="text-slate-700">Site</dt><dd className="text-right font-medium text-slate-900">{site || "—"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-slate-700">Rooms</dt><dd className="text-right font-medium text-slate-900">{rooms}</dd></div>
              {extras.length > 0 && <div><dt className="text-slate-700">Optional extras</dt><dd className="font-medium text-slate-900">{extras.join(", ")}</dd></div>}
            </dl>
          </section>
          <section className="rounded-xl border border-slate-200 bg-white px-5 py-4" aria-label="Selling totals">
            <h3 className="text-base font-bold text-slate-900">Selling amounts</h3>
            <dl className="mt-2 space-y-1 text-sm tabular-nums">
              <div className="flex justify-between gap-3"><dt>Total ex VAT</dt><dd className="font-semibold" data-testid="phase1-total-ex">{totals.exVat == null ? "—" : rand(totals.exVat)}</dd></div>
              <div className="flex justify-between gap-3"><dt>VAT 15%</dt><dd>{totals.vat == null ? "—" : rand(totals.vat)}</dd></div>
              <div className="flex justify-between gap-3 border-t border-slate-200 pt-1"><dt className="font-semibold">Total inc VAT</dt><dd className="font-semibold">{totals.incVat == null ? "—" : rand(totals.incVat)}</dd></div>
            </dl>
          </section>
        </aside>
      </div>

      {moreDetail && <details className="rounded-xl border border-slate-200 bg-white px-5 py-2" data-testid="phase1-more"><summary className="min-h-11 cursor-pointer py-2.5 text-sm font-semibold text-slate-900">Full submission detail (read-only)</summary><div className="pb-3">{moreDetail}</div></details>}
    </div>
  );
}
