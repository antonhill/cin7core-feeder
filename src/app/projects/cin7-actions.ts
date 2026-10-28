"use server";

// Projects -> Cin7 claim posting: Server Actions. Authorisation is re-established inside EVERY action (CCT-ADR-0010) and the write gates
// are derived HERE, on the server: the rollout flag, the rollout org, and the manager role. The UI only displays them.
// This file may export ONLY async functions and erased interfaces ("use server" rule in CLAUDE.md).

import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { logActivity } from "@/lib/activity-log";
import { createServiceRoleClient } from "@/supabase/server";
import { PROJECTS_MODULE } from "@/app/module-nav";
import { prepareInvoiceProposal, type PreparedInvoice } from "@/lib/projects/invoice-proposal-store";
import { loadProjectScope, resolveScopeItem } from "@/lib/projects/scope-store";
import type { ScopeItem } from "@/lib/projects/product-scope";
import { createP0Project, searchProductStock, type CreateP0Input, type ProductSearchResult } from "@/lib/projects/p0-project-store";
import { runP0, type P0Input, type P0Report } from "@/lib/projects/p0-checklist";
import { externalIdFor } from "@/lib/projects/cin7-sale-creation";
import { guardBillingScope } from "@/lib/projects/scope-access";
import { cin7WritesEnabled } from "@/lib/projects/write-flag";
import { NEWQUIP_POC_CIN7_INSTANCE_ID, OPERATIONAL_CUSTOMER_DENYLIST, isNewquipPocOrg } from "@/newquip/access";
import { buildCin7Port, singleActiveInstanceId } from "@/lib/projects/cin7-adapter";
import { buildSaleCreationPort } from "@/lib/projects/cin7-sale-creation-adapter";
import { createSaleForProject, loadCreation, reconcileSaleCreation, type CreationRow } from "@/lib/projects/cin7-sale-creation-store";
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
export async function postClaimToCin7Action(
  projectId: string, claimId: string, confirmation: string,
  physical?: { lines: Array<{ sku: string; quantity: number }>; earlyReason?: string },
): Promise<Cin7ActionResult<{ state: string; message: string; invoiceNumber: string | null }>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    await guardBillingScope(createServiceRoleClient(), orgId, projectId, (await gatesFor(orgId)).isManager);
    const gates = await gatesFor(orgId);
    const db = createServiceRoleClient();
    const link = await loadSaleLink(db, orgId, projectId);
    if (!link) throw new Error("This project has no linked Cin7 Sale. Link one first.");
    const r = await postClaimToCin7(db, buildCin7Port(db, orgId, link.instance_id), gates, email ?? "unknown", {
      orgId, projectId, claimId, confirmation, ...(physical && physical.lines.length ? { physicalLines: physical.lines, earlyReason: physical.earlyReason } : {}),
    });
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.claim_cin7_post", summary: `Claim posting to Cin7: ${r.state}`, detail: { projectId, claimId, postingId: r.posting.id, state: r.state, idempotencyKey: r.posting.idempotency_key, invoiceNumber: r.posting.cin7_invoice_number, physicalLines: r.posting.physical_lines ?? null } });
    return { ok: true, data: { state: r.state, message: r.message, invoiceNumber: r.posting.cin7_invoice_number } };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/**
 * Manager only. READ-ONLY (one Cin7 GET): the proposed invoice for an approved claim - the commercial charges, and the physical product lines at R0
 * that the project's approved scope and Cin7's verified shipments make eligible. A proposal for review; it posts nothing.
 */
export async function getInvoiceProposalAction(projectId: string, claimId: string): Promise<Cin7ActionResult<PreparedInvoice>> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    const gates = await gatesFor(orgId);
    await guardBillingScope(createServiceRoleClient(), orgId, projectId, gates.isManager);
    if (!gates.orgEnabled) throw new Error("Not enabled for this organization.");
    if (!gates.isManager) throw new Error("Only a manager (org owner/admin) can prepare an invoice.");
    const db = createServiceRoleClient();
    const link = await loadSaleLink(db, orgId, projectId);
    if (!link) throw new Error("This project has no linked Cin7 Sale. Link or create one first.");
    return { ok: true, data: await prepareInvoiceProposal(db, buildCin7Port(db, orgId, link.instance_id), { orgId, projectId, claimId }) };
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

export interface Cin7SaleCreationStatus {
  gates: WriteGates;
  creation: CreationRow | null;
  /** True when a Sale is already linked to this project (by creation or manually). */
  linked: boolean;
  /** The project's approved product scope as inherited from its quotation (or variation), customer-safe: no cost or margin. */
  scopeItems: ScopeItem[];
  /** What the Sales Order will contain (derived, one line per SKU, at R0), what is blocking it, and what was deliberately excluded. */
  saleLines: Array<{ sku: string; quantity: number; description: string }>;
  blockers: string[];
  excluded: Array<{ id: string; description: string; reason: string }>;
}

/** Read-only: the creation state and the Sale lines derived from the project's approved product scope. */
export async function getCin7SaleCreationStatusAction(projectId: string): Promise<Cin7ActionResult<Cin7SaleCreationStatus>> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    await guardBillingScope(createServiceRoleClient(), orgId, projectId, (await gatesFor(orgId)).isManager);
    const db = createServiceRoleClient();
    const { items, effective } = await loadProjectScope(db, orgId, projectId);
    return { ok: true, data: {
      gates: await gatesFor(orgId), creation: await loadCreation(db, orgId, projectId), linked: (await loadSaleLink(db, orgId, projectId).catch(() => null)) !== null,
      scopeItems: items, saleLines: effective.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, description: l.description })), blockers: effective.blockers, excluded: effective.excluded,
    } };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/**
 * Manager only. Resolves an UNMAPPED scope item: map it to a real Cin7 SKU (verified live, read-only) or exclude it from the Sales Order, with a
 * reason. Audited. Allowed only before any claim or Cin7 Sale exists. This is the only way the inherited scope can change.
 */
export async function resolveScopeItemAction(projectId: string, input: { itemId: string; kind: "MAP" | "EXCLUDE"; sku?: string; quantity?: number; reason: string }): Promise<Cin7ActionResult<ScopeItem[]>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    const gates = await gatesFor(orgId);
    await guardBillingScope(createServiceRoleClient(), orgId, projectId, gates.isManager);
    if (!gates.orgEnabled) throw new Error("Not enabled for this organization.");
    const db = createServiceRoleClient();
    const inst = await db.from("cin7_instances").select("id, name").eq("org_id", orgId).eq("active", true);
    if (inst.error) throw new Error(inst.error.message);
    const list = (inst.data ?? []) as Array<{ id: string; name: string }>;
    if (input.kind === "MAP" && (list.length !== 1 || list[0].id !== NEWQUIP_POC_CIN7_INSTANCE_ID)) throw new Error("The SKU can only be verified against the single expected NewQuip POC Cin7 instance; it is not.");
    const port = input.kind === "MAP" ? buildSaleCreationPort(db, orgId, list[0].id) : { resolveProducts: async () => ({ ids: new Map<string, string>(), missing: [] as string[] }) };
    const items = await resolveScopeItem(db, port, { isManager: gates.isManager }, email ?? "unknown", { orgId, projectId, ...input });
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.scope_item_resolved", summary: `Resolved an unmapped product scope item (${input.kind}; no Cin7 write)`, detail: { projectId, itemId: input.itemId, kind: input.kind, sku: input.sku ?? null, quantity: input.quantity ?? null, reason: input.reason } });
    return { ok: true, data: items };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Manager only, flag-gated, confirmation-gated. Creates ONE Cin7 Advanced Sale for the project (at most once; see the store). */
export async function createCin7SaleAction(
  projectId: string,
  input: { confirmation: string; customerName: string; location: string; revenueAccount: string; cin7TaxRule: string },
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

/**
 * Manager only. READ-ONLY (GETs): the P0 acceptance checklist. It never picks a customer, instance or database: anything not exactly as
 * asked is reported as a FAIL, and checks that depend on it are NOT_RUN. Stores and writes nothing.
 */
export async function runP0ChecklistAction(projectId: string, input: Omit<P0Input, "externalId">): Promise<Cin7ActionResult<P0Report>> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    await guardBillingScope(createServiceRoleClient(), orgId, projectId, (await gatesFor(orgId)).isManager);
    const gates = await gatesFor(orgId);
    if (!gates.isManager) throw new Error("Only a manager (org owner/admin) can run the P0 checklist.");
    if (!gates.orgEnabled) throw new Error("Cin7 Sale creation is not enabled for this organization.");
    const db = createServiceRoleClient();
    const proj = await db.from("projects").select("project_reference").eq("org_id", orgId).eq("id", projectId).maybeSingle();
    if (proj.error || !proj.data) throw new Error("Project not found.");
    const inst = await db.from("cin7_instances").select("id, name").eq("org_id", orgId).eq("active", true);
    if (inst.error) throw new Error(inst.error.message);
    const report = await runP0(
      {
        env: process.env, instances: (inst.data ?? []) as Array<{ id: string; name: string }>, expectedInstanceId: NEWQUIP_POC_CIN7_INSTANCE_ID, denylist: OPERATIONAL_CUSTOMER_DENYLIST,
        portFor: (instanceId) => buildSaleCreationPort(db, orgId, instanceId),
      },
      { ...input, externalId: externalIdFor((proj.data as { project_reference: string }).project_reference) },
    );
    return { ok: true, data: report };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

// ── Disposable P0 project ───────────────────────────────────────────────────

export interface P0PrepStatus { enabled: boolean; isManager: boolean }

/** Whether this user should see the P0 preparation panel. Display only; every action below re-checks. */
export async function getP0PrepStatusAction(): Promise<Cin7ActionResult<P0PrepStatus>> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    const g = await gatesFor(orgId);
    return { ok: true, data: { enabled: g.orgEnabled, isManager: g.isManager } };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Manager only. Existing Cin7 products with free stock at a location, from the synced local cache. Reads Supabase only; no Cin7 call. */
export async function searchP0ProductsAction(location: string, query: string): Promise<Cin7ActionResult<ProductSearchResult>> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    const g = await gatesFor(orgId);
    if (!g.orgEnabled) throw new Error("Not enabled for this organization.");
    if (!g.isManager) throw new Error("Only a manager (org owner/admin) can prepare a P0 project.");
    return { ok: true, data: await searchProductStock(createServiceRoleClient(), orgId, location, query) };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/**
 * Manager only. Creates a SEPARATE disposable Toolbox project from existing Cin7 SKUs chosen by the owner, a test contract and a milestone
 * schedule. Verifies the SKUs and free stock live (GET only) against the one expected Cin7 instance - never another. Writes nothing to Cin7;
 * creates no Sale, customer or document; touches no existing quotation or project.
 */
export async function createP0ProjectAction(input: CreateP0Input): Promise<Cin7ActionResult<{ projectId: string; reference: string }>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    const g = await gatesFor(orgId);
    if (!g.orgEnabled) throw new Error("Not enabled for this organization.");
    if (!g.isManager) throw new Error("Only a manager (org owner/admin) can prepare a P0 project.");
    const db = createServiceRoleClient();
    const inst = await db.from("cin7_instances").select("id, name").eq("org_id", orgId).eq("active", true);
    if (inst.error) throw new Error(inst.error.message);
    const list = (inst.data ?? []) as Array<{ id: string; name: string }>;
    if (list.length !== 1 || list[0].id !== NEWQUIP_POC_CIN7_INSTANCE_ID) {
      throw new Error(list.length === 0 ? "No active Cin7 instance." : list.length > 1 ? `${list.length} active Cin7 instances; P0 will not choose one.` : `The active Cin7 instance is "${list[0].name}", not the NewQuip POC instance.`);
    }
    const r = await createP0Project(db, buildSaleCreationPort(db, orgId, list[0].id), { isManager: g.isManager }, email ?? "unknown", OPERATIONAL_CUSTOMER_DENYLIST, { ...input, orgId });
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.p0_project_created", summary: "Created a disposable P0 acceptance project (Toolbox rows only; no Cin7 write)", detail: { projectId: r.projectId, reference: r.reference, skus: input.products.map((p) => p.sku) } });
    return { ok: true, data: r };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}
