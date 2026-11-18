"use client";

// Presentation only (UX-006 PR f): imports no server action or store. Both pieces are derived from state ProjectWorkspace already holds.
import { claimSteps, type ClaimStep, type ClaimStepperInput } from "@/lib/projects/claim-stepper";
import { nothingClaimableReasons, type ClaimableStage } from "@/lib/projects/nothing-claimable";

const DOT: Record<ClaimStep["status"], string> = {
  done: "border-emerald-600 bg-emerald-600 text-white",
  next: "border-indigo-600 bg-white text-indigo-700",
  attention: "border-amber-600 bg-amber-50 text-amber-800",
  todo: "border-slate-300 bg-white text-slate-600",
};

/** Where the claim is in its four steps. Orientation only: the buttons below keep their own gates and reasons. */
export function ClaimStepper(props: ClaimStepperInput) {
  const steps = claimSteps(props);
  return (
    <ol aria-label="Claim steps" className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {steps.map((s, i) => (
        <li key={s.key} aria-current={s.status === "next" || s.status === "attention" ? "step" : undefined} data-step={s.key} data-status={s.status} className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5">
          <span aria-hidden="true" className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold ${DOT[s.status]}`}>{s.status === "done" ? "✓" : i + 1}</span>
          <span className="min-w-0 text-sm leading-tight"><span className="block font-medium text-slate-900">{s.label}</span><span className={`block text-xs ${s.status === "attention" ? "font-semibold text-amber-800" : "text-slate-600"}`}>{s.text}</span></span>
        </li>
      ))}
    </ol>
  );
}

/** Says WHY no stage can be claimed yet, and points to the tab that fixes it. Renders nothing when something is claimable. */
export function NothingClaimableHint({ stages, scheduleBalanced, uncertainClaimBlocking, isAdmin, bannersShown, onOpenTab }: { stages: readonly ClaimableStage[]; scheduleBalanced: boolean; uncertainClaimBlocking: boolean; isAdmin: boolean; bannersShown?: boolean; onOpenTab: (tab: "stages") => void }) {
  const reasons = nothingClaimableReasons({ stages, scheduleBalanced, uncertainClaimBlocking, isAdmin, bannersShown });
  if (!reasons) return null;
  return (
    <div role="note" data-testid="nothing-claimable" className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800">
      <p className="font-medium text-slate-900">Nothing can be claimed yet</p>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {reasons.map((r) => (
          <li key={r.text}>{r.text.split("Approve commercial progress").flatMap((part, k) => (k === 0 ? [part] : [<span key={k} className="font-medium">Approve commercial progress</span>, part]))}{r.tab && <> <button type="button" className="inline-flex min-h-11 items-center font-medium text-indigo-700 underline" onClick={() => onOpenTab(r.tab as "stages")}>Open the Stages tab</button></>}</li>
        ))}
      </ul>
    </div>
  );
}
