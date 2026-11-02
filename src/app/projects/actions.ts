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
import { isNewquipPocOrg } from "@/newquip/access";
import { assertNewquipOrg } from "@/lib/projects/newquip-gate";
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
  setOpeningCommitments,
  submitClaimForApproval,
} from "@/lib/projects/project-store";
import { approveVariation, raiseVariation, rejectVariation, repriceVariation } from "@/lib/projects/variation-store";
import { approvalsAvailable, decideDocument, legacyCtx, submitForApproval, withdrawPendingFor } from "@/lib/approvals/approval-store";
import { redactVariationCosts } from "@/lib/projects/variations";
import { randsToCents } from "@/lib/projects/claim-engine";
import { assertSelectionHonoured, parsePartialAmounts, requireExplicitSelection } from "@/lib/projects/claim-selection";
import { BillingScopeAccessError, guardBillingScope } from "@/lib/projects/scope-access";
import { NEGATIVE_VARIATION_UNSUPPORTED, isNegativeAmountInput } from "@/lib/projects/variations";
import { isCustomerFacingProject, type ProjectView } from "@/lib/projects/project-view";
import type { ProgressClaimCalc } from "@/lib/projects/claim-engine";

export interface ActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
  /** Set when the caller asked for an internal billing scope they may not open: the project to show instead. */
  redirectTo?: string;
}

export interface ClaimPreviewResult {
  calc: ProgressClaimCalc;
  claimNumber: string;
  taxRateBps: number;
}

/** Whether the caller is an org owner/admin (may see internal costs). Fails closed. */
async function isAdmin(): Promise<boolean> {
  try { await requireOrgAdmin("view internal costs"); return true; } catch { return false; }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : "Unexpected error";
}

export async function listProjectsAction(): Promise<ActionResult<ProjectView[]>> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    // Variation billing projects are reached from their BASE project (Variations tab), not listed as separate projects.
    const canSeeCost = await isAdmin();
    return { ok: true, data: (await listProjectViews(createServiceRoleClient(), orgId)).filter(isCustomerFacingProject).map((v) => redactVariationCosts(v, canSeeCost)) };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

export async function getProjectAction(projectId: string): Promise<ActionResult<ProjectView>> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    const admin = await isAdmin();
    await guardBillingScope(createServiceRoleClient(), orgId, projectId, admin);
    const view = await loadProjectView(createServiceRoleClient(), orgId, projectId);
    if (!view) return { ok: false, error: "Project not found." };
    return { ok: true, data: redactVariationCosts(view, admin) };
  } catch (e) {
    if (e instanceof BillingScopeAccessError) return { ok: false, error: e.message, ...(e.parentProjectId ? { redirectTo: e.parentProjectId } : {}) };
    return { ok: false, error: message(e) };
  }
}

/**
 * DISPLAY ONLY: tells the UI whether to show owner/admin controls (approve commercial completion, approve claims,
 * create the fixture). Every mutating action above still enforces the role server-side; hiding a button is a
 * convenience, never the control.
 */
export async function getViewerPermissionsAction(): Promise<ActionResult<{ canApprove: boolean; newquip: boolean }>> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    // `newquip` shows the NewQuip-only tabs (Variations, Products & Fulfilment); every such server action re-checks it.
    const newquip = isNewquipPocOrg(orgId);
    try {
      await requireOrgAdmin("approve in Projects");
      return { ok: true, data: { canApprove: true, newquip } };
    } catch {
      return { ok: true, data: { canApprove: false, newquip } };
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
    await guardBillingScope(createServiceRoleClient(), orgId, projectId, await isAdmin());
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
export async function previewClaimAction(projectId: string, selectedStageIds?: string[], partialRands?: Record<string, string>): Promise<ActionResult<ClaimPreviewResult>> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    await guardBillingScope(createServiceRoleClient(), orgId, projectId, await isAdmin());
    const chosen = requireExplicitSelection(selectedStageIds);
    const p = await previewClaim(createServiceRoleClient(), orgId, projectId, chosen, undefined, { amountsCents: parsePartialAmounts(chosen, partialRands) });
    assertSelectionHonoured(chosen, p.calc.lines);
    return { ok: true, data: { calc: p.calc, claimNumber: p.claimNumber, taxRateBps: p.taxRateBps } };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Persists a DRAFT claim locally (reserves nothing). Idempotent for an identical open draft. */
export async function createClaimDraftAction(projectId: string, selectedStageIds?: string[], partialRands?: Record<string, string>): Promise<ActionResult<{ claimId: string; duplicate: boolean }>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    await guardBillingScope(createServiceRoleClient(), orgId, projectId, await isAdmin());
    const db = createServiceRoleClient();
    const chosen = requireExplicitSelection(selectedStageIds);
    const r = await createClaimDraft(db, orgId, email ?? "unknown", projectId, chosen, undefined, { amountsCents: parsePartialAmounts(chosen, partialRands) });
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
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    await guardBillingScope(createServiceRoleClient(), orgId, projectId, await isAdmin());
    const db = createServiceRoleClient();
    await submitClaimForApproval(db, orgId, projectId, claimId);
    // Record the submission (exact revision + digest) on the Approvals dashboard. A recording problem never loses the claim: approving it later re-submits.
    if (await approvalsAvailable(db).catch(() => false)) await submitForApproval(db, legacyCtx(orgId, userId, email, await isAdmin()), "CLAIM", claimId).catch(() => undefined);
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Manager approval. Freezes the claim's financial snapshot and RESERVES its value. Creates nothing in Cin7. */
export async function approveClaimAction(projectId: string, claimId: string): Promise<ActionResult<null>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    await guardBillingScope(createServiceRoleClient(), orgId, projectId, await isAdmin());
    await requireOrgAdmin("approve a progress claim");
    const db = createServiceRoleClient();
    if (await approvalsAvailable(db)) await decideDocument(db, legacyCtx(orgId, userId, email, true), "CLAIM", claimId, "APPROVE"); // one approval path: separation of duties, digest, history
    else await approveClaim(db, orgId, email ?? "unknown", projectId, claimId);
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.claim_approved", summary: "Approved a project progress claim (value reserved; no Cin7 write)", detail: { projectId, claimId } });
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

export async function cancelDraftClaimAction(projectId: string, claimId: string): Promise<ActionResult<null>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    await guardBillingScope(createServiceRoleClient(), orgId, projectId, await isAdmin());
    await cancelDraftClaim(createServiceRoleClient(), orgId, projectId, claimId);
    if (await approvalsAvailable(createServiceRoleClient()).catch(() => false)) await withdrawPendingFor(createServiceRoleClient(), legacyCtx(orgId, userId, email, await isAdmin()), "CLAIM", claimId, "The claim was cancelled by its preparer.").catch(() => undefined);
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Explicitly recalculates a STALE draft: a new draft is calculated fresh and the old one is superseded (cancelled, history kept). */
export async function recalculateStaleDraftAction(projectId: string, claimId: string): Promise<ActionResult<{ newClaimId: string; supersededClaimId: string }>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    await guardBillingScope(createServiceRoleClient(), orgId, projectId, await isAdmin());
    const db = createServiceRoleClient();
    const r = await recalculateStaleDraft(db, orgId, email ?? "unknown", projectId, claimId);
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.claim_superseded", summary: "Recalculated a stale project claim draft (old draft superseded; local only, no Cin7 write)", detail: { projectId, ...r } });
    return { ok: true, data: r };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

// ── Variations (the ONLY way scope/value changes after acceptance) ──────────
// Raise / price: any module member (rep + estimator tiers; the manager tier includes them). Approve / reject: org owner/admin
// (manager) only. original_contract_cents never changes; revised = original + APPROVED variations. Nothing reaches Cin7.

export async function raiseVariationAction(projectId: string, title: string, description: string, amountRands: string, estimatedCostRands = ""): Promise<ActionResult<{ variationId: string; code: string }>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    assertNewquipOrg(orgId);
    const db = createServiceRoleClient();
    if (isNegativeAmountInput(amountRands)) throw new Error(NEGATIVE_VARIATION_UNSUPPORTED);
    // An estimated cost is internal: only a manager may record one (a non-manager's value is ignored, not trusted).
    const estimatedCostCents = estimatedCostRands.trim() && (await isAdmin()) ? randsToCents(estimatedCostRands) : null;
    const r = await raiseVariation(db, orgId, email ?? "unknown", { projectId, title, description, amountCents: randsToCents(amountRands), estimatedCostCents });
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.variation_raised", summary: `Raised project variation ${r.code} (draft; contract value unchanged; no Cin7 write)`, detail: { projectId, variationId: r.variationId } });
    return { ok: true, data: r };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

export async function repriceVariationAction(projectId: string, variationId: string, amountRands: string): Promise<ActionResult<null>> {
  try {
    const { orgId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    assertNewquipOrg(orgId);
    if (isNegativeAmountInput(amountRands)) throw new Error(NEGATIVE_VARIATION_UNSUPPORTED);
    await repriceVariation(createServiceRoleClient(), orgId, email ?? "unknown", projectId, variationId, randsToCents(amountRands));
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Submits the variation's CURRENT content for manager approval (it cannot be edited while pending). */
export async function submitVariationForApprovalAction(projectId: string, variationId: string): Promise<ActionResult<null>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    assertNewquipOrg(orgId);
    const db = createServiceRoleClient();
    if (!(await approvalsAvailable(db))) throw new Error("Approvals are not available (switched off, or the database migration is pending).");
    const v = await db.from("project_variations").select("id").eq("org_id", orgId).eq("project_id", projectId).eq("id", variationId).maybeSingle();
    if (!v.data) throw new Error("Variation not found in this project.");
    await submitForApproval(db, legacyCtx(orgId, userId, email, await isAdmin()), "VARIATION", variationId);
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

export async function approveVariationAction(projectId: string, variationId: string): Promise<ActionResult<null>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    assertNewquipOrg(orgId);
    await requireOrgAdmin("approve a variation");
    const db = createServiceRoleClient();
    if (await approvalsAvailable(db)) await decideDocument(db, legacyCtx(orgId, userId, email, true), "VARIATION", variationId, "APPROVE");
    else await approveVariation(db, orgId, email ?? "unknown", projectId, variationId);
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.variation_approved", summary: "Approved a project variation (revised contract value increased; original unchanged; no Cin7 write)", detail: { projectId, variationId } });
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

export async function rejectVariationAction(projectId: string, variationId: string, reason: string): Promise<ActionResult<null>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    assertNewquipOrg(orgId);
    await requireOrgAdmin("reject a variation");
    const db = createServiceRoleClient();
    if (await approvalsAvailable(db)) await decideDocument(db, legacyCtx(orgId, userId, email, true), "VARIATION", variationId, "REJECT", { reason });
    else await rejectVariation(db, orgId, email ?? "unknown", projectId, variationId, reason);
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.variation_rejected", summary: "Rejected a project variation (no contract value change; no Cin7 write)", detail: { projectId, variationId } });
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/**
 * Manager/admin only. Records value already committed / certified BEFORE this project entered the Toolbox claim workflow.
 * Local only — creates no claim and no Cin7 link; frozen once any claim exists.
 */
export async function setOpeningCommitmentsAction(projectId: string, items: Array<{ stageId: string; rands: string }>, reason: string): Promise<ActionResult<null>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    await guardBillingScope(createServiceRoleClient(), orgId, projectId, await isAdmin());
    await requireOrgAdmin("set opening commitments");
    const db = createServiceRoleClient();
    await setOpeningCommitments(db, orgId, email ?? "unknown", { projectId, reason, items: items.map((i) => ({ stageId: i.stageId, amountCents: randsToCents(i.rands.trim() === "" ? "0" : i.rands) })) });
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.opening_commitments_set", summary: "Set project opening commitments (prior certified value; no claim, no Cin7 write)", detail: { projectId } });
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}
