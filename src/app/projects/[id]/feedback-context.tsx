"use client";

import { createContext, useContext } from "react";
import { ActionFeedback, type FeedbackState, type Reconciled } from "@/components/ui/action-feedback";

/** The workspace run(): what the panels receive. `reconcile` re-reads the PANEL own state after a lost response; `exclusive`/`cin7` mark a financial / Cin7 action. */
export type RunFn = (
  fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>,
  done?: string,
  key?: string,
  opts?: { pending?: string; success?: (view: unknown, res: { data?: unknown }) => string; reconcile?: () => Promise<Reconciled>; doneAfterReconcile?: string; exclusive?: boolean; cin7?: boolean },
) => Promise<boolean>;

// Lets the Project panels render an action's feedback right beside its button without threading the keyed-action state through every prop.
const Ctx = createContext<(key: string) => FeedbackState>(() => ({ kind: "idle" }));
export const ProjectFeedbackProvider = Ctx.Provider;

/** The feedback region for action `k`; place it directly under the control that runs it. */
export function Feedback({ k, errorAction }: { k: string; errorAction?: React.ReactNode }) {
  const stateOf = useContext(Ctx);
  return <ActionFeedback state={stateOf(k)} errorAction={errorAction} />;
}

/** UX-007: is action `k` itself in flight? Lets a button show its OWN spinner (not every button on the page when any action runs). */
export function useIsPending(k: string): boolean {
  return useContext(Ctx)(k).kind === "pending";
}

/** The same, as a function - for panels that render one button per row (call the hook once at the top, then ask per key). */
export function useIsPendingFn(): (k: string) => boolean {
  const stateOf = useContext(Ctx);
  return (k) => stateOf(k).kind === "pending";
}
