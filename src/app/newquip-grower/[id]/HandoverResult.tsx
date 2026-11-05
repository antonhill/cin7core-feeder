"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { demoSwitchAvailableAction, selectDemoIdentityAction } from "@/app/demo-mode/actions";
import type { AmountChange } from "@/newquip/quote/handover";

// What the Estimator sees after a save that changed a customer-facing amount: the quotation has gone back to the Rep. This is a RESULT screen for the Estimator (it never opens the Rep's
// editing screens). In Presenter Mode it offers one action that switches the role through the existing, server-authorised Demo Mode and reopens the quotation as the Rep.
export function HandoverResult({ quoteRef, revision, previousCents, newCents, changes, labelOf, fmtCents, fmtRand, onDismiss }: {
  quoteRef: string; revision: number; previousCents: number | null; newCents: number | null; changes: AmountChange[];
  labelOf: (key: string) => string; fmtCents: (c: number) => string; fmtRand: (r: number) => string; onDismiss: () => void;
}) {
  const [presenter, setPresenter] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { void demoSwitchAvailableAction().then(setPresenter).catch(() => setPresenter(false)); }, []);
  async function continueAsRep() {
    setBusy(true); setErr(null);
    const r = await selectDemoIdentityAction("rep");
    if (!r.ok) { setBusy(false); setErr(r.error ?? "Could not switch to the Rep."); return; }
    window.location.assign(window.location.pathname);
  }
  return (
    <div className="mx-auto max-w-3xl p-4" data-testid="handover-result">
      <p className="text-sm text-slate-700">{quoteRef} · revision {revision}</p>
      <h1 className="mt-1 text-xl font-semibold text-slate-900">Saved. The quotation has gone back to the Rep.</h1>
      <Alert tone="warning">
        <p className="font-medium" data-testid="handover-total">
          {previousCents != null && newCents != null
            ? <>You changed a customer-facing amount, so the total moved from {fmtCents(previousCents)} to {fmtCents(newCents)} ex VAT and the customer&apos;s confirmation was withdrawn.</>
            : <>You changed a customer-facing amount, so the customer&apos;s confirmation was withdrawn.</>}
        </p>
        <p className="mt-1">Next responsible role: <strong>Rep</strong>. The Rep reconfirms the new amount with the customer and submits again; you then resume costing and sign-off.</p>
      </Alert>
      {changes.length > 0 && (
        <div className="mt-4" data-testid="handover-changes">
          <h2 className="text-sm font-semibold text-slate-900">What changed the amount</h2>
          <ul className="mt-1 list-disc pl-5 text-sm text-slate-800">
            {changes.map((c) => (
              <li key={`${c.kind}-${c.key}`}>{labelOf(c.key)}: {c.kind === "charge" ? "charge" : "unit price"} {c.before == null ? "entered" : `${fmtRand(c.before)} →`} {fmtRand(c.after ?? 0)}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-700">Only selling prices and delivery / installation charges change the total. Supplier costs, cost estimates and mappings never do.</p>
        </div>
      )}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        {presenter && <Button className="min-h-11" onClick={continueAsRep} loading={busy} data-testid="continue-as-rep">Continue as Rep</Button>}
        <Button variant="secondary" className="min-h-11" onClick={onDismiss}>Back to the quotation (read only until the Rep resubmits)</Button>
      </div>
      {!presenter && <p className="mt-3 text-sm text-slate-700">The Rep will see this quotation in their queue with the reason for the return.</p>}
      {err && <div className="mt-3"><Alert tone="danger">{err}</Alert></div>}
    </div>
  );
}
