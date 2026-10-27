"use server";

// Projects -> Cin7 claim posting: Server Actions. Authorisation is re-established inside EVERY action (CCT-ADR-0010) and the write gates
// are derived HERE, on the server: the rollout flag, the rollout org, and the manager role. The UI only displays them.
// This file may export ONLY async functions and erased interfaces ("use server" rule in CLAUDE.md).

import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { logActivity } from "@/lib/activity-log";
import { createServiceRoleClient } from "@/supabase/server";
import { PROJECTS_MODULE } from "@/app/module-nav";
import { isNewquipPocOrg } from "@/newquip/access";
import { buildCin7Port, singleActiveInstanceId } from "@/lib/projects/cin7-adapter";
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
    writesEnabled: process.env.NEWQUIP_CIN7_WRITES_ENABLED === "true",
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
