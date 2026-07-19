"use client";

import { useEffect, useState, useTransition } from "react";
import {
  startPushJobAction,
  continuePushJobAction,
  getActivePushJobAction,
  type PushJobStatus,
  type PushJobResult,
  type PushScopeSelection,
} from "@/app/import/actions";
import type { InstanceSyncOutcome } from "@/sync/sync-org";

export interface UsePushJobResult {
  outcomes: InstanceSyncOutcome[] | null;
  status: PushJobStatus | null;
  error: string | null;
  isPushing: boolean;
  start: (instanceIds: string[], scopeSelection?: PushScopeSelection) => void;
  /** Clears the locally-displayed result — e.g. Migrate clears a stale push outcome once a fresh pull starts. Doesn't touch the job row itself. */
  reset: () => void;
}

/**
 * Drives a push-to-Cin7 job to completion. Each continuePushJobAction call
 * IS the next chunk of work (it can legitimately take up to ~260s to
 * resolve, per PUSH_BUDGET_MS in actions.ts) — so this awaits each call and
 * immediately requests the next one when it resolves, rather than polling
 * on a fixed setInterval (which would fire overlapping calls on top of an
 * in-flight chunk). Shared by Import and Migrate, which both push to Cin7.
 */
export function usePushJob(): UsePushJobResult {
  const [outcomes, setOutcomes] = useState<InstanceSyncOutcome[] | null>(null);
  const [status, setStatus] = useState<PushJobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPushing, startTransition] = useTransition();

  async function drive(jobId: string, initial: Pick<PushJobResult, "status" | "outcomes">) {
    setOutcomes(initial.outcomes ?? null);
    let currentStatus = initial.status ?? null;
    setStatus(currentStatus);
    while (currentStatus === "running") {
      const result = await continuePushJobAction(jobId);
      if (!result.ok) {
        setError(result.error ?? "Unknown error");
        return;
      }
      setOutcomes(result.outcomes ?? null);
      currentStatus = result.status ?? null;
      setStatus(currentStatus);
    }
  }

  function start(instanceIds: string[], scopeSelection?: PushScopeSelection) {
    startTransition(async () => {
      setError(null);
      setOutcomes(null);
      setStatus("running");
      const result = await startPushJobAction(instanceIds, scopeSelection);
      if (!result.ok || !result.jobId) {
        setError(result.error ?? "Unknown error");
        setStatus(null);
        return;
      }
      await drive(result.jobId, result);
    });
  }

  // Resumes showing (and driving) an already-running job — e.g. the user
  // reloaded or reopened this page mid-push.
  useEffect(() => {
    startTransition(async () => {
      const active = await getActivePushJobAction();
      if (active?.jobId) await drive(active.jobId, active);
    });
  }, []);

  function reset() {
    setOutcomes(null);
    setStatus(null);
    setError(null);
  }

  return { outcomes, status, error, isPushing, start, reset };
}
