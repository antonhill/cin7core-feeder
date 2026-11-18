"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { adoptTemplateRevisionAction, previewTemplateAdoptionAction, type AdoptionPreview } from "../template-adoption-actions";

// An existing quotation keeps the template it was created under. This panel (Estimator only) shows what moving it to the current template would change and applies it only after the exact figures are
// acknowledged. Nothing is changed by opening or reviewing; the quotation page is reloaded after a successful adoption.
const money = (n: number | null) => (n === null ? "not priced" : `R ${n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/\s/g, ",")}`);

export function TemplateRevisionPanel({ quoteId, disabled, onAdopted }: { quoteId: string; disabled: boolean; onAdopted: () => void | Promise<void> }) {
  const [p, setP] = useState<AdoptionPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [ack, setAck] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);

  async function review() { setBusy(true); setErr(null); const r = await previewTemplateAdoptionAction(quoteId); setBusy(false); if (r.ok && r.data) { setP(r.data); setAck(false); } else setErr(r.error ?? "Could not read the impact."); }
  const impact = p?.impact;
  const after = impact ? (confirmNew ? impact.totals.afterConfirmed : impact.totals.afterUnconfirmed) : null;
  const afterLed = impact ? (confirmNew ? impact.led.afterConfirmed : impact.led.afterUnconfirmed) : null;
  async function adopt() {
    if (!p || !after) return;
    setBusy(true); setErr(null);
    const r = await adoptTemplateRevisionAction(quoteId, { reason, expectedDraftHash: p.draftHash, acknowledgeImpact: ack, acknowledgedTotalExVat: after.exVat, confirmNewLedPackage: confirmNew });
    setBusy(false);
    if (!r.ok || !r.data) { setErr(r.error ?? "Could not move the quotation."); return; }
    setDone(`Moved to the current template as revision ${r.data.revision}.${r.data.confirmationWithdrawn ? " The customer's confirmation was withdrawn: the Rep must reconfirm the amount." : ""}${r.data.signoffCleared ? " Your sign-off was withdrawn." : ""}`);
    setP(null);
    await onAdopted();
  }
  return (
    <section className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-4" data-testid="template-revision-panel" aria-labelledby="trp-title">
      <h3 id="trp-title" className="text-sm font-semibold text-slate-900">Template revision: original (grower-2026-10)</h3>
      <p className="mt-1 text-sm text-slate-800">This quotation keeps its original product scope, quantities and prices. A newer Grower template (corrected LED, support post, door and alternatives) exists. Nothing changes unless you choose to move this quotation, and moving it is a commercial change.</p>
      {done && <div className="mt-2"><Alert tone="info"><span data-testid="adoption-done">{done}</span></Alert></div>}
      {err && <div className="mt-2"><Alert tone="warning"><span data-testid="adoption-error">{err}</span></Alert></div>}
      {!p && <div className="mt-3"><Button type="button" variant="secondary" className="min-h-11" disabled={disabled || busy} loading={busy} onClick={review}>Review what would change</Button>{disabled && <span className="ml-2 text-sm text-amber-900">Save or discard your edits first.</span>}</div>}
      {p && impact && (
        <div className="mt-3 space-y-3 text-sm" data-testid="adoption-review">
          {!impact.eligible ? <Alert tone="warning">{impact.refusal}</Alert> : (<>
            <div>
              <h4 className="font-semibold">LED lighting: before</h4>
              <ul className="list-disc pl-5" data-testid="led-before">{(impact.led.before?.components ?? []).map((c) => <li key={c.description}>{c.sku ?? "no SKU"} · {c.description} · quantity {c.quantity ?? "not set"} ({c.status.replace(/_/g, " ")})</li>)}</ul>
              <p className="mt-1">Status: {impact.led.before?.status.replace(/_/g, " ") ?? "not on this quotation"}. Selling value: <strong>{money(impact.led.before?.sellingExVat ?? null)}</strong> ex VAT.</p>
            </div>
            <div>
              <h4 className="font-semibold">LED lighting: after</h4>
              <ul className="list-disc pl-5" data-testid="led-after">{(impact.led.afterConfirmed?.components ?? []).map((c) => <li key={c.description}>{c.sku ?? "no SKU"} · {c.description} · quantity {c.quantity ?? "not set"}</li>)}</ul>
              <p className="mt-1 text-slate-700">These per-light quantities (1 luminaire, 3 clips, 1 cable) are historical assumptions. Sean confirmed the SKUs, not the quantities.</p>
              <p className="mt-1">Selling value after: <strong data-testid="led-after-value">{money(afterLed?.sellingExVat ?? null)}</strong> ex VAT{!confirmNew && afterLed?.status !== "priced" && <span> (the new package is unconfirmed, so it is not priced until you confirm it)</span>}{afterLed?.status === "priced" && afterLed.components.every((c) => c.status !== "priced") && <span> (the typed price you entered for this line still applies)</span>}.</p>
            </div>
            <p data-testid="adoption-totals">Quotation total ex VAT{!after?.complete ? " (priced lines only)" : ""}: <strong>{money(impact.totals.before.exVat)}</strong> now, <strong>{money(after?.exVat ?? null)}</strong> after.</p>
            <ul className="list-disc pl-5 text-slate-800">{impact.otherDifferences.map((d) => <li key={d}>{d}</li>)}</ul>
            {impact.newSkus.length > 0 && <p className="text-amber-950">Supplier pricing is on: {impact.newSkus.join(", ")} will need supplier costs entered and independently verified.</p>}
            <p className="rounded bg-white p-2" data-testid="adoption-effects">Effects: {impact.effects.confirmationWithdrawn ? "the customer's confirmation is withdrawn and the quotation returns to the Rep as a new revision to reconfirm; " : "no customer confirmation is recorded yet; "}{impact.effects.signoffCleared ? "your sign-off is withdrawn; " : ""}the independent verification of existing costs is unchanged, and any cost for a new SKU starts unverified.</p>
            <label className="flex min-h-11 items-start gap-2"><input type="checkbox" className="mt-1 size-5" checked={confirmNew} onChange={(e) => { setConfirmNew(e.target.checked); setAck(false); }} /><span>I confirm the new LED package (quantities above) as part of this change. Leave it unticked to confirm it separately afterwards.</span></label>
            <Input label="Reason (recorded in the audit history)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <label className="flex min-h-11 items-start gap-2"><input type="checkbox" className="mt-1 size-5" checked={ack} onChange={(e) => setAck(e.target.checked)} /><span>I acknowledge this changes the quotation to {money(after?.exVat ?? null)} ex VAT and the effects above.</span></label>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" className="min-h-11" disabled={busy || !ack || reason.trim().length < 10} loading={busy} onClick={adopt}>Move this quotation to the current template</Button>
              <Button type="button" variant="ghost" className="min-h-11" disabled={busy} onClick={() => setP(null)}>Cancel</Button>
              <span role="status" className="text-sm text-amber-900">{!ack ? "Tick the acknowledgement." : reason.trim().length < 10 ? "Give a reason (at least 10 characters)." : ""}</span>
            </div>
          </>)}
        </div>
      )}
    </section>
  );
}
