"use client";
// BUDGET QUOTATION (customer UAT feedback): the Rep previews a provisional PDF of the SAVED draft and may send it to the customer BEFORE Estimator sign-off and Manager approval. It is not the final
// quotation: no Accept / Decline, no approval, no Project. The panel is explicit about unsaved changes, incomplete pricing and (in UAT) that only an authorised test mailbox can receive it.
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Status } from "@/components/ui/Status";
import { completeBudgetPricingAction, getBudgetStatusAction, sendBudgetQuotationAction, type BudgetStatus } from "../budget-actions";
import { BUDGET_DISCLAIMER } from "@/lib/newquip-quotes/budget-document";

export function BudgetQuotationPanel({ quoteId, canAct, dirty, refreshKey, embedded = false, onPriced }: { quoteId: string; canAct: boolean; dirty: boolean; refreshKey: string; /** Called after the Rep's supplier prices were completed, so the page re-reads the (now fuller) Budget. */ onPriced?: () => void; /** Inside the consolidated final step: the pricing summary above already states the incomplete / provisional position, so it is not repeated here. */ embedded?: boolean }) {
  const [st, setSt] = useState<BudgetStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => `budget-${Math.random().toString(36).slice(2)}-${Date.now()}`);

  const load = useCallback(() => { void getBudgetStatusAction(quoteId).then((r) => { if (r.ok && r.data) { setSt(r.data); setErr(null); } else setErr(r.error ?? "The budget quotation is unavailable."); }); }, [quoteId]);
  useEffect(() => { load(); }, [load, refreshKey]);

  // A Rep's Budget must be COMPLETE without an Estimator: when the saved draft still has unpriced lines, the supplier prices still to be read from Cin7 are read now (one paced batch at a time) until nothing is left to read.
  // The Preview waits for it, so the Rep never opens a Budget that says "not yet priced" for a price that is obtainable.
  const [pricing, setPricing] = useState(false);
  const rounds = useRef(0), total = useRef(0);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const [cannotRetrieve, setCannotRetrieve] = useState(false); // a status a retry cannot change (settings, not a Rep draft...): said differently, no pointless retries
  const [unfinished, setUnfinished] = useState(false); // retrieval stopped before every supplier product was read: said plainly, with a retry; NEVER shown as a complete Budget
  const [tick, setTick] = useState(0);
  useEffect(() => { rounds.current = 0; }, [refreshKey]);
  useEffect(() => {
    // rounds resets when the draft changes (a round that added prices); total is the absolute ceiling for this screen, so it can never loop.
    if (!st || !canAct || dirty || pricing || st.unpricedCount === 0 || rounds.current >= 6 || total.current >= 10) return;
    rounds.current += 1; total.current += 1; setPricing(true);
    const capped = () => rounds.current >= 6 || total.current >= 10;
    void completeBudgetPricingAction(quoteId).then((r) => {
      if (!mounted.current) return;
      setPricing(false);
      const RETRYABLE = new Set(["applied", "no_prices", "skipped", "error"]);
      if (r.ok && r.data?.done) { rounds.current = 6; setUnfinished(false); setCannotRetrieve(false); }
      else if (r.ok && r.data && !RETRYABLE.has(r.data.status)) { rounds.current = 6; setCannotRetrieve(true); } // not_applicable / settings_*: retrying cannot help, so do not pretend it might
      else if (!r.ok || capped()) { rounds.current = 6; setUnfinished(true); }
      load(); onPriced?.();
    }, () => { if (!mounted.current) return; setPricing(false); rounds.current = 6; setUnfinished(true); });
  }, [st, canAct, dirty, pricing, quoteId, load, onPriced, tick]);
  const retry = () => { rounds.current = 0; total.current = 0; setUnfinished(false); setCannotRetrieve(false); setTick((t) => t + 1); };

  const recipient = st?.testMode ? (st.testRecipient ?? "") : to.trim();
  const incomplete = (st?.unpricedCount ?? 0) > 0; // an incomplete Budget can be neither previewed nor sent
  const why = dirty ? "Save your changes first: the budget quotation is built from the saved draft." : !st?.canSend ? (st?.blockedReason ?? "Not available.") : incomplete ? "Every selected item must be priced before a Budget Quotation can be sent." : !recipient ? "Enter the customer's email address." : null;

  const send = async () => {
    if (!st) return; setBusy(true); setErr(null); setNote(null);
    const r = await sendBudgetQuotationAction(quoteId, { to: recipient, message: msg, idempotencyKey: key, expectedDraftHash: st.draftHash, acknowledgeIncomplete: false });
    setBusy(false);
    if (r.ok) { setNote(`Budget quotation ${r.data?.reused ? "was already sent" : "sent"} to ${r.data?.to}. The quotation stays in its current stage: nothing was approved or issued.`); setOpen(false); setKey(`budget-${Math.random().toString(36).slice(2)}-${Date.now()}`); }
    else { setErr(r.error ?? "The budget quotation could not be sent."); setKey(`budget-${Math.random().toString(36).slice(2)}-${Date.now()}`); }
  };

  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-2"><PanelTitle>Budget quotation</PanelTitle><Status tone="warning">Provisional</Status>{st?.testMode && <Status tone="danger">UAT - TEST ONLY</Status>}</div>
      <p className="mt-1 text-sm text-slate-800">An early, provisional PDF for the customer, built from the <strong>saved</strong> draft. It is not the final quotation and cannot be accepted. It does not approve, issue or create anything.</p>
      {dirty && <div className="mt-2" data-testid="budget-unsaved"><Alert tone="warning">You have unsaved changes. The budget quotation shows the last SAVED draft, not what is on screen. Save first.</Alert></div>}
      {st && !st.complete && !embedded && <div className="mt-2" data-testid="budget-incomplete"><Alert tone="warning"><p className="font-semibold">{st.unpricedCount} item{st.unpricedCount === 1 ? "" : "s"} not priced.</p><p className="mt-1 text-sm">A Budget Quotation cannot be previewed or sent until every item is priced: {st.unpricedItems.join("; ")}. Complete the missing selections on the Equipment step (for example the PVC door size) or try again once supplier pricing has finished.</p></Alert></div>}
      {st && st.provisionalCount > 0 && !embedded && <div className="mt-2" data-testid="budget-provisional"><Alert tone="warning">{st.provisionalCount} item{st.provisionalCount === 1 ? " is" : "s are"} priced provisionally and marked as most likely to change.</Alert></div>}
      {unfinished && !pricing && (st?.unpricedCount ?? 0) > 0 && <div className="mt-2" data-testid="budget-retrieval-unfinished"><Alert tone="warning"><p className="font-semibold">Supplier price retrieval is not finished.</p><p className="mt-1 text-sm">Some supplier prices could not be read from Cin7 yet, so this Budget is NOT complete. Nothing has been guessed. Try again in a moment.</p><Button className="mt-2 min-h-11" variant="secondary" onClick={retry} data-testid="budget-retry-pricing">Try again</Button></Alert></div>}
      {cannotRetrieve && !pricing && (st?.unpricedCount ?? 0) > 0 && <div className="mt-2" data-testid="budget-retrieval-not-applicable"><Alert tone="info">Supplier prices cannot be completed automatically for this quotation (for example the commercial settings are incomplete, or an Estimator has already taken over its pricing). The items listed below stay unpriced until the Estimator prices them.</Alert></div>}
      {pricing && <div className="mt-2" data-testid="budget-pricing-progress"><Alert tone="info"><span role="status">Reading the supplier prices for your equipment from Cin7. This takes up to a minute; the Budget completes by itself.</span></Alert></div>}
      {err && <div className="mt-2"><Alert tone="danger">{err}</Alert></div>}
      {note && <div className="mt-2" data-testid="budget-sent"><Alert tone="success">{note}</Alert></div>}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {pricing ? <span className="inline-flex min-h-11 items-center rounded-md bg-slate-400 px-4 text-sm font-semibold text-white" data-testid="preview-budget-quotation-wait" aria-disabled="true">Preview Budget Quotation (pricing in progress)</span> : !st || incomplete ? <span className="inline-flex min-h-11 items-center rounded-md bg-slate-400 px-4 text-sm font-semibold text-white" data-testid="preview-budget-quotation-blocked" aria-disabled="true">{st ? "Preview Budget Quotation (not available: pricing incomplete)" : "Preview Budget Quotation (checking pricing…)"}</span> : <a className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white" data-testid="preview-budget-quotation" href={`/api/newquip-budget-preview/${quoteId}`} target="_blank" rel="noreferrer">Preview Budget Quotation</a>}
        {canAct && <Button className="min-h-11" variant="secondary" data-testid="send-budget-quotation" disabled={busy || !st} onClick={() => setOpen((o) => !o)}>Send Budget Quotation</Button>}
      </div>
      {open && st && (
        <div className="mt-3 space-y-3 rounded-md border border-slate-300 p-3 text-sm" data-testid="budget-send-review">
          <p className="font-semibold text-amber-900">{BUDGET_DISCLAIMER}</p>
          <ul className="list-disc pl-5 text-slate-800">
            <li>Document: BUDGET QUOTATION built from saved draft <code>{st.draftRef}</code> (provisional pricing; no Accept / Decline).</li>
            <li>{st.complete ? `Pricing: every selected item has a price${st.provisionalCount > 0 ? ` (${st.provisionalCount} provisional)` : ""}; the customer sees ${st.provisionalCount > 0 ? "a provisional estimate" : "a budget total"}.` : `Pricing: ${st.unpricedCount} item(s) unpriced; no total is shown to the customer.`}</li>
            <li>Status after sending: unchanged. Estimator costing, Manager approval and the final quotation still follow.</li>
          </ul>
          {st.testMode ? (
            <p data-testid="budget-test-recipient">UAT: this is delivered only to the authorised test mailbox <strong>{st.testRecipient}</strong>, marked TEST ONLY. It is never sent to a real customer.</p>
          ) : (
            <label className="flex flex-col gap-1"><span className="font-medium">Customer email</span><input className="h-11 rounded-md border border-slate-300 px-2" type="email" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          )}
          <label className="flex flex-col gap-1"><span className="font-medium">Message (optional)</span><textarea className="rounded-md border border-slate-300 p-2" rows={2} maxLength={1500} value={msg} onChange={(e) => setMsg(e.target.value)} /></label>
          <Button className="min-h-11" loading={busy} disabled={busy || !!why} onClick={() => void send()}>Send Budget Quotation now</Button>
          {why && <p className="text-xs text-slate-700" data-testid="budget-send-why">{why}</p>}
        </div>
      )}
    </Panel>
  );
}
