"use client";
// BUDGET QUOTATION (customer UAT feedback): the Rep previews a provisional PDF of the SAVED draft and may send it to the customer BEFORE Estimator sign-off and Manager approval. It is not the final
// quotation: no Accept / Decline, no approval, no Project. The panel is explicit about unsaved changes, incomplete pricing and (in UAT) that only an authorised test mailbox can receive it.
import { useCallback, useEffect, useId, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Status } from "@/components/ui/Status";
import { getBudgetStatusAction, sendBudgetQuotationAction, type BudgetStatus } from "../budget-actions";
import { BUDGET_DISCLAIMER } from "@/lib/newquip-quotes/budget-document";

export function BudgetQuotationPanel({ quoteId, canAct, dirty, refreshKey }: { quoteId: string; canAct: boolean; dirty: boolean; refreshKey: string }) {
  const [st, setSt] = useState<BudgetStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [ack, setAck] = useState(false);
  const [msg, setMsg] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => `budget-${Math.random().toString(36).slice(2)}-${Date.now()}`);
  const ackId = useId();

  const load = useCallback(() => { void getBudgetStatusAction(quoteId).then((r) => { if (r.ok && r.data) { setSt(r.data); setErr(null); } else setErr(r.error ?? "The budget quotation is unavailable."); }); }, [quoteId]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const recipient = st?.testMode ? (st.testRecipient ?? "") : to.trim();
  const needsAck = (st?.unpricedCount ?? 0) > 0;
  const why = dirty ? "Save your changes first: the budget quotation is built from the saved draft." : !st?.canSend ? (st?.blockedReason ?? "Not available.") : !recipient ? "Enter the customer's email address." : needsAck && !ack ? "Tick the confirmation above to send an incomplete budget." : null;

  const send = async () => {
    if (!st) return; setBusy(true); setErr(null); setNote(null);
    const r = await sendBudgetQuotationAction(quoteId, { to: recipient, message: msg, idempotencyKey: key, expectedDraftHash: st.draftHash, acknowledgeIncomplete: ack });
    setBusy(false);
    if (r.ok) { setNote(`Budget quotation ${r.data?.reused ? "was already sent" : "sent"} to ${r.data?.to}. The quotation stays in its current stage: nothing was approved or issued.`); setOpen(false); setAck(false); setKey(`budget-${Math.random().toString(36).slice(2)}-${Date.now()}`); }
    else setErr(r.error ?? "The budget quotation could not be sent.");
  };

  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-2"><PanelTitle>Budget quotation</PanelTitle><Status tone="warning">Provisional</Status>{st?.testMode && <Status tone="danger">UAT - TEST ONLY</Status>}</div>
      <p className="mt-1 text-sm text-slate-800">An early, provisional PDF for the customer, built from the <strong>saved</strong> draft. It is not the final quotation and cannot be accepted. It does not approve, issue or create anything.</p>
      {dirty && <div className="mt-2" data-testid="budget-unsaved"><Alert tone="warning">You have unsaved changes. The budget quotation shows the last SAVED draft, not what is on screen. Save first.</Alert></div>}
      {st && !st.complete && <div className="mt-2" data-testid="budget-incomplete"><Alert tone="danger"><p className="font-semibold">INCOMPLETE ESTIMATE {"—"} {st.unpricedCount} item{st.unpricedCount === 1 ? "" : "s"} not priced.</p><p className="mt-1 text-sm">The budget quotation will show these as &quot;Price to be confirmed&quot; and will NOT present a total: {st.unpricedItems.join("; ")}.</p></Alert></div>}
      {err && <div className="mt-2"><Alert tone="danger">{err}</Alert></div>}
      {note && <div className="mt-2" data-testid="budget-sent"><Alert tone="success">{note}</Alert></div>}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <a className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white" data-testid="preview-budget-quotation" href={`/api/newquip-budget-preview/${quoteId}`} target="_blank" rel="noreferrer">Preview Budget Quotation</a>
        {canAct && <Button className="min-h-11" variant="secondary" data-testid="send-budget-quotation" disabled={busy || !st} onClick={() => setOpen((o) => !o)}>Send Budget Quotation</Button>}
      </div>
      {open && st && (
        <div className="mt-3 space-y-3 rounded-md border border-slate-300 p-3 text-sm" data-testid="budget-send-review">
          <p className="font-semibold text-amber-900">{BUDGET_DISCLAIMER}</p>
          <ul className="list-disc pl-5 text-slate-800">
            <li>Document: BUDGET QUOTATION built from saved draft <code>{st.draftRef}</code> (provisional pricing; no Accept / Decline).</li>
            <li>{st.complete ? "Pricing: every selected item is priced (still provisional)." : `Pricing: INCOMPLETE - ${st.unpricedCount} item(s) unpriced; no total is shown to the customer.`}</li>
            <li>Status after sending: unchanged. Estimator costing, Manager approval and the final quotation still follow.</li>
          </ul>
          {st.testMode ? (
            <p data-testid="budget-test-recipient">UAT: this is delivered only to the authorised test mailbox <strong>{st.testRecipient}</strong>, marked TEST ONLY. It is never sent to a real customer.</p>
          ) : (
            <label className="flex flex-col gap-1"><span className="font-medium">Customer email</span><input className="h-11 rounded-md border border-slate-300 px-2" type="email" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          )}
          <label className="flex flex-col gap-1"><span className="font-medium">Message (optional)</span><textarea className="rounded-md border border-slate-300 p-2" rows={2} maxLength={1500} value={msg} onChange={(e) => setMsg(e.target.value)} /></label>
          {needsAck && (
            <label htmlFor={ackId} className="flex min-h-11 cursor-pointer items-start gap-2 rounded-md border border-red-300 p-2" data-testid="budget-ack">
              <input id={ackId} type="checkbox" className="mt-0.5 size-6 shrink-0" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>I understand pricing is incomplete: the customer will see the scope with &quot;Price to be confirmed&quot; and NO total.</span>
            </label>
          )}
          <Button className="min-h-11" loading={busy} disabled={busy || !!why} onClick={() => void send()}>Send Budget Quotation now</Button>
          {why && <p className="text-xs text-slate-700" data-testid="budget-send-why">{why}</p>}
        </div>
      )}
    </Panel>
  );
}
