"use client";

import { createContext, useContext } from "react";
import { ActionFeedback, type FeedbackState, type Reconciled } from "@/components/ui/action-feedback";

/** The workspace run(): what the panels receive. `reconcile` re-reads the PANEL own state after a lost response; `exclusive`/`cin7` mark a financial / Cin7 action. */
export type RunFn = (
  fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>,
  done?: string,
  key?: string,
  opts?: { success?: (view: unknown, res: { data?: unknown }) => string; reconcile?: () => Promise<Reconciled>; doneAfterReconcile?: string; exclusive?: boolean; cin7?: boolean },
) => Promise<boolean>;

// Lets the Project panels render an action's feedback right beside its button without threading the keyed-action state through every prop.
const Ctx = createContext<(key: string) => FeedbackState>(() => ({ kind: "idle" }));
export const ProjectFeedbackProvider = Ctx.Provider;

/** The feedback region for action `k`; place it directly under the control that runs it. */
export function Feedback({ k, errorAction }: { k: string; errorAction?: React.ReactNode }) {
  const stateOf = useContext(Ctx);
  return <ActionFeedback state={stateOf(k)} errorAction={errorAction} />;
}
