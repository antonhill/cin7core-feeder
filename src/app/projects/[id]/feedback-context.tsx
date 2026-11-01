"use client";

import { createContext, useContext } from "react";
import { ActionFeedback, type FeedbackState } from "@/components/ui/action-feedback";

// Lets the Project panels render an action's feedback right beside its button without threading the keyed-action state through every prop.
const Ctx = createContext<(key: string) => FeedbackState>(() => ({ kind: "idle" }));
export const ProjectFeedbackProvider = Ctx.Provider;

/** The feedback region for action `k`; place it directly under the control that runs it. */
export function Feedback({ k, errorAction }: { k: string; errorAction?: React.ReactNode }) {
  const stateOf = useContext(Ctx);
  return <ActionFeedback state={stateOf(k)} errorAction={errorAction} />;
}
