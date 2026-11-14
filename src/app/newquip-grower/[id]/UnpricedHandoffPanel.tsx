"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { DisabledReason } from "@/components/ApprovalDisabledReason";

// Step 5 when NO indicative selling price exists yet (the Estimator establishes the first prices). The Rep's own work is complete and a chargeable product is included. Nothing is confirmed
// with the customer here and NO amount is recorded (R0.00 is never a confirmed price): the Rep explicitly acknowledges that, and after the Estimator prices the quotation the Rep must
// confirm the calculated amount with the customer before it can be signed off or approved. The server re-checks every condition (checkUnpricedHandoff).

export const UNPRICED_ACK_TEXT = "No customer price has been established yet. The Estimator will set the price and I will confirm the calculated amount with the customer before the quotation can proceed.";

export function UnpricedHandoffPanel({ canAct, ready, loading, otherBusy = false, onSubmit }: {
  canAct: boolean; ready: boolean; loading: boolean; otherBusy?: boolean; onSubmit: (acknowledged: boolean) => void;
}) {
  const [ack, setAck] = useState(false);
  const ackId = useId();
  const whyId = useId();
  const why = !canAct ? "Only the Rep can submit this quotation." : !ready ? "Finish the items still listed in Review (step 4) first." : !ack ? "Tick the acknowledgement above to enable Submit to Estimator." : null;
  return (
    <div className="rounded-md border border-slate-200 p-3 text-sm" data-testid="unpriced-handoff">
      <p className="font-medium text-slate-900">No customer price yet</p>
      <p className="mt-1 text-slate-700" data-testid="unpriced-explain">Nothing is priced for the customer yet, so there is no amount to confirm. The Estimator establishes the prices next; the quotation then returns to you to confirm the calculated amount with the customer. This is not an approval.</p>
      <label htmlFor={ackId} className="mt-3 flex min-h-11 cursor-pointer items-start gap-2 rounded-md border border-slate-300 p-2 text-slate-900" data-testid="unpriced-ack">
        <input id={ackId} type="checkbox" className="mt-0.5 size-6 shrink-0" checked={ack} disabled={!canAct || loading || !ready} onChange={(e) => setAck(e.target.checked)} />
        <span>{UNPRICED_ACK_TEXT}</span>
      </label>
      <div className="mt-3">
        <Button className="min-h-11" loading={loading} aria-describedby={why ? whyId : undefined} disabled={otherBusy || !canAct || !ready || !ack} onClick={() => onSubmit(ack)}>Submit to Estimator</Button>
      </div>
      <div className="mt-1"><DisabledReason id={whyId}>{why}</DisabledReason></div>
    </div>
  );
}
