"use server";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceRoleClient } from "@/supabase/server";
import { runImport, type ImportKind, type RunImportResult } from "@/import/run-import";
import { syncOrgInstances, type InstanceSyncOutcome } from "@/sync/sync-org";
import type { PushScope } from "@/sync/run-sync";
import type { ActivityActor } from "@/lib/activity-log";
import { getLastImportKeys } from "@/import/last-batch";
import { requireCurrentOrg } from "@/lib/current-org";
import { requireWriteAllowed } from "@/lib/billing";

export interface ImportActionState {
  status: "idle" | "error" | "success";
  message?: string;
  result?: RunImportResult;
}

const VALID_KINDS: ImportKind[] = [
  "products",
  "assembly_bom",
  "production_bom",
  "suppliers",
  "supplier_addresses",
  "customers",
  "customer_addresses",
];

/**
 * Server Action backing the /import page. The org comes from the logged-in
 * session (org_members), not a client-supplied orgId — a user can only ever
 * import into their own org.
 */
export async function importCsvAction(
  _prevState: ImportActionState,
  formData: FormData
): Promise<ImportActionState> {
  const kind = formData.get("kind");
  const file = formData.get("file");

  if (typeof kind !== "string" || !VALID_KINDS.includes(kind as ImportKind)) {
    return { status: "error", message: `kind must be one of ${VALID_KINDS.join(", ")}` };
  }
  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", message: "Choose a CSV file." };
  }

  try {
    const { orgId } = await requireCurrentOrg();
    const csvText = await file.text();
    const db = createServiceRoleClient();
    const result = await runImport(db, orgId, kind as ImportKind, file.name, csvText);
    return { status: "success", result };
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : "Unknown error" };
  }
}

export type ScopeMode = "all" | "last_import" | "none";

export interface PushScopeSelection {
  products: ScopeMode;
  customers: ScopeMode;
  suppliers: ScopeMode;
}

export type PushJobStatus = "running" | "done" | "failed";

export interface PushJobResult {
  ok: boolean;
  error?: string;
  jobId?: string;
  status?: PushJobStatus;
  outcomes?: InstanceSyncOutcome[];
}

// Comfortably under Vercel's 300s ceiling (see import/layout.tsx's
// maxDuration) — one level deeper than cron-rotation.ts's own TIME_BUDGET_MS
// idiom: that one budgets a tick across many orgs, this one budgets a single
// push across one org's chosen instances.
const PUSH_BUDGET_MS = 260_000;

/**
 * Resolves `PushScopeSelection` → the frozen `PushScope` a push job runs
 * with — computed once at kickoff (not re-resolved per chunk) so a new,
 * unrelated import committed by the user mid-push doesn't get silently
 * swept into an already-running job. Same scoping rules as before: an
 * omitted kind means "all", "last_import" resolves to that kind's most
 * recently committed batch (or nothing, if none exists yet), "none" means
 * skip that kind entirely.
 */
async function resolveScope(db: SupabaseClient, orgId: string, scopeSelection: PushScopeSelection): Promise<PushScope> {
  const scope: PushScope = {};
  if (scopeSelection.products === "last_import") {
    scope.productSkus = (await getLastImportKeys(db, orgId, "products")) ?? [];
  } else if (scopeSelection.products === "none") {
    scope.productSkus = [];
  }
  if (scopeSelection.customers === "last_import") {
    scope.customerNames = (await getLastImportKeys(db, orgId, "customers")) ?? [];
  } else if (scopeSelection.customers === "none") {
    scope.customerNames = [];
  }
  if (scopeSelection.suppliers === "last_import") {
    scope.supplierNames = (await getLastImportKeys(db, orgId, "suppliers")) ?? [];
  } else if (scopeSelection.suppliers === "none") {
    scope.supplierNames = [];
  }
  return scope;
}

/**
 * Sums each instance's counters across chunks — a single syncOrgInstances
 * call only reports what it did in *that* chunk, not the job's running
 * total. Keyed by instanceId, not array position, since a later chunk only
 * ever re-includes instances that are still truncated (see
 * runNextChunk below) — an instance already finished simply stops
 * appearing in `next` and its prior entry here is left untouched.
 *
 * Accepted cosmetic tradeoff: without a resume cursor, a still-running
 * instance's next chunk re-scans from the top of its product/customer/
 * supplier lists — already-synced rows skip instantly via content_hash (no
 * Cin7 API call spent), but that means `productsSkipped`/etc. can be
 * summed more than once for the same rows across a multi-chunk job. Doesn't
 * affect what actually gets pushed to Cin7, only the displayed skip count
 * for a job that took more than one chunk.
 */
function mergeOutcomes(prior: InstanceSyncOutcome[], next: InstanceSyncOutcome[]): InstanceSyncOutcome[] {
  const byId = new Map(prior.map((o) => [o.instanceId, o]));
  const sum = (a?: number, b?: number) => (a ?? 0) + (b ?? 0);
  for (const n of next) {
    const p = byId.get(n.instanceId);
    if (!p) {
      byId.set(n.instanceId, n);
      continue;
    }
    byId.set(n.instanceId, {
      ...n,
      productsCreated: sum(p.productsCreated, n.productsCreated),
      productsUpdated: sum(p.productsUpdated, n.productsUpdated),
      productsSkipped: sum(p.productsSkipped, n.productsSkipped),
      productsFailed: sum(p.productsFailed, n.productsFailed),
      productionBomsPushed: sum(p.productionBomsPushed, n.productionBomsPushed),
      productionBomsFailed: sum(p.productionBomsFailed, n.productionBomsFailed),
      customersCreated: sum(p.customersCreated, n.customersCreated),
      customersUpdated: sum(p.customersUpdated, n.customersUpdated),
      customersSkipped: sum(p.customersSkipped, n.customersSkipped),
      customersFailed: sum(p.customersFailed, n.customersFailed),
      suppliersCreated: sum(p.suppliersCreated, n.suppliersCreated),
      suppliersUpdated: sum(p.suppliersUpdated, n.suppliersUpdated),
      suppliersSkipped: sum(p.suppliersSkipped, n.suppliersSkipped),
      suppliersFailed: sum(p.suppliersFailed, n.suppliersFailed),
      errors: [...(p.errors ?? []), ...(n.errors ?? [])],
    });
  }
  return Array.from(byId.values());
}

/**
 * Runs one budgeted chunk for whichever instances aren't done yet (an
 * instance is "done" once its most recent outcome came back with
 * `truncated: false`), merges the result into the job's running outcomes,
 * and updates the job row. Shared by startPushJobAction (first chunk) and
 * continuePushJobAction (every chunk after).
 */
async function runNextChunk(
  db: SupabaseClient,
  jobId: string,
  orgId: string,
  instanceIds: string[],
  scope: PushScope,
  actor: ActivityActor,
  priorOutcomes: InstanceSyncOutcome[]
): Promise<PushJobResult> {
  const doneIds = new Set(priorOutcomes.filter((o) => !o.truncated).map((o) => o.instanceId));
  const remainingIds = instanceIds.filter((id) => !doneIds.has(id));

  const chunkOutcomes = remainingIds.length ? await syncOrgInstances(db, orgId, remainingIds, scope, actor, PUSH_BUDGET_MS) : [];
  const outcomes = mergeOutcomes(priorOutcomes, chunkOutcomes);
  const status: PushJobStatus = outcomes.some((o) => o.truncated) ? "running" : "done";

  await db.from("push_jobs").update({ outcomes, status, updated_at: new Date().toISOString() }).eq("id", jobId);
  return { ok: true, jobId, status, outcomes };
}

/**
 * Kicks off a push-to-Cin7 background job (same instanceIds/scopeSelection
 * signature pushToCin7Action used to have) and immediately runs its first
 * chunk, so a small catalog still finishes in one round-trip exactly like
 * before. Call continuePushJobAction with the returned jobId in a loop
 * while status is "running" — see src/hooks/usePushJob.ts.
 */
export async function startPushJobAction(
  instanceIds: string[],
  scopeSelection: PushScopeSelection = { products: "all", customers: "all", suppliers: "all" }
): Promise<PushJobResult> {
  if (!instanceIds.length) return { ok: false, error: "Select at least one instance to push to." };

  try {
    const { orgId, userId, email } = await requireCurrentOrg();
    await requireWriteAllowed(orgId);
    const db = createServiceRoleClient();

    const scope = await resolveScope(db, orgId, scopeSelection);

    const { data: job, error } = await db
      .from("push_jobs")
      .insert({ org_id: orgId, instance_ids: instanceIds, scope, created_by: userId })
      .select("id")
      .single();
    if (error || !job) return { ok: false, error: error?.message ?? "Failed to create push job" };

    return await runNextChunk(db, job.id, orgId, instanceIds, scope, { userId, email }, []);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Runs the next budgeted chunk of an in-progress push job. Call repeatedly until the returned status is no longer "running". */
export async function continuePushJobAction(jobId: string): Promise<PushJobResult> {
  try {
    const { orgId, userId, email } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const { data: job, error } = await db
      .from("push_jobs")
      .select("id, instance_ids, scope, status, outcomes")
      .eq("id", jobId)
      .eq("org_id", orgId) // the real authorization boundary — a job can only be continued by the org that owns it
      .single();
    if (error || !job) return { ok: false, error: "Push job not found" };
    if (job.status !== "running") return { ok: true, jobId: job.id, status: job.status, outcomes: job.outcomes };

    return await runNextChunk(db, job.id, orgId, job.instance_ids, job.scope, { userId, email }, job.outcomes ?? []);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** The org's current in-progress push job, if any — lets the Import/Migrate pages resume showing live progress after a reload or reopening the page mid-push. */
export async function getActivePushJobAction(): Promise<PushJobResult | null> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const { data: job } = await db
      .from("push_jobs")
      .select("id, status, outcomes")
      .eq("org_id", orgId)
      .eq("status", "running")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!job) return null;
    return { ok: true, jobId: job.id, status: job.status, outcomes: job.outcomes };
  } catch {
    return null;
  }
}
