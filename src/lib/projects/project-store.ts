import "server-only";
// Projects POC — persistence orchestration. LOCAL ONLY: this module never imports anything from
// src/cin7 and never calls fetch; a structural test pins that. Every query is scoped by org_id, and
// a project belonging to another org is indistinguishable from "not found".
import { createHash } from "node:crypto";
import type { createServiceRoleClient } from "@/supabase/server";
import {
  ProjectInvariantError,
  assertBaselineUnchanged,
  canonicalBaseline,
  checkSchedule,
  computeProgressClaim,
  percentToBps,
  type PriorClaim,
  type ProgressClaimCalc,
  type StageInput,
} from "./claim-engine";
import { freezeClaimSnapshot, hashClaimSnapshot } from "./claim-snapshot";
import type { ApprovedCommercialBaseline } from "./baseline";
import {
  buildProjectView,
  type AllocationRow, type Cin7LinkRow, type ClaimLineRow, type ClaimRow,
  type ProgressEventRow, type ProjectRow, type ProjectView, type StageRow,
} from "./project-view";

type Db = ReturnType<typeof createServiceRoleClient>;

function fail(message: string): never {
  throw new Error(message);
}
function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) fail(`${what}: ${res.error.message}`);
  if (res.data === null) fail(`${what}: no data returned`);
  return res.data;
}

// ── reads ───────────────────────────────────────────────────────────────────

export async function loadProjectView(db: Db, orgId: string, projectId: string): Promise<ProjectView | null> {
  const { data: project, error } = await db.from("projects").select("*").eq("org_id", orgId).eq("id", projectId).maybeSingle();
  if (error) fail(`load project: ${error.message}`);
  if (!project) return null; // includes "belongs to another org"
  const [stages, events, claims, claimLines, allocations, links] = await Promise.all([
    db.from("project_stages").select("*").eq("org_id", orgId).eq("project_id", projectId),
    db.from("project_progress_events").select("*").eq("org_id", orgId).eq("project_id", projectId),
    db.from("project_claims").select("*").eq("org_id", orgId).eq("project_id", projectId),
    db.from("project_claim_lines").select("claim_id, stage_id, current_claim_cents").eq("org_id", orgId).eq("project_id", projectId),
    db.from("project_stage_allocations").select("*").eq("org_id", orgId).eq("project_id", projectId),
    db.from("project_cin7_links").select("claim_id, cin7_invoice_number, cin7_status, reconciled_at").eq("org_id", orgId).eq("project_id", projectId),
  ]);
  return buildProjectView({
    project: project as ProjectRow,
    stages: must(stages, "load stages") as StageRow[],
    events: must(events, "load progress events") as ProgressEventRow[],
    claims: must(claims, "load claims") as ClaimRow[],
    claimLines: must(claimLines, "load claim lines") as ClaimLineRow[],
    allocations: must(allocations, "load allocations") as AllocationRow[],
    links: must(links, "load links") as Cin7LinkRow[],
  });
}

export async function listProjectViews(db: Db, orgId: string): Promise<ProjectView[]> {
  const projects = must(await db.from("projects").select("id").eq("org_id", orgId).order("created_at", { ascending: false }), "list projects") as { id: string }[];
  const views: ProjectView[] = [];
  for (const p of projects) {
    const v = await loadProjectView(db, orgId, p.id);
    if (v) views.push(v);
  }
  return views;
}

// ── project creation from an approved baseline ──────────────────────────────

export function baselineHashFor(view: Pick<ProjectView, "project" | "stages">): string {
  const stages: StageInput[] = view.stages.map((s) => ({ id: s.id, name: s.name, valueCents: s.valueCents }));
  const canonical = canonicalBaseline({
    orgId: view.project.org_id,
    customerId: view.project.customer_name,
    contractCents: view.project.original_contract_cents,
    taxRateBps: view.project.tax_rate_bps,
    currency: view.project.currency,
    stages,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export async function createProjectFromBaseline(
  db: Db,
  orgId: string,
  email: string | null,
  baseline: ApprovedCommercialBaseline,
  opts: { reference: string; name: string; projectManager?: string | null },
): Promise<string> {
  // The Schedule of Values must balance BEFORE anything is written (fail closed, no silent imbalance).
  checkSchedule(
    baseline.contractCents,
    baseline.suggestedStages.map((s, i) => ({ id: String(i), name: s.name, valueCents: s.valueCents })),
  );

  const { data: project, error } = await db
    .from("projects")
    .insert({
      org_id: orgId,
      project_reference: opts.reference,
      name: opts.name,
      cin7_customer_id: baseline.customer.cin7CustomerId,
      customer_name: baseline.customer.name,
      originating_quote_ref: baseline.sourceQuoteRef,
      originating_quote_id: baseline.sourceQuoteId,
      original_contract_cents: baseline.contractCents,
      currency: baseline.currency,
      tax_rule: baseline.taxRule,
      tax_rate_bps: baseline.taxRateBps,
      tax_inclusive: baseline.taxInclusive,
      salesperson: baseline.salesperson,
      project_manager: opts.projectManager ?? null,
      status: "DRAFT",
      baseline_snapshot: baseline as unknown as Record<string, unknown>,
      created_by_email: email,
    })
    .select("id")
    .single();
  if (error || !project) fail(`create project: ${error?.message ?? "no row"}`);
  const projectId = (project as { id: string }).id;

  const stageRows = baseline.suggestedStages.map((s, i) => ({
    org_id: orgId, project_id: projectId, sort_order: i + 1, name: s.name, description: s.description, value_cents: s.valueCents,
  }));
  const stages = must(await db.from("project_stages").insert(stageRows).select("id, name"), "create stages") as { id: string; name: string }[];
  const stageIdByName = new Map(stages.map((s) => [s.name, s.id]));

  const allocRows = baseline.lines
    .filter((l) => l.suggestedStageName && stageIdByName.has(l.suggestedStageName))
    .map((l) => ({
      org_id: orgId, project_id: projectId, stage_id: stageIdByName.get(l.suggestedStageName as string),
      baseline_line_ref: l.lineRef, sku: l.sku, description: l.description, quantity: l.quantity,
      sales_value_cents: l.salesValueCents, estimated_cost_cents: l.estimatedCostCents, allocation_bps: 10_000,
    }));
  if (allocRows.length > 0) must(await db.from("project_stage_allocations").insert(allocRows).select("id"), "create allocations");

  // DB trigger re-verifies the balance on activation.
  const act = await db.from("projects").update({ status: "ACTIVE" }).eq("org_id", orgId).eq("id", projectId);
  if (act.error) fail(`activate project: ${act.error.message}`);
  return projectId;
}

// ── progress ────────────────────────────────────────────────────────────────

export async function recordProgress(
  db: Db,
  orgId: string,
  email: string,
  input: { projectId: string; stageId: string; reportedPct: string; approvedPct: string | null; comment: string },
): Promise<void> {
  const reportedBps = percentToBps(input.reportedPct);
  const approvedBpsNew = input.approvedPct === null ? null : percentToBps(input.approvedPct);

  const stage = await db.from("project_stages").select("id").eq("org_id", orgId).eq("project_id", input.projectId).eq("id", input.stageId).maybeSingle();
  if (stage.error) fail(stage.error.message);
  if (!stage.data) fail("Stage not found.");

  const last = await db
    .from("project_progress_events")
    .select("reported_bps, approved_bps")
    .eq("org_id", orgId).eq("stage_id", input.stageId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (last.error) fail(last.error.message);
  const prev = last.data as { reported_bps: number; approved_bps: number } | null;

  const approvedBps = approvedBpsNew ?? prev?.approved_bps ?? 0;
  const approvedChanged = approvedBps !== (prev?.approved_bps ?? 0);
  if (approvedChanged && !input.comment.trim()) fail("A comment/reason is required when approved commercial completion changes.");

  const ins = await db.from("project_progress_events").insert({
    org_id: orgId, project_id: input.projectId, stage_id: input.stageId,
    reported_bps: reportedBps, approved_bps: approvedBps,
    previous_reported_bps: prev?.reported_bps ?? null, previous_approved_bps: prev?.approved_bps ?? null,
    comment: input.comment.trim() || null, recorded_by_email: email,
  });
  if (ins.error) fail(`record progress: ${ins.error.message}`);
}

// ── claims ──────────────────────────────────────────────────────────────────

export interface ClaimPreview {
  calc: ProgressClaimCalc;
  taxRateBps: number;
  snapshotHash: string;
  baselineHash: string;
  nextSeq: number;
  claimNumber: string;
}

async function priorClaimsOf(db: Db, orgId: string, projectId: string, excludeClaimId?: string): Promise<PriorClaim[]> {
  const claims = must(await db.from("project_claims").select("id, status").eq("org_id", orgId).eq("project_id", projectId), "load prior claims") as { id: string; status: string }[];
  const lines = must(await db.from("project_claim_lines").select("claim_id, stage_id, current_claim_cents").eq("org_id", orgId).eq("project_id", projectId), "load prior claim lines") as ClaimLineRow[];
  return claims
    .filter((c) => c.id !== excludeClaimId)
    .map((c) => ({
      claimId: c.id,
      status: c.status,
      lines: lines.filter((l) => l.claim_id === c.id).map((l) => ({ stageId: l.stage_id, currentClaimCents: l.current_claim_cents })),
    }));
}

/** PURE-READ: calculates a claim. Writes nothing and touches nothing outside the local DB. */
export async function previewClaim(db: Db, orgId: string, projectId: string, selectedStageIds?: string[], excludeClaimId?: string): Promise<ClaimPreview> {
  const view = await loadProjectView(db, orgId, projectId);
  if (!view) fail("Project not found.");
  if (view.project.status !== "ACTIVE") fail("Only an ACTIVE project can be claimed against.");

  const stages: StageInput[] = view.stages.map((s) => ({ id: s.id, name: s.name, valueCents: s.valueCents }));
  const priorClaims = await priorClaimsOf(db, orgId, projectId, excludeClaimId);

  // Baseline immutability: if any claim is already committed, today's baseline must hash to the value recorded on it.
  const currentBaselineHash = baselineHashFor(view);
  const committed = must(
    await db.from("project_claims").select("baseline_hash, status").eq("org_id", orgId).eq("project_id", projectId).in("status", ["APPROVED", "CIN7_PENDING", "CIN7_CREATED", "RECONCILED", "FAILED_UNCERTAIN"]),
    "load committed claims",
  ) as { baseline_hash: string }[];
  for (const c of committed) {
    if (c.baseline_hash !== currentBaselineHash) {
      assertBaselineUnchanged("committed", "changed"); // throws BASELINE_MUTATED
    }
  }

  const calc = computeProgressClaim({
    contractCents: view.project.original_contract_cents,
    stages,
    progress: view.stages.map((s) => ({ stageId: s.id, approvedBps: s.approvedBps, reportedBps: s.reportedBps })),
    priorClaims,
    taxRateBps: view.project.tax_rate_bps, // resolved tax input stored on the project, never hard-coded here
    selectedStageIds,
  });
  const snapshotHash = hashClaimSnapshot(freezeClaimSnapshot(calc, view.project.tax_rate_bps));
  const nextSeq = (view.claims.reduce((m, c) => Math.max(m, c.claim_seq), 0)) + 1;
  return {
    calc, taxRateBps: view.project.tax_rate_bps, snapshotHash, baselineHash: currentBaselineHash, nextSeq,
    claimNumber: `${view.project.project_reference}-C${String(nextSeq).padStart(2, "0")}`,
  };
}

export function claimIdempotencyKey(projectId: string, seq: number, snapshotHash: string): string {
  return createHash("sha256").update(`project-claim|${projectId}|${seq}|${snapshotHash}`).digest("hex");
}

/** Persists a DRAFT claim (reserves nothing). Re-submitting the same preview returns the existing draft. */
export async function createClaimDraft(
  db: Db, orgId: string, email: string, projectId: string, selectedStageIds?: string[], supersedesClaimId?: string,
): Promise<{ claimId: string; duplicate: boolean }> {
  const p = await previewClaim(db, orgId, projectId, selectedStageIds);

  // Same content already sitting as an open draft -> idempotent no-op.
  const open = (await db.from("project_claims").select("id, snapshot_hash, baseline_hash, status").eq("org_id", orgId).eq("project_id", projectId).in("status", ["DRAFT", "READY_FOR_APPROVAL"]));
  if (open.error) fail(`check open drafts: ${open.error.message}`);
  const existing = (open.data as { id: string; snapshot_hash: string; baseline_hash: string }[]).find((c) => c.snapshot_hash === p.snapshotHash && c.baseline_hash === p.baselineHash);
  if (existing) return { claimId: existing.id, duplicate: true };

  const key = claimIdempotencyKey(projectId, p.nextSeq, p.snapshotHash);
  const ins = await db.from("project_claims").insert({
    org_id: orgId, project_id: projectId, claim_seq: p.nextSeq, claim_number: p.claimNumber,
    claim_date: new Date().toISOString().slice(0, 10), status: "DRAFT",
    tax_rate_bps: p.taxRateBps, subtotal_cents: p.calc.subtotalCents, tax_cents: p.calc.taxCents, total_cents: p.calc.totalCents,
    snapshot_hash: p.snapshotHash, baseline_hash: p.baselineHash, idempotency_key: key, author_email: email,
    supersedes_claim_id: supersedesClaimId ?? null,
  }).select("id").single();
  if (ins.error || !ins.data) {
    // A racing duplicate click hits unique(project_id, claim_seq)/unique(org_id, idempotency_key): treat as duplicate.
    if (ins.error && /duplicate key|unique/i.test(ins.error.message)) {
      const again = await db.from("project_claims").select("id").eq("org_id", orgId).eq("project_id", projectId).eq("idempotency_key", key).maybeSingle();
      if (again.data) return { claimId: (again.data as { id: string }).id, duplicate: true };
    }
    fail(`create claim: ${ins.error?.message ?? "no row"}`);
  }
  const claimId = (ins.data as { id: string }).id;
  const lines = p.calc.lines.map((l) => ({
    org_id: orgId, project_id: projectId, claim_id: claimId, stage_id: l.stageId, stage_name: l.stageName,
    stage_value_cents: l.stageValueCents, approved_bps: l.approvedBps, reported_bps: l.reportedBps,
    earned_to_date_cents: l.earnedToDateCents, previously_committed_cents: l.previouslyBilledCents,
    current_claim_cents: l.currentClaimCents, tax_cents: l.taxCents,
  }));
  const li = await db.from("project_claim_lines").insert(lines);
  if (li.error) fail(`create claim lines: ${li.error.message}`);
  return { claimId, duplicate: false };
}

export async function submitClaimForApproval(db: Db, orgId: string, projectId: string, claimId: string): Promise<void> {
  const r = await db.from("project_claims").update({ status: "READY_FOR_APPROVAL" }).eq("org_id", orgId).eq("project_id", projectId).eq("id", claimId).eq("status", "DRAFT").select("id");
  if (r.error) fail(r.error.message);
  if (!r.data || r.data.length === 0) fail("Claim is not a DRAFT in this project.");
}

/**
 * Approve: re-derives the claim from CURRENT data (excluding itself) and refuses unless it matches the
 * drafted snapshot hash exactly — a stale draft (progress or prior claims moved) must be re-drafted.
 * Approval freezes the snapshot; it does NOT create anything in Cin7.
 */
export async function approveClaim(db: Db, orgId: string, approverEmail: string, projectId: string, claimId: string): Promise<void> {
  const c = await db.from("project_claims").select("id, status, snapshot_hash, baseline_hash").eq("org_id", orgId).eq("project_id", projectId).eq("id", claimId).maybeSingle();
  if (c.error) fail(c.error.message);
  const claim = c.data as { status: string; snapshot_hash: string; baseline_hash: string } | null;
  if (!claim) fail("Claim not found.");
  if (claim.status !== "READY_FOR_APPROVAL") fail("Only a claim that is READY_FOR_APPROVAL can be approved.");
  const lines = must(await db.from("project_claim_lines").select("stage_id").eq("org_id", orgId).eq("claim_id", claimId), "load claim lines") as { stage_id: string }[];
  const fresh = await previewClaim(db, orgId, projectId, lines.map((l) => l.stage_id), claimId);
  // STALE = any input capable of changing THIS claim's financial result has moved: the claimed stages'
  // approved completion / value / prior commitments / tax rate (snapshot hash), or the commercial baseline
  // — customer, currency, contract, tax, schedule (baseline hash). Progress on UNRELATED stages is in
  // neither hash, so it never stales a draft.
  if (fresh.snapshotHash !== claim.snapshot_hash || fresh.baselineHash !== claim.baseline_hash) {
    // POLICY: a stale financial claim is REJECTED, never silently recalculated or mutated. The user must
    // explicitly recalculate (recalculateStaleDraft), which supersedes this draft with a new one.
    throw new ProjectInvariantError("STALE_DRAFT", "This draft is stale: progress or prior claims have changed since it was drafted. Recalculate it explicitly; it will be superseded by a freshly calculated draft.");
  }
  const r = await db.from("project_claims").update({ status: "APPROVED", approver_email: approverEmail, approved_at: new Date().toISOString() })
    .eq("org_id", orgId).eq("project_id", projectId).eq("id", claimId).eq("status", "READY_FOR_APPROVAL").select("id");
  if (r.error) fail(r.error.message);
  if (!r.data || r.data.length === 0) fail("Claim could not be approved (state changed).");
}

export async function cancelDraftClaim(db: Db, orgId: string, projectId: string, claimId: string): Promise<void> {
  const r = await db.from("project_claims").update({ status: "CANCELLED_BEFORE_WRITE", no_write_evidence: { method: "NEVER_SENT", checkedAt: new Date().toISOString(), detail: "Cancelled before approval; no Cin7 call was ever made." } })
    .eq("org_id", orgId).eq("project_id", projectId).eq("id", claimId).in("status", ["DRAFT", "READY_FOR_APPROVAL"]).select("id");
  if (r.error) fail(r.error.message);
  if (!r.data || r.data.length === 0) fail("Only a DRAFT or READY_FOR_APPROVAL claim can be cancelled here.");
}

// ── golden fixture seeding (POC only) ───────────────────────────────────────

/**
 * Seeds the deterministic golden scenario THROUGH THE REAL PATHS (progress events, draft -> ready ->
 * approved claim), so nothing bypasses the engine or the DB guards:
 *   opening claim (#01, APPROVED):  Deposit 100% = R1,000,000 ; Manufacturing 50% = R1,500,000
 *   then progress moves on:         Manufacturing reported 75% / approved 65% ; Delivery 25% / 25%
 * The next claim preview is therefore Manufacturing R450,000 + Delivery R500,000 = R950,000.
 * The opening claim is a locally APPROVED stand-in for earlier billing; it was never sent to Cin7.
 */
export async function seedGoldenFixture(db: Db, orgId: string, email: string, baseline: ApprovedCommercialBaseline): Promise<string> {
  const reference = `NQ-POC-${Date.now().toString(36).toUpperCase()}`;
  const projectId = await createProjectFromBaseline(db, orgId, email, baseline, { reference, name: "NewQuip Grower Project POC", projectManager: "Fixture Project Manager" });
  const view = must({ data: await loadProjectView(db, orgId, projectId), error: null }, "load seeded project");
  const idOf = (name: string) => (view.stages.find((s) => s.name === name) ?? fail(`fixture stage ${name} missing`)).id;
  const rec = (stage: string, reported: string, approved: string, comment: string) =>
    recordProgress(db, orgId, email, { projectId, stageId: idOf(stage), reportedPct: reported, approvedPct: approved, comment });

  await rec("Deposit / Commencement", "100", "100", "Fixture: deposit invoiced on commencement");
  await rec("Manufacturing", "50", "50", "Fixture: opening position before the next claim");
  const opening = await createClaimDraft(db, orgId, email, projectId);
  await submitClaimForApproval(db, orgId, projectId, opening.claimId);
  await approveClaim(db, orgId, "fixture-seed@toolbox.local", projectId, opening.claimId);

  await rec("Manufacturing", "75", "65", "Fixture: physical 75% reported; manager approved 65% commercially");
  await rec("Delivery", "25", "25", "Fixture: first trucks delivered");
  return projectId;
}

/**
 * Explicit recalculation of a STALE draft (the approved stale-claim policy):
 *   - only a DRAFT / READY_FOR_APPROVAL claim whose snapshot no longer matches current project state;
 *   - a NEW draft is calculated fresh from current state (new snapshot, new idempotency key, higher
 *     claim number) and records `supersedes_claim_id` for audit lineage;
 *   - the OLD draft is then CANCELLED_BEFORE_WRITE (released, never sent) — its lines and snapshot are
 *     NOT touched, so its history stays available. Nothing is silently mutated and nothing reserves value.
 * A draft that is not stale is refused (nothing to recalculate).
 */
export async function recalculateStaleDraft(
  db: Db, orgId: string, email: string, projectId: string, claimId: string,
): Promise<{ newClaimId: string; supersededClaimId: string }> {
  const c = await db.from("project_claims").select("id, status, snapshot_hash, baseline_hash").eq("org_id", orgId).eq("project_id", projectId).eq("id", claimId).maybeSingle();
  if (c.error) fail(c.error.message);
  const old = c.data as { status: string; snapshot_hash: string; baseline_hash: string } | null;
  if (!old) fail("Claim not found.");
  if (old.status !== "DRAFT" && old.status !== "READY_FOR_APPROVAL") fail("Only a DRAFT or READY_FOR_APPROVAL claim can be recalculated.");
  const lines = must(await db.from("project_claim_lines").select("stage_id").eq("org_id", orgId).eq("claim_id", claimId), "load claim lines") as { stage_id: string }[];
  const stageIds = lines.map((l) => l.stage_id);

  const fresh = await previewClaim(db, orgId, projectId, stageIds, claimId);
  if (fresh.snapshotHash === old.snapshot_hash && fresh.baselineHash === old.baseline_hash) {
    throw new ProjectInvariantError("STALE_DRAFT", "This draft is not stale — it already matches current project state.");
  }
  // 1) new draft first (so a failure leaves the original draft intact), 2) then supersede the old one.
  const created = await createClaimDraft(db, orgId, email, projectId, stageIds, claimId);
  const cancel = await db.from("project_claims").update({
    status: "CANCELLED_BEFORE_WRITE",
    no_write_evidence: { method: "NEVER_SENT", checkedAt: new Date().toISOString(), detail: `Superseded by recalculated draft ${created.claimId}; no Cin7 call was ever made.` },
  }).eq("org_id", orgId).eq("project_id", projectId).eq("id", claimId).in("status", ["DRAFT", "READY_FOR_APPROVAL"]).select("id");
  if (cancel.error) fail(cancel.error.message);
  if (!cancel.data || cancel.data.length === 0) fail("The stale draft could not be superseded (state changed).");
  return { newClaimId: created.claimId, supersededClaimId: claimId };
}
