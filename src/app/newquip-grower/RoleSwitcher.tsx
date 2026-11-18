"use client";
import { useState, useTransition } from "react";
import { switchActiveRoleAction } from "@/app/approvals/role-actions";
import { SWITCH_LABEL, type SwitchRole } from "@/lib/approvals/active-role";

const HINT: Record<SwitchRole, string> = {
  REP: "Rep: indicative retail pricing. Supplier costs, margins and markups are hidden.",
  ESTIMATOR: "Estimator: supplier costs, rates and pricing controls. Cannot approve.",
  MANAGER: "Manager: verifies costs and approves. Cannot verify costs you entered yourself.",
};

/** A prominent three-way switch between the person's OWN roles. The server decides what each role may do; this only asks it to change the active one. */
export function RoleSwitcher({ held, active }: { held: readonly SwitchRole[]; active: SwitchRole }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<SwitchRole | null>(null);
  const choose = (r: SwitchRole) => {
    if (r === active || pending) return;
    setError(null); setWaiting(r);
    start(async () => {
      const res = await switchActiveRoleAction(r);
      if (!res.ok) setError(res.error ?? "Could not switch role.");
      else window.location.reload(); // a full reload: no client state from the previous role may survive
      setWaiting(null);
    });
  };
  return (
    <div data-testid="role-switcher" className="border-b-2 border-indigo-600 bg-indigo-50 px-4 py-2 dark:bg-indigo-950">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-sm font-semibold text-indigo-900 dark:text-indigo-100">Acting as <span data-testid="active-role" className="rounded bg-indigo-600 px-2 py-0.5 text-white">{SWITCH_LABEL[active]}</span></span>
        <div role="radiogroup" aria-label="Acting role" className="inline-flex overflow-hidden rounded-md border border-indigo-600">
          {held.map((r) => (
            <button key={r} type="button" role="radio" aria-checked={r === active} data-testid={`role-${r}`} disabled={pending}
              onClick={() => choose(r)}
              className={`min-h-11 px-4 text-sm font-medium ${r === active ? "bg-indigo-600 text-white" : "bg-white text-indigo-800 hover:bg-indigo-100 dark:bg-transparent dark:text-indigo-100"}`}>
              {waiting === r ? `Switching to ${SWITCH_LABEL[r]}…` : SWITCH_LABEL[r]}
            </button>
          ))}
        </div>
        <span className="text-xs text-indigo-900 dark:text-indigo-100" data-testid="role-hint">{HINT[active]}</span>
        {error ? <span role="alert" className="text-xs font-medium text-red-700">{error}</span> : null}
      </div>
    </div>
  );
}
