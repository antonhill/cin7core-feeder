"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { getTourSteps } from "./tour-steps";

type StoredState = { step: number } | "done" | "skipped";

// Same-tab components (this panel, mounted in layout.tsx, and the "Take the
// guided tour" button in onboarding-checklist.tsx) don't share React state,
// and the native "storage" event only fires in OTHER tabs — so a plain
// localStorage write from the checklist wouldn't otherwise reach this
// already-mounted panel until some unrelated remount happened.
const TOUR_EVENT = "tour-state-change";

function storageKey(orgId: string) {
  return `tour-state:${orgId}`;
}

function readState(orgId: string): StoredState | "not-started" {
  const raw = localStorage.getItem(storageKey(orgId));
  if (!raw) return "not-started";
  try {
    return JSON.parse(raw) as StoredState;
  } catch {
    return "not-started";
  }
}

function writeState(orgId: string, state: StoredState) {
  localStorage.setItem(storageKey(orgId), JSON.stringify(state));
  window.dispatchEvent(new Event(TOUR_EVENT));
}

/**
 * Starts (or restarts) the guided tour — called from onboarding-checklist.tsx's
 * "Take the guided tour" button. Kept here so the tour's storage key/shape
 * stays private to this one file.
 */
export function startTour(orgId: string) {
  writeState(orgId, { step: 0 });
}

export default function TourGuide({ orgId, disabledModules }: { orgId: string; disabledModules: string[] }) {
  const [state, setState] = useState<StoredState | "not-started" | "loading">("loading");
  const [, startTransition] = useTransition();

  useEffect(() => {
    function load() {
      startTransition(() => {
        setState(readState(orgId));
      });
    }
    load();
    window.addEventListener(TOUR_EVENT, load);
    window.addEventListener("storage", load);
    return () => {
      window.removeEventListener(TOUR_EVENT, load);
      window.removeEventListener("storage", load);
    };
  }, [orgId]);

  if (state === "loading" || state === "not-started" || state === "done" || state === "skipped") return null;

  const steps = getTourSteps(disabledModules);

  function skip() {
    writeState(orgId, "skipped");
    setState("skipped");
  }

  // state.step ranges 0..steps.length: steps.length itself means every step
  // has been sent to, so this render is the completion screen rather than a
  // step — kept as its own value instead of a separate "done" so clicking
  // through the last step doesn't need an extra hidden re-render to get here.
  if (state.step >= steps.length) {
    return (
      <div className="fixed bottom-6 right-6 z-40 w-80 rounded-2xl border border-indigo-200 bg-white p-5 shadow-xl">
        <p className="text-base font-semibold text-slate-900">You&rsquo;re all set 🎉</p>
        <p className="mt-1 text-sm leading-relaxed text-slate-500">
          You&rsquo;ve seen everything Cin7 Core Toolbox offers. Come back to any module from the sidebar any time.
        </p>
        <button
          onClick={() => writeState(orgId, "done")}
          className="mt-4 w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500"
        >
          Done
        </button>
      </div>
    );
  }

  const current = steps[state.step];

  function advance() {
    writeState(orgId, { step: (state as { step: number }).step + 1 });
  }

  return (
    <div className="fixed bottom-6 right-6 z-40 w-80 rounded-2xl border border-indigo-200 bg-white p-5 shadow-xl">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-indigo-500">
          Step {state.step + 1} of {steps.length}
        </p>
        <button onClick={skip} className="shrink-0 text-xs font-medium text-slate-400 hover:text-slate-700">
          Skip tour
        </button>
      </div>
      <p className="mt-2 text-base font-semibold text-slate-900">{current.label}</p>
      <p className="mt-1 text-sm leading-relaxed text-slate-500">{current.blurb}</p>
      <Link
        href={current.href}
        onClick={advance}
        className="mt-4 block w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-center text-sm font-semibold text-white transition hover:bg-indigo-500"
      >
        Go to {current.label} →
      </Link>
    </div>
  );
}
