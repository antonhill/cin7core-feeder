"use client";

import { useEffect, useState, useTransition } from "react";
import {
  startPullJobAction,
  continuePullJobAction,
  getActivePullJobAction,
  type PullJobStatus,
  type PullJobResult,
} from "@/app/migrate/actions";
import type { ImportKind, RunImportResult } from "@/import/run-import";

export interface UsePullJobResult {
  results: Partial<Record<ImportKind, RunImportResult>> | null;
  status: PullJobStatus | null;
  error: string | null;
  isPulling: boolean;
  start: (sourceInstanceId: string) => void;
  /** Clears the locally-displayed result. Doesn't touch the job row itself. */
  reset: () => void;
}

/**
 * Drives a Migrate pull job to completion. Each continuePullJobAction call
 * IS the next chunk of work (it can legitimately take up to ~260s to
 * resolve, per PULL_BUDGET_MS in actions.ts) — so this awaits each call and
 * immediately requests the next one when it resolves, rather than polling
 * on a fixed setInterval (which would fire overlapping calls on top of an
 * in-flight chunk). Mirrors usePushJob.ts.
 */
export function usePullJob(): UsePullJobResult {
  const [results, setResults] = useState<Partial<Record<ImportKind, RunImportResult>> | null>(null);
  const [status, setStatus] = useState<PullJobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPulling, startTransition] = useTransition();

  async function drive(jobId: string, initial: Pick<PullJobResult, "status" | "results" | "error">) {
    setResults(initial.results ?? null);
    let currentStatus = initial.status ?? null;
    setStatus(currentStatus);
    if (initial.status === "failed") setError(initial.error ?? "Unknown error");
    while (currentStatus === "running") {
      const result = await continuePullJobAction(jobId);
      if (!result.ok) {
        setError(result.error ?? "Unknown error");
        setResults(result.results ?? null);
        setStatus(result.status ?? null);
        return;
      }
      setResults(result.results ?? null);
      currentStatus = result.status ?? null;
      setStatus(currentStatus);
    }
  }

  function start(sourceInstanceId: string) {
    startTransition(async () => {
      setError(null);
      setResults(null);
      setStatus("running");
      const result = await startPullJobAction(sourceInstanceId);
      if (!result.jobId) {
        setError(result.error ?? "Unknown error");
        setStatus(result.status ?? null);
        setResults(result.results ?? null);
        return;
      }
      await drive(result.jobId, result);
    });
  }

  // Resumes showing (and driving) an already-running job — e.g. the user
  // reloaded or reopened this page mid-pull.
  useEffect(() => {
    startTransition(async () => {
      const active = await getActivePullJobAction();
      if (active?.jobId) await drive(active.jobId, active);
    });
  }, []);

  function reset() {
    setResults(null);
    setStatus(null);
    setError(null);
  }

  return { results, status, error, isPulling, start, reset };
}
