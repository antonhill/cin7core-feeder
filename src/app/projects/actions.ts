"use server";

// Projects POC server actions. LOCAL ONLY — nothing here (or in src/lib/projects) reaches Cin7.
// Authorization is re-established inside EVERY action (CCT-ADR-0010): module access for all, plus the
// org owner/admin role for anything that approves commercial completion or approves a claim.
// This file may export ONLY async functions and erased interfaces ("use server" rule in CLAUDE.md).

import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { logActivity } from "@/lib/activity-log";
import { createServiceRoleClient } from "@/supabase/server";
import { PROJECTS_MODULE } from "@/app/module-nav";
import { goldenFixtureBaseline } from "@/lib/projects/baseline";
import {
  approveClaim,
  cancelDraftClaim,
  createClaimDraft,
  listProjectViews,
  loadProjectView,
  previewClaim,
  recalculateStaleDraft,
  recordProgress,
  seedGoldenFixture,
  submitClaimForApproval,
} from "@/lib/projects/project-store";
import type { ProjectView } from "@/lib/projects/project-view";
import type { ProgressClaimCalc } from "@/lib/projects/claim-engine";

export interface ActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface ClaimPreviewResult {
  calc: ProgressClaimCalc;
  claimNumber: string;
  taxRateBps: number;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : "Unexpected error";
}

export async function listProjectsAction(): Promise<ActionResult<ProjectView[]>> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    return { ok: true, data: await listProjectViews(createServiceRoleClient(), orgId) };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

export async function getProjectAction(projectId: string): Promise<ActionResult<ProjectView>> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    const view = await loadProjectView(createServiceRoleClient(), orgId, projectId);
    if (!view) return { ok: false, error: "Project not found." };
    return { ok: true, data: view };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/**
 * DISPLAY ONLY: tells the UI whether to show owner/admin controls (approve commercial completion, approve claims,
 * create the fixture). Every mutating action above still enforces the role server-side; hiding a button is a
 * convenience, never the control.
 */
export async function getViewerPermissionsAction(): Promise<ActionResult<{ canApprove: boolean }>> {
  try {
    await requireModuleAccess(PROJECTS_MODULE.href);
    try {
      await requireOrgAdmin("approve in Projects");
      return { ok: true, data: { canApprove: true } };
    } catch {
      return { ok: true, data: { canApprove: false } };
    }
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Creates the deterministic golden POC project (R10m, six stages, opening claim) in the caller's org. */
export async function seedGoldenProjectAction(): Promise<ActionResult<{ projectId: string }>> {
  try {
    const { orgId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    await requireOrgAdmin("create the fixture project");
    const db = createServiceRoleClient();
    const projectId = await seedGoldenFixture(db, orgId, email ?? "unknown", goldenFixtureBaseline());
    await logActivity(db, { orgId, actor: { userId: "n/a", email }, action: "projects.fixture_created", summary: "Created the Projects POC golden fixture project (local only; no Cin7 write)", detail: { projectId } });
    return { ok: true, data: { projectId } };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/**
 * Records a progress event. Reported PHYSICAL completion needs only module access; changing APPROVED
 * commercial completion (approvedPct !== null) additionally needs the org owner/admin role.
 */
export async function recordProgressAction(
  projectId: string,
  stageId: string,
  reportedPct: string,
  approvedPct: string | null,
  comment: string,
): Promise<ActionResult<null>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    if (approvedPct !== null) await requireOrgAdmin("approve commercial completion");
    const db = createServiceRoleClient();
    await recordProgress(db, orgId, email ?? "unknown", { projectId, stageId, reportedPct, approvedPct, comment });
    if (approvedPct !== null) {
      await logActivity(db, { orgId, actor: { userId, email }, action: "projects.progress_approved", summary: `Approved commercial completion ${approvedPct}% on a project stage`, detail: { projectId, stageId, comment } });
    }
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Calculates a claim. READ-ONLY: writes nothing, no Cin7 call. */
export async function previewClaimAction(projectId: string, selectedStageIds?: string[]): Promise<ActionResult<ClaimPreviewResult>> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    const p = await previewClaim(createServiceRoleClient(), orgId, projectId, selectedStageIds);
    return { ok: true, data: { calc: p.calc, claimNumber: p.claimNumber, taxRateBps: p.taxRateBps } };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Persists a DRAFT claim locally (reserves nothing). Idempotent for an identical open draft. */
export async function createClaimDraftAction(projectId: string, selectedStageIds?: string[]): Promise<ActionResult<{ claimId: string; duplicate: boolean }>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    const db = createServiceRoleClient();
    const r = await createClaimDraft(db, orgId, email ?? "unknown", projectId, selectedStageIds);
    if (!r.duplicate) {
      await logActivity(db, { orgId, actor: { userId, email }, action: "projects.claim_drafted", summary: "Drafted a project progress claim (local only; no Cin7 write)", detail: { projectId, claimId: r.claimId } });
    }
    return { ok: true, data: r };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

export async function submitClaimForApprovalAction(projectId: string, claimId: string): Promise<ActionResult<null>> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    await submitClaimForApproval(createServiceRoleClient(), orgId, projectId, claimId);
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Manager approval. Freezes the claim's financial snapshot and RESERVES its value. Creates nothing in Cin7. */
export async function approveClaimAction(projectId: string, claimId: string): Promise<ActionResult<null>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    await requireOrgAdmin("approve a progress claim");
    const db = createServiceRoleClient();
    await approveClaim(db, orgId, email ?? "unknown", projectId, claimId);
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.claim_approved", summary: "Approved a project progress claim (value reserved; no Cin7 write)", detail: { projectId, claimId } });
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

export async function cancelDraftClaimAction(projectId: string, claimId: string): Promise<ActionResult<null>> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    await cancelDraftClaim(createServiceRoleClient(), orgId, projectId, claimId);
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Explicitly recalculates a STALE draft: a new draft is calculated fresh and the old one is superseded (cancelled, history kept). */
export async function recalculateStaleDraftAction(projectId: string, claimId: string): Promise<ActionResult<{ newClaimId: string; supersededClaimId: string }>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    const db = createServiceRoleClient();
    const r = await recalculateStaleDraft(db, orgId, email ?? "unknown", projectId, claimId);
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.claim_superseded", summary: "Recalculated a stale project claim draft (old draft superseded; local only, no Cin7 write)", detail: { projectId, ...r } });
    return { ok: true, data: r };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}
