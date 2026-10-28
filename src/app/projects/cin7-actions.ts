"use server";

// Projects -> Cin7 claim posting: Server Actions. Authorisation is re-established inside EVERY action (CCT-ADR-0010) and the write gates
// are derived HERE, on the server: the rollout flag, the rollout org, and the manager role. The UI only displays them.
// This file may export ONLY async functions and erased interfaces ("use server" rule in CLAUDE.md).

import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { logActivity } from "@/lib/activity-log";
import { createServiceRoleClient } from "@/supabase/server";
import { PROJECTS_MODULE } from "@/app/module-nav";
import { guardBillingScope } from "@/lib/projects/scope-access";
import { cin7WritesEnabled } from "@/lib/projects/write-flag";
import { isNewquipPocOrg } from "@/newquip/access";
import { buildCin7Port, singleActiveInstanceId } from "@/lib/projects/cin7-adapter";
import { buildSaleCreationPort } from "@/lib/projects/cin7-sale-creation-adapter";
import { checkSalePrerequisites, createSaleForProject, loadCreation, type PrerequisiteReport, reconcileSaleCreation, type CreationRow } from "@/lib/projects/cin7-sale-creation-store";
import type { CreationProductInput } from "@/lib/projects/cin7-sale-creation";
import { linkCin7Sale, listPostings, loadSaleLink, postClaimToCin7, reconcileClaimPosting, type PostingRow, type SaleLinkRow, type WriteGates } from "@/lib/projects/cin7-posting-store";

export interface Cin7ActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : "Unexpected error";
}

async function gatesFor(orgId: string): Promise<WriteGates> {
  let isManager = false;
  try {
    await requireOrgAdmin("manage Cin7 posting");
    isManager = true;
  } catch {
    isManager = false; // fail closed
  }
  return {
    // OFF by default: only the exact string "true" turns the writer on.
    writesEnabled: cin7WritesEnabled(process.env),
    orgEnabled: isNewquipPocOrg(orgId),
    isManager,
  };
}

export interface Cin7PostingStatus {
  gates: WriteGates;
  link: SaleLinkRow | null;
  postings: PostingRow[];
}

export async function getCin7PostingStatusAction(projectId: string): Promise<Cin7ActionResult<Cin7PostingStatus>> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    await guardBillingScope(createServiceRoleClient(), orgId, projectId, (await gatesFor(orgId)).isManager);
    const db = createServiceRoleClient();
    const link = await loadSaleLink(db, orgId, projectId).catch(() => null); // deploy-order safety until migration 0104 exists
    return { ok: true, data: { gates: await gatesFor(orgId), link, postings: await listPostings(db, orgId, projectId) } };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Manager only. One READ of the Cin7 sale, then a permanent local link. Writes nothing to Cin7. */
export async function linkCin7SaleAction(projectId: string, cin7SaleId: string, revenueAccount: string): Promise<Cin7ActionResult<SaleLinkRow>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    await guardBillingScope(createServiceRoleClient(), orgId, projectId, (await gatesFor(orgId)).isManager);
    const gates = await gatesFor(orgId);
    const db = createServiceRoleClient();
    const instanceId = await singleActiveInstanceId(db, orgId);
    const link = await linkCin7Sale(db, buildCin7Port(db, orgId, instanceId), gates, email ?? "unknown", { orgId, projectId, instanceId, saleId: cin7SaleId, revenueAccount });
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.cin7_sale_linked", summary: "Linked a project to a Cin7 Advanced Sale (read-only check; nothing written to Cin7)", detail: { projectId, saleNumber: link.cin7_sale_number } });
    return { ok: true, data: link };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Manager only, flag-gated, confirmation-gated. Creates ONE Cin7 invoice for ONE approved claim. */
export async function postClaimToCin7Action(projectId: string, claimId: string, confirmation: string): Promise<Cin7ActionResult<{ state: string; message: string; invoiceNumber: string | null }>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    await guardBillingScope(createServiceRoleClient(), orgId, projectId, (await gatesFor(orgId)).isManager);
    const gates = await gatesFor(orgId);
    const db = createServiceRoleClient();
    const link = await loadSaleLink(db, orgId, projectId);
    if (!link) throw new Error("This project has no linked Cin7 Sale. Link one first.");
    const r = await postClaimToCin7(db, buildCin7Port(db, orgId, link.instance_id), gates, email ?? "unknown", { orgId, projectId, claimId, confirmation });
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.claim_cin7_post", summary: `Claim posting to Cin7: ${r.state}`, detail: { projectId, claimId, postingId: r.posting.id, state: r.state, idempotencyKey: r.posting.idempotency_key, invoiceNumber: r.posting.cin7_invoice_number } });
    return { ok: true, data: { state: r.state, message: r.message, invoiceNumber: r.posting.cin7_invoice_number } };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Manager only. READ-ONLY against Cin7 (a single GET). */
export async function reconcileClaimPostingAction(projectId: string, claimId: string): Promise<Cin7ActionResult<{ state: string; message: string }>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    await guardBillingScope(createServiceRoleClient(), orgId, projectId, (await gatesFor(orgId)).isManager);
    const gates = await gatesFor(orgId);
    const db = createServiceRoleClient();
    const link = await loadSaleLink(db, orgId, projectId);
    if (!link) throw new Error("This project has no linked Cin7 Sale.");
    const r = await reconcileClaimPosting(db, buildCin7Port(db, orgId, link.instance_id), gates, { orgId, projectId, claimId });
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.claim_cin7_reconcile", summary: `Reconciled a claim posting: ${r.state} (read-only against Cin7)`, detail: { projectId, claimId, postingId: r.posting.id, state: r.state } });
    return { ok: true, data: { state: r.state, message: r.message } };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

// ── Advanced Sale creation ──────────────────────────────────────────────────

export interface ProposedSaleLine { sku: string; name: string; quantity: number }
export interface Cin7SaleCreationStatus {
  gates: WriteGates;
  creation: CreationRow | null;
  /** True when a Sale is already linked to this project (by creation or manually). */
  linked: boolean;
  /** Physical products read from the project's frozen baseline (lines that carry a SKU). A starting point the manager reviews, never sent unseen. */
  proposedLines: ProposedSaleLine[];
  /** Baseline lines that have NO Cin7 SKU: they cannot be on the Sale until mapped (UNMAPPED_SKU). */
  unmappedLines: string[];
}

const CHARGE_KEYS = new Set(["delivery", "installation", "concrete_slat_delivery"]);

/** Read-only: the creation state and the proposal derived from the project's frozen baseline. */
export async function getCin7SaleCreationStatusAction(projectId: string): Promise<Cin7ActionResult<Cin7SaleCreationStatus>> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    await guardBillingScope(createServiceRoleClient(), orgId, projectId, (await gatesFor(orgId)).isManager);
    const db = createServiceRoleClient();
    const p = await db.from("projects").select("baseline_snapshot").eq("org_id", orgId).eq("id", projectId).maybeSingle();
    if (p.error) throw new Error(p.error.message);
    const lines = ((p.data as { baseline_snapshot?: { lines?: Array<{ sku: string | null; description: string; quantity: number; lineRef: string }> } } | null)?.baseline_snapshot?.lines) ?? [];
    const proposedLines = lines.filter((l) => l.sku && l.quantity > 0).map((l) => ({ sku: l.sku as string, name: l.description, quantity: l.quantity }));
    const unmappedLines = lines.filter((l) => !l.sku && !CHARGE_KEYS.has(l.lineRef)).map((l) => l.description);
    return { ok: true, data: { gates: await gatesFor(orgId), creation: await loadCreation(db, orgId, projectId), linked: (await loadSaleLink(db, orgId, projectId).catch(() => null)) !== null, proposedLines, unmappedLines } };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Manager only, flag-gated, confirmation-gated. Creates ONE Cin7 Advanced Sale for the project (at most once; see the store). */
export async function createCin7SaleAction(
  projectId: string,
  input: { confirmation: string; customerName: string; location: string; revenueAccount: string; physicalLines: CreationProductInput[] },
): Promise<Cin7ActionResult<{ state: string; message: string; saleNumber: string | null; linked: boolean }>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    await guardBillingScope(createServiceRoleClient(), orgId, projectId, (await gatesFor(orgId)).isManager);
    const gates = await gatesFor(orgId);
    const db = createServiceRoleClient();
    const instanceId = await singleActiveInstanceId(db, orgId);
    const r = await createSaleForProject(db, buildSaleCreationPort(db, orgId, instanceId), gates, email ?? "unknown", { orgId, projectId, instanceId, ...input });
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.cin7_sale_create", summary: `Cin7 Advanced Sale creation: ${r.state}`, detail: { projectId, creationId: r.creation.id, state: r.state, externalId: r.creation.external_id, saleNumber: r.creation.cin7_sale_number } });
    return { ok: true, data: { state: r.state, message: r.message, saleNumber: r.creation.cin7_sale_number, linked: r.linked } };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Manager only. READ-ONLY against Cin7; links a Sale only when it reads back exactly as planned. */
export async function reconcileCin7SaleCreationAction(projectId: string): Promise<Cin7ActionResult<{ state: string; message: string; linked: boolean }>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    await guardBillingScope(createServiceRoleClient(), orgId, projectId, (await gatesFor(orgId)).isManager);
    const gates = await gatesFor(orgId);
    const db = createServiceRoleClient();
    const existing = await loadCreation(db, orgId, projectId);
    if (!existing) throw new Error("No Sale creation has been attempted for this project.");
    const r = await reconcileSaleCreation(db, buildSaleCreationPort(db, orgId, existing.instance_id), gates, email ?? "unknown", { orgId, projectId });
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.cin7_sale_create_reconcile", summary: `Reconciled a Cin7 Sale creation: ${r.state} (read-only against Cin7)`, detail: { projectId, creationId: r.creation.id, state: r.state } });
    return { ok: true, data: { state: r.state, message: r.message, linked: r.linked } };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Manager only. READ-ONLY (GETs): P0 prerequisite check for a disposable customer and the SKUs. Stores and writes nothing. */
export async function checkCin7PrerequisitesAction(customerName: string, skus: string[]): Promise<Cin7ActionResult<PrerequisiteReport>> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    const gates = await gatesFor(orgId);
    if (!gates.orgEnabled) throw new Error("Cin7 Sale creation is not enabled for this organization.");
    const db = createServiceRoleClient();
    const instanceId = await singleActiveInstanceId(db, orgId);
    return { ok: true, data: await checkSalePrerequisites(buildSaleCreationPort(db, orgId, instanceId), gates, { customerName, skus }) };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}
