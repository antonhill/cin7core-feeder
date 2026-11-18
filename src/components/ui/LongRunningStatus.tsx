"use client";

import { Spinner } from "@/app/Spinner";
import { SLOW_AFTER_MS } from "./operation-labels";
import { useElapsedSeconds } from "./use-elapsed";

/**
 * UX-007: the persistent, NON-BLOCKING status for an operation that has been running past ~2 seconds. It names the operation, says it is still waiting and
 * how long (real elapsed time - never a percentage or invented milestone), and never claims success: it only disappears when the operation ends, and the
 * outcome is then reported by the action's own feedback region. Pinned to the viewport so it is still visible when the control that started the action has
 * scrolled away. `pointer-events-none` + `aria-hidden`: it never intercepts a click and never double-announces (the inline ActionFeedback is the live region).
 * Pass the label of the operation in flight (null when none).
 */
export function LongRunningStatus({ label }: { label: string | null }) {
  const secs = useElapsedSeconds(label !== null, label ?? "");
  if (label === null || secs * 1000 < SLOW_AFTER_MS) return null;
  return (
    <div aria-hidden="true" data-testid="long-running-status" className="pointer-events-none fixed bottom-4 left-4 z-50 flex max-w-[calc(100vw-2rem)] items-center gap-2.5 rounded-full bg-slate-900 px-4 py-2.5 text-sm font-medium text-white shadow-lg">
      <Spinner />
      <span>{label.replace(/…$/, "")} · still waiting ({secs}s)</span>
    </div>
  );
}
