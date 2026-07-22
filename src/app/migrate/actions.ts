"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import { pullInstanceGroup, PULL_GROUP_ORDER, type PullGroup } from "@/migrate/pull-instance";
import type { ImportKind, RunImportResult } from "@/import/run-import";

export type PullJobStatus = "running" | "done" | "failed";

export interface PullJobResult {
  ok: boolean;
  error?: string;
  jobId?: string;
  status?: PullJobStatus;
  results?: Partial<Record<ImportKind, RunImportResult>>;
}

// Comfortably under Vercel's 300s ceiling (see the new migrate/layout.tsx's
// maxDuration) — same idiom as import/actions.ts's PUSH_BUDGET_MS.
const PULL_BUDGET_MS = 260_000;

/**
 * Runs as many not-yet-completed pull groups (see PULL_GROUP_ORDER in
 * pull-instance.ts) as fit in one budgeted chunk, merges each group's
 * results into the job's running results, and persists the job row. Shared
 * by startPullJobAction (first chunk) and continuePullJobAction (every
 * chunk after).
 *
 * Unlike push's equivalent runNextChunk, this catches a thrown error itself
 * and persists status: "failed" + the error message before returning — so a
 * pull job that dies partway through (e.g. Cin7 rate-limited on the
 * suppliers group) still has its already-completed groups' results saved,
 * not silently lost.
 */
async function runNextPullChunk(
  db: SupabaseClient,
  jobId: string,
  orgId: string,
  sourceInstanceId: string,
  completedGroups: PullGroup[],
  priorResults: Partial<Record<ImportKind, RunImportResult>>
): Promise<PullJobResult> {
  const deadline = Date.now() + PULL_BUDGET_MS;
  const completed = [...completedGroups];
  const results = { ...priorResults };

  try {
    for (const group of PULL_GROUP_ORDER) {
      if (completed.includes(group)) continue;
      if (Date.now() >= deadline) break; // don't start a new group once out of budget
      Object.assign(results, await pullInstanceGroup(db, orgId, sourceInstanceId, group));
      completed.push(group);
    }
    const status: PullJobStatus = completed.length === PULL_GROUP_ORDER.length ? "done" : "running";
    await db
      .from("pull_jobs")
      .update({ completed_groups: completed, results, status, updated_at: new Date().toISOString() })
      .eq("id", jobId);
    return { ok: true, jobId, status, results };
  } catch (e) {
    const error = e instanceof Error ? e.message : "Unknown error";
    await db
      .from("pull_jobs")
      .update({ completed_groups: completed, results, status: "failed", error, updated_at: new Date().toISOString() })
      .eq("id", jobId);
    return { ok: false, jobId, status: "failed", error, results };
  }
}

/**
 * Kicks off a Migrate pull background job and immediately runs its first
 * chunk, so a small catalog still finishes in one round-trip. Call
 * continuePullJobAction with the returned jobId in a loop while status is
 * "running" — see src/hooks/usePullJob.ts.
 *
 * No requireWriteAllowed check — a pull only writes into the org's own
 * canonical tables (the same thing a manual CSV upload does), it never
 * writes to a client's live Cin7 account, so it isn't gated by the
 * trial/write-allowed check the way pushing to Cin7 is.
 */
export async function startPullJobAction(sourceInstanceId: string): Promise<PullJobResult> {
  if (!sourceInstanceId) return { ok: false, error: "Choose a source instance." };

  try {
    const { orgId, userId } = await requireCurrentOrg();
    const db = createServiceRoleClient();

    const { data: job, error } = await db
      .from("pull_jobs")
      .insert({ org_id: orgId, source_instance_id: sourceInstanceId, created_by: userId })
      .select("id")
      .single();
    if (error || !job) return { ok: false, error: error?.message ?? "Failed to create pull job" };

    return await runNextPullChunk(db, job.id, orgId, sourceInstanceId, [], {});
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Runs the next budgeted chunk of an in-progress pull job. Call repeatedly until the returned status is no longer "running". */
export async function continuePullJobAction(jobId: string): Promise<PullJobResult> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const { data: job, error } = await db
      .from("pull_jobs")
      .select("id, source_instance_id, status, completed_groups, results, error")
      .eq("id", jobId)
      .eq("org_id", orgId) // the real authorization boundary — a job can only be continued by the org that owns it
      .single();
    if (error || !job) return { ok: false, error: "Pull job not found" };
    if (job.status !== "running") {
      return { ok: job.status === "done", jobId: job.id, status: job.status, results: job.results, error: job.error ?? undefined };
    }

    return await runNextPullChunk(db, job.id, orgId, job.source_instance_id, job.completed_groups ?? [], job.results ?? {});
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** The org's current in-progress pull job, if any — lets the Migrate page resume showing live progress after a reload or reopening the page mid-pull. */
export async function getActivePullJobAction(): Promise<PullJobResult | null> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const { data: job } = await db
      .from("pull_jobs")
      .select("id, status, results")
      .eq("org_id", orgId)
      .eq("status", "running")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!job) return null;
    return { ok: true, jobId: job.id, status: job.status, results: job.results };
  } catch {
    return null;
  }
}
