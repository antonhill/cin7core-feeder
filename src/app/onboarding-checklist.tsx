"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { startTour } from "./tour-guide";

/**
 * Dismissible "getting started" nudge on the dashboard, not a blocking
 * modal or separate page — connecting the first instance requires leaving
 * to /settings/instances, so a card that just re-evaluates from real data
 * on every visit to "/" needs no "resume the wizard" logic. Dismissal is
 * the only client-only state here (does this visitor want to see it again),
 * so it lives in localStorage rather than a DB column.
 */
export default function OnboardingChecklist({ orgId, hasInstance }: { orgId: string; hasInstance: boolean }) {
  const storageKey = `onboarding-dismissed:${orgId}`;
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    startTransition(() => {
      setDismissed(localStorage.getItem(storageKey) === "1");
    });
  }, [storageKey]);

  function dismiss() {
    localStorage.setItem(storageKey, "1");
    setDismissed(true);
  }

  if (dismissed !== false) return null;

  if (!hasInstance) {
    return (
      <div className="mt-6 flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-base font-semibold text-amber-900">Get started</p>
          <p className="mt-1 text-sm text-amber-800">Then explore Data Audit, Reports, System Health, and more below.</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Link
            href="/settings/instances?openAdd=1"
            className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500"
          >
            Connect your first instance
          </Link>
          <button onClick={dismiss} aria-label="Dismiss" className="text-amber-600 hover:text-amber-900">
            ✕
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-6 flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
      <p>Nice — your first instance is connected. Explore the modules below.</p>
      <div className="ml-4 flex shrink-0 items-center gap-3">
        <button
          onClick={() => {
            startTour(orgId);
            dismiss();
          }}
          className="font-medium text-amber-900 underline hover:text-amber-950"
        >
          Take the guided tour
        </button>
        <button onClick={dismiss} className="font-medium text-amber-700 hover:text-amber-900">
          Got it
        </button>
      </div>
    </div>
  );
}
