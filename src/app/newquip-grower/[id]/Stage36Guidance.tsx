"use client";

import { Alert } from "@/components/ui/Alert";
import { Status } from "@/components/ui/Status";
import type { ApprovalCheckItem } from "@/newquip/quote/stage3-approval";
import type { AcceptanceBanner } from "@/newquip/quote/stage5-banner";
import type { HandoverItem } from "@/newquip/quote/stage6-handover";

// UX-006c presentation for Stages 3, 5 and 6: read-only guidance derived by pure functions from state the page already holds. Nothing here is a control that changes data,
// imports a server action or a store, or gates an existing button.

const MARK = (met: boolean) => <span aria-hidden className={`inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-bold ${met ? "border-emerald-700 bg-emerald-700 text-white" : "border-amber-600 bg-amber-50 text-amber-900"}`}>{met ? "✓" : "!"}</span>;

function Checklist({ testId, label, intro, items }: { testId: string; label: string; intro: string; items: Array<{ id: string; label: string; met: boolean; detail: string | null; fix?: React.ReactNode }> }) {
  return (
    <section aria-label={label} data-testid={testId} className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <h3 className="text-sm font-semibold text-slate-900">{label}</h3>
      <p className="mt-0.5 text-xs text-slate-700">{intro}</p>
      <ul className="mt-2 space-y-2">
        {items.map((x) => (
          <li key={x.id} data-check={x.id} className="flex items-start gap-2 text-sm">
            {MARK(x.met)}
            <span className="min-w-0">
              <span className="font-medium text-slate-900">{x.label}</span>{" "}
              <span className={`text-xs font-semibold ${x.met ? "text-emerald-800" : "text-amber-900"}`} data-testid={`check-status-${x.id}`}>{x.met ? "Met" : "Not met"}</span>
              {x.detail && <span className="block text-xs text-slate-700">{x.detail}{x.fix}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ApprovalChecklist({ items, onGoStage }: { items: ApprovalCheckItem[]; onGoStage: (n: 1 | 2) => void }) {
  return <Checklist testId="approval-checklist" label="Before you decide" intro="What final approval needs. These are the same checks the server makes; the buttons below keep their own gates."
    items={items.map((x) => ({ ...x, fix: x.fixStage && !x.met ? <> <button type="button" className="-my-3 inline-flex min-h-11 items-center underline" onClick={() => onGoStage(x.fixStage!)}>{x.fixStage === 1 ? "Open Stage 1" : "Open Stage 2"}</button></> : null }))} />;
}

export function HandoverChecklist({ items, onGoStage }: { items: HandoverItem[]; onGoStage: (n: 3 | 5) => void }) {
  return <Checklist testId="handover-checklist" label="Before the Project is created" intro="What creating the Project needs. The button below keeps its own gates and reasons."
    items={items.map((x) => ({ ...x, fix: x.fixStage && !x.met ? <> <button type="button" className="-my-3 inline-flex min-h-11 items-center underline" onClick={() => onGoStage(x.fixStage!)}>{x.fixStage === 5 ? "Open Customer Acceptance (Stage 5)" : "Open Manager Approval (Stage 3)"}</button></> : null }))} />;
}

export function AcceptanceStatusBanner({ banner }: { banner: AcceptanceBanner }) {
  return (
    <div data-testid="acceptance-banner">
      <Alert tone={banner.tone}>
        <p className="flex flex-wrap items-center gap-2 font-semibold"><Status tone={banner.tone}>{banner.headline}</Status></p>
        <p className="mt-1">{banner.body}</p>
        {banner.next && <p className="mt-1 font-semibold" data-testid="acceptance-next">Next: {banner.next}</p>}
      </Alert>
    </div>
  );
}
