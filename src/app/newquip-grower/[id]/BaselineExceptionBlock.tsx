"use client";

import { useId, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { BASELINE_EXCEPTION_MIN_REASON, BASELINE_EXCEPTION_TITLE, type BaselineException, type BaselineExceptionRequest, type BaselineExceptionView } from "@/newquip/quote/baseline-exception";
import { formatSast } from "@/lib/approvals/time";

// UX-006 S3: the baseline-exception surfaces. Presentation only: the server decides everything (Manager role, version binding, which items are covered).
//   BaselineExceptionBlock  Stage 3, Manager: the "Approval exception required" block with its single primary action.
//   BaselineExceptionNote   Stage 2, Estimator: a read-only heads-up that the Manager will be asked.
//   BaselineExceptionsSummary  Stage 6 / frozen baseline: the recorded exception(s), never hidden.

function ItemList({ items }: { items: BaselineExceptionView["items"] }) {
  return (
    <ul className="list-disc space-y-0.5 pl-5">
      {items.map((i) => <li key={i.itemKey}><span className="font-medium">{i.label}</span> <span className="text-xs">({i.itemKey}) &mdash; no Cin7 SKU; {i.pricing}</span></li>)}
    </ul>
  );
}

type BlockProps = {
  view: BaselineExceptionView;
  /** The saved quotation version being approved: the exception is bound to it and refused if it has changed. */
  revision: number;
  draftHash: string;
  /** The viewer is a Manager, the Estimator signed off this content and there are no unsaved edits. */
  canDecide: boolean;
  /** Why the action is unavailable (shown beside it), when it is. */
  blockedWhy?: string;
  pending: boolean;
  onApprove: (request: BaselineExceptionRequest) => void;
};

/** Keyed by the quotation version: a reason typed or a box ticked for one version can never be submitted against another (state is reset when the version changes). */
export function BaselineExceptionBlock(props: BlockProps) {
  return <BlockInner key={`${props.draftHash}:${props.revision}`} {...props} />;
}

function BlockInner({ view, revision, draftHash, canDecide, blockedWhy, pending, onApprove }: BlockProps) {
  const uid = useId();
  const [reason, setReason] = useState("");
  const [accepted, setAccepted] = useState(false);
  if (!view.baselineExceptionRequired) return null;
  const reasonShort = reason.trim().length < BASELINE_EXCEPTION_MIN_REASON;
  const why = blockedWhy ?? (reasonShort ? `Write the reason (at least ${BASELINE_EXCEPTION_MIN_REASON} characters) to enable this.` : !accepted ? "Tick the box to confirm you accept the exception." : undefined);
  return (
    <section aria-labelledby={`${uid}-h`} className="rounded-lg border border-warning-border bg-warning-subtle p-4 text-amber-900">
      <h3 id={`${uid}-h`} className="text-sm font-semibold">Approval exception required</h3>
      <p className="mt-1 text-sm">These Estimator-priced systems have no Cin7 SKU mapping, so the baseline cannot be frozen as complete. You can approve with a recorded exception that covers only these items:</p>
      <div className="mt-2 text-sm"><ItemList items={view.items} /></div>
      {view.costException && <p className="mt-2 text-xs">The Estimator also recorded a cost exception ({view.costException.by}, {formatSast(view.costException.at)}): &ldquo;{view.costException.reason}&rdquo;. It covers supplier costs only; it does not cover these unmapped systems.</p>}
      <p className="mt-2 text-xs">Nothing else is waived: costing, the confirmed amount and the Estimator&apos;s sign-off are still required. The exception is recorded with your name, the time and this quotation version (revision {revision}); any later change to the quotation voids it.</p>
      <label htmlFor={`${uid}-reason`} className="mt-3 block text-sm font-medium">Reason for the exception</label>
      <p className="text-xs">Visible to the Rep in the frozen baseline: do not include costs or margins.</p>
      <textarea id={`${uid}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={1000} aria-describedby={why ? `${uid}-why` : undefined}
        className="mt-1 w-full max-w-xl rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900" />
      <div className="mt-2"><Checkbox label="I accept this exception for the items listed above" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} /></div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="primary" loading={pending} disabled={!canDecide || !!why} aria-describedby={why ? `${uid}-why` : undefined}
          onClick={() => onApprove({ reason: reason.trim(), expectedRevision: revision, expectedDraftHash: draftHash })}>Approve with recorded exception</Button>
        {why && <p id={`${uid}-why`} className="text-xs">{why}</p>}
      </div>
    </section>
  );
}

/** Stage 2 Final review (Estimator): read-only. */
export function BaselineExceptionNote({ view }: { view: BaselineExceptionView | undefined }) {
  if (!view || !view.baselineExceptionRequired) return null;
  return (
    <Alert tone="info">
      <p className="font-medium">The Manager will be asked to accept an exception</p>
      <p className="mt-1 text-xs">These Estimator-priced systems have no Cin7 SKU mapping. You do not need to map them; the Manager records an exception when approving. Map them in the library instead if you want the approval to be complete.</p>
      <div className="mt-1 text-xs"><ItemList items={view.items} /></div>
    </Alert>
  );
}

/** The frozen baseline: every recorded exception, with who, when, which version and why. */
export function BaselineExceptionsSummary({ exceptions }: { exceptions: readonly BaselineException[] | undefined }) {
  if (!exceptions || exceptions.length === 0) return null;
  return (
    <div className="mt-3 rounded-lg border border-warning-border bg-warning-subtle p-3 text-sm text-amber-900" role="group" aria-label="Recorded baseline exceptions">
      <p className="font-semibold">{BASELINE_EXCEPTION_TITLE}</p>
      {exceptions.map((e, n) => (
        <div key={n} className="mt-2">
          <ItemList items={e.unresolved} />
          <p className="mt-1 text-xs">Reason: {e.reason}</p>
          <p className="text-xs">Accepted by {e.approvedBy} on {formatSast(e.approvedAt)} &middot; {e.version.quoteRef} revision {e.version.revision} &middot; content {e.version.draftHash.slice(0, 12)}</p>
        </div>
      ))}
    </div>
  );
}
