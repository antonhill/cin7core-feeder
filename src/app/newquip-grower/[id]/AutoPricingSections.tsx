"use client";

import { Button } from "@/components/ui/Button";
import { money, type AutoView } from "@/newquip/quote/estimator-workspace";

// The Estimator's automatic-pricing groups (presentational; INTERNAL: it shows supplier costs, rates and freight, so it only ever renders inside the cost-entitled workspace). It decides nothing and does no
// arithmetic: every figure was derived by estimator-workspace.ts from the pricing model's own result. "Ready for verification" and "Pricing exceptions" are the two groups that are not the Estimator's own decisions.

export const AUTO_LABEL = "Automatically priced — awaiting Manager verification";

/** The three counts, one line each. Only genuine outstanding actions are counted as "need confirmation" and "pricing exceptions": an automatically priced product is never a task. */
export function AutoSummary({ auto }: { auto: AutoView }) {
  return (
    <section aria-label="Automatic pricing summary" className="grid gap-2 rounded-xl border border-slate-200 bg-white p-3 sm:grid-cols-3 sm:p-4" data-testid="auto-summary">
      <p data-testid="auto-count-priced"><strong className="text-lg text-emerald-900">{auto.autoPriced}</strong> <span className="text-sm text-slate-900">automatically priced — awaiting Manager verification</span></p>
      <p data-testid="auto-count-confirm"><strong className="text-lg text-amber-900">{auto.needConfirmation}</strong> <span className="text-sm text-slate-900">{auto.needConfirmation === 1 ? "needs" : "need"} confirmation</span></p>
      <p data-testid="auto-count-exceptions"><strong className="text-lg text-amber-900">{auto.exceptions.length}</strong> <span className="text-sm text-slate-900">{auto.exceptions.length === 1 ? "pricing exception" : "pricing exceptions"}</span></p>
    </section>
  );
}

/** Products priced entirely from automatic Cin7 costs: where the cost came from and how the price was reached, in front of the Estimator without opening anything. */
export function ReadyForVerification({ auto }: { auto: AutoView }) {
  if (auto.ready.length === 0) return null;
  return (
    <section aria-labelledby="ws-ready" className="overflow-hidden rounded-xl border border-slate-200 bg-white" data-testid="auto-ready">
      <div className="border-b border-slate-200 px-4 py-2.5 sm:px-5"><h2 id="ws-ready" className="text-base font-bold">Ready for verification <span className="text-emerald-900">· {auto.ready.length} line{auto.ready.length === 1 ? "" : "s"}</span></h2><p className="text-[13px] text-slate-800">{AUTO_LABEL}. A Manager checks each cost independently; you do not re-enter these.</p></div>
      <ul>
        {auto.ready.map((l) => (
          <li key={l.id} className="border-b border-slate-100 px-4 py-2.5 last:border-0 sm:px-5" data-testid={`ready-${l.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-[15px]">{l.label}</strong><span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-900">{AUTO_LABEL}</span></div>
            <div className="overflow-x-auto"><table className="mt-1.5 w-full min-w-[40rem] text-[13px]"><thead><tr className="text-left text-xs text-slate-700"><th className="py-1 pr-2">SKU</th><th className="px-2">CIN7 SUPPLIER</th><th className="px-2">COST</th><th className="px-2">DATE</th><th className="px-2">FX</th><th className="px-2">FREIGHT</th><th className="px-2 text-right">LANDED / UNIT</th><th className="px-2 text-right">SELLING / UNIT</th></tr></thead>
              <tbody>{l.skus.map((s) => (
                <tr key={s.sku} className="border-t border-slate-100 align-top" data-testid={`ready-sku-${s.sku}`}>
                  <td className="py-1 pr-2 font-semibold">{s.sku}</td><td className="px-2">{s.supplier ?? "—"}</td><td className="px-2 tabular-nums">{s.cost ?? "—"}</td><td className="px-2 tabular-nums">{s.costDate ?? "—"}</td>
                  <td className="px-2 tabular-nums">{s.fx ?? "—"}</td><td className="px-2 tabular-nums">{s.freight ?? "—"}</td><td className="px-2 text-right tabular-nums">{s.landed ?? "—"}</td><td className="px-2 text-right tabular-nums">{s.selling ?? "—"}</td>
                </tr>
              ))}</tbody></table></div>
            {l.skus.map((s) => s.provenance && <p key={s.sku} className="mt-1 text-xs text-slate-700">{s.sku}: {s.provenance}</p>)}
            {l.revenue != null && <p className="mt-1 text-[13px] text-slate-900">Line: {l.quantity ?? 0} × {l.unit != null ? money(l.unit) : "—"} = <strong>{money(l.revenue)}</strong> ex VAT</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Products with NO automatic price: the specific stored reason, the corrective action and the one button that opens it. "Price from Cin7" appears only where reading Cin7 again may help. */
export function PricingExceptions({ auto, canEdit, busy, onOpen, onPrice }: { auto: AutoView; canEdit: boolean; busy: boolean; onOpen: (taskId: string) => void; onPrice: () => void }) {
  if (auto.exceptions.length === 0) return null;
  return (
    <section aria-labelledby="ws-exceptions" className="overflow-hidden rounded-xl border border-amber-300 bg-white" data-testid="auto-exceptions">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5 sm:px-5">
        <h2 id="ws-exceptions" className="text-base font-bold">Pricing exceptions <span className="text-amber-900">· {auto.exceptions.length} product{auto.exceptions.length === 1 ? "" : "s"}</span></h2>
        {auto.canPrice && auto.retryable > 0 && <Button type="button" className="min-h-11" data-testid="price-from-cin7" loading={busy} disabled={busy || !canEdit} onClick={onPrice}>Price {auto.retryable} from Cin7</Button>}
      </div>
      <ul>
        {auto.exceptions.map((e) => (
          <li key={e.sku} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-100 px-4 py-2.5 last:border-0 sm:px-5" data-testid={`exception-${e.sku}`}>
            <div className="min-w-0 flex-[1_1_16rem]">
              <p><strong className="text-[15px]">{e.sku}</strong> <span className="text-sm text-slate-700">{e.usedBy.join(", ")}</span></p>
              <p className="mt-0.5 text-[13px] text-slate-900" data-testid={`exception-reason-${e.sku}`}>{e.reason}</p>
              <p className="text-[13px] text-slate-700" data-testid={`exception-action-${e.sku}`}>What to do: {e.action}</p>
            </div>
            <Button type="button" variant="secondary" className="min-h-11 w-full sm:w-[150px]" disabled={!canEdit} onClick={() => onOpen(e.taskId)} aria-label={`Open ${e.sku}`}>Open</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
