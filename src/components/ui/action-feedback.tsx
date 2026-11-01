"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TONE_CLASSES } from "./Alert";
import { Spinner } from "@/app/Spinner";

// UAT-025: ONE lightweight pattern for "I clicked a button, what happened?" - so the answer appears NEXT TO the control, never in a banner at the top
// of a long page. No dependency, no global store. Three parts:
//   - useKeyedActions(): runs an action under a key. A ref-based in-flight guard makes a second click on the same key a no-op (state-based
//     `disabled` alone lets a fast double-click through before React re-renders). Pending / success / error are kept per key.
//   - A thrown error or lost response is AMBIGUOUS (the server may have recorded the decision): the optional `reconcile` re-reads authoritative state
//     first, and only then is a retry suggested - or the action reported as already done.
//   - <ActionFeedback/>: the visible, accessible region. Pending and success are polite live regions; a failure is an alert that takes focus.

export type FeedbackState =
  | { kind: "idle" }
  | { kind: "pending"; label: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string; ambiguous?: boolean };

export type ActionOutcome = { ok: boolean; error?: string; data?: unknown };
/** What a re-read of the authoritative state says about an action whose outcome was lost. */
export type Reconciled = "done" | "not_done" | "unknown";

export interface RunOptions<R extends ActionOutcome> {
  /** Shown while the request is in flight. */
  pending?: string;
  /** Message on success; may read the result (e.g. to name the resulting status). */
  success?: string | ((result: R) => string);
  /** Re-read the authoritative state after a thrown/lost response. */
  reconcile?: () => Promise<Reconciled>;
  /** Message when reconcile finds the action did in fact complete. */
  doneAfterReconcile?: string;
}

export const AMBIGUOUS_UNKNOWN = "We could not confirm whether this was saved. The page has been refreshed: check the current status before trying again.";
export const AMBIGUOUS_NOT_DONE = "The request did not complete and nothing was changed. You can try again.";

export function useKeyedActions() {
  const inFlight = useRef<Set<string>>(new Set());
  const [states, setStates] = useState<Record<string, FeedbackState>>({});
  const [pendingCount, setPendingCount] = useState(0);
  const set = useCallback((key: string, s: FeedbackState) => setStates((m) => ({ ...m, [key]: s })), []);

  /** Resolves true only when the action succeeded (or reconciled as already done). A duplicate click while in flight resolves false without calling `fn`. */
  const run = useCallback(async <R extends ActionOutcome>(key: string, fn: () => Promise<R>, opts: RunOptions<R> = {}): Promise<boolean> => {
    if (inFlight.current.has(key)) return false;
    inFlight.current.add(key);
    setPendingCount((n) => n + 1);
    set(key, { kind: "pending", label: opts.pending ?? "Working…" });
    try {
      const res = await fn();
      if (res.ok) {
        set(key, { kind: "success", message: typeof opts.success === "function" ? opts.success(res) : opts.success ?? "Done." });
        return true;
      }
      set(key, { kind: "error", message: res.error ?? "The action failed. Nothing was changed." });
      return false;
    } catch {
      let verdict: Reconciled = "unknown";
      try { verdict = opts.reconcile ? await opts.reconcile() : "unknown"; } catch { verdict = "unknown"; }
      if (verdict === "done") { set(key, { kind: "success", message: opts.doneAfterReconcile ?? "Done. The request's response was lost, but the current status shows it was recorded." }); return true; }
      set(key, { kind: "error", ambiguous: true, message: verdict === "not_done" ? AMBIGUOUS_NOT_DONE : AMBIGUOUS_UNKNOWN });
      return false;
    } finally {
      inFlight.current.delete(key);
      setPendingCount((n) => n - 1);
    }
  }, [set]);

  const stateOf = useCallback((key: string): FeedbackState => states[key] ?? { kind: "idle" }, [states]);
  const clear = useCallback((key: string) => set(key, { kind: "idle" }), [set]);
  return { run, stateOf, clear, anyPending: pendingCount > 0, isPending: (key: string) => states[key]?.kind === "pending" };
}

/** The visible feedback region. Render it directly beside the control that triggered the action. */
/** `floating` pins the region inside the viewport (bottom-right): the backstop for an action whose buttons are not wired to an inline slot. */
export function ActionFeedback({ state, errorAction, className = "", floating = false }: { state: FeedbackState; errorAction?: React.ReactNode; className?: string; floating?: boolean }) {
  className = `${className} ${floating ? "fixed bottom-4 right-4 z-50 max-w-md shadow-lg" : ""}`.trim();
  const errRef = useRef<HTMLDivElement>(null);
  const okRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.kind === "error") { errRef.current?.focus({ preventScroll: true }); errRef.current?.scrollIntoView?.({ block: "nearest" }); }
    else if (state.kind === "success") okRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [state]);

  if (state.kind === "error") {
    return (
      <div ref={errRef} role="alert" tabIndex={-1} data-testid="action-feedback" data-kind="error" className={`mt-2 rounded-lg border px-3 py-2 text-sm ${TONE_CLASSES.danger} ${className}`}>
        <p>{state.message}</p>
        {errorAction && <p className="mt-1">{errorAction}</p>}
      </div>
    );
  }
  if (state.kind === "pending") {
    return (
      <div role="status" aria-live="polite" data-testid="action-feedback" data-kind="pending" className={`mt-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${TONE_CLASSES.info} ${className}`}>
        <Spinner /> <span>{state.label}</span>
      </div>
    );
  }
  if (state.kind === "success") {
    return (
      <div ref={okRef} role="status" aria-live="polite" data-testid="action-feedback" data-kind="success" className={`mt-2 rounded-lg border px-3 py-2 text-sm ${TONE_CLASSES.success} ${className}`}>{state.message}</div>
    );
  }
  // Idle: keep an empty polite live region mounted so the first message is announced.
  return <div role="status" aria-live="polite" data-testid="action-feedback" data-kind="idle" className="sr-only" />;
}
