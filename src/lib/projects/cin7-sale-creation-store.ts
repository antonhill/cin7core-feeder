import "server-only";
// Projects -> Cin7: Advanced Sale CREATION (persistence + orchestration). Imports NOTHING from src/cin7 and never calls fetch: it talks to
// Cin7 only through the injected `SaleCreationPort` (the real adapter is cin7-sale-creation-adapter.ts), so every rule is testable offline
// and the write boundary stays in one named place. Every query is org-scoped.
//
// The sequence is deliberate: gates -> eligibility -> READ-ONLY checks (customer, SKUs) -> persist the intent (unique per project = the
// lock) -> ONE external create -> record the outcome -> READ BACK and verify -> only then link the Sale to the project.
import type { createServiceRoleClient } from "@/supabase/server";
import {
  CREATE_CONFIRMATION_TEXT, SALE_MESSAGES, buildCreationPlan, isStaleCreationPending, verifyCreatedSale,
  type CreationPlan, type CreationProductInput, type SaleReadBack,
} from "./cin7-sale-creation";
import type { WriteGates } from "./cin7-posting-store";
import { effectiveScope, scopeFromSnapshot } from "./product-scope";

type Db = ReturnType<typeof createServiceRoleClient>;
function fail(message: string): never {
  throw new Error(message);
}

export type CreationState = "PENDING" | "CREATED" | "RECONCILED" | "FAILED_CONFIRMED_NO_WRITE" | "FAILED_UNCERTAIN";

export type SaleCreateOutcome =
  | { kind: "created"; saleId: string; saleNumber: string | null }
  | { kind: "rejected"; httpStatus: number; message: string }
  | { kind: "uncertain"; reason: string; saleId: string | null; saleNumber: string | null; stage: "HEADER_UNKNOWN" | "HEADER_CREATED" };

export interface SaleCreationPort {
  customerExists(name: string): Promise<boolean>;
  /** Cin7 ProductID by SKU, plus SKUs that do not exist. Read-only. */
  resolveProducts(skus: string[]): Promise<{ ids: Map<string, string>; missing: string[] }>;
  /** The ONE create call (header + order). Must be sent at most once per attempt. */
  createSale(req: {
    header: { customer: string; location: string; saleOrderDate: string; taxRule: string; externalId: string };
    lines: Array<{ productId: string; sku: string; name: string; quantity: number; taxRule: string }>;
    charges: Array<{ description: string; priceExVat: number; taxAmount: number; taxRule: string; account: string }>;
  }): Promise<SaleCreateOutcome>;
  /** SKUs (of those given) that are Bill-of-Material / assembly products. Read-only. */
  assemblySkus(skus: string[]): Promise<string[]>;
  /** The customer's sale defaults by EXACT name, or null. Read-only (P0). */
  customerDefaults(name: string): Promise<{ taxRule: string | null; revenueAccount: string | null; location: string | null } | null>;
  /** Availability rows for one SKU. Read-only (P0). */
  stockAt(sku: string): Promise<Array<{ location: string | null; available: number | null }>>;
  readSale(saleId: string): Promise<SaleReadBack>;
  findByExternalId(customer: string, externalId: string, sinceIso: string): Promise<Array<{ saleId: string; saleNumber: string | null }>>;
}

export interface CreationRow {
  id: string; project_id: string; instance_id: string; sale_role: "BASE" | "VARIATION"; external_id: string; request_fingerprint: string;
  creation_state: CreationState; attempt_count: number; plan: CreationPlan; contract_ex_vat_cents: number;
  cin7_sale_id: string | null; cin7_sale_number: string | null; progress: "NONE" | "HEADER" | "DONE";
  requested_by_email: string; requested_at: string; completed_at: string | null; verified_at: string | null;
  last_error_code: string | null; last_error_message: string | null; evidence: unknown;
}
export interface CreateResult { creation: CreationRow; state: CreationState; message: string; alreadyCreated: boolean; linked: boolean }

const trunc = (s: string) => s.replace(/\s+/g, " ").slice(0, 500);
const rands = (c: number) => c / 100;
const todayStr = (now: Date) => now.toISOString().slice(0, 10);

export async function loadCreation(db: Db, orgId: string, projectId: string): Promise<CreationRow | null> {
  const r = await db.from("project_cin7_sale_creations").select("*").eq("org_id", orgId).eq("project_id", projectId).maybeSingle();
  if (r.error) {
    if (/does not exist|schema cache/i.test(r.error.message)) return null; // deploy-order safety (migration 0105 not applied yet)
    fail(`load sale creation: ${r.error.message}`);
  }
  return (r.data as CreationRow | null) ?? null;
}

async function linkVerifiedSale(db: Db, row: CreationRow, view: SaleReadBack, number: string | null, email: string): Promise<void> {
  const ins = await db.from("project_cin7_sale_links").insert({
    org_id: (row as unknown as { org_id: string }).org_id, project_id: row.project_id, instance_id: row.instance_id, cin7_sale_id: view.id, cin7_sale_number: number,
    link_status: "LINKED", tax_rule: row.plan.taxRule, revenue_account: row.plan.revenueAccount,
    sale_snapshot: { type: view.type, orderStatus: view.orderStatus, invoiceCount: view.invoiceCount, createdByToolbox: true, externalId: row.external_id },
    linked_by_email: email, ...(row.sale_role === "VARIATION" ? { sale_role: "VARIATION" } : {}),
  }).select("id").single();
  if (ins.error) fail(`link created sale: ${ins.error.message}`);
}

/** Read the Sale back, verify it, and (only if it matches the plan exactly) link it and mark the intent RECONCILED. Never writes to Cin7. */
async function verifyAndLink(db: Db, port: SaleCreationPort, orgId: string, row: CreationRow, saleId: string, number: string | null, email: string, now: Date): Promise<CreateResult> {
  let view: SaleReadBack;
  try { view = await port.readSale(saleId); } catch { view = null as unknown as SaleReadBack; }
  if (!view) {
    const u = await db.from("project_cin7_sale_creations").update({ last_error_code: "READBACK_FAILED", last_error_message: "The Sale could not be read back; it was NOT linked. Reconcile." }).eq("org_id", orgId).eq("id", row.id).select("*");
    return { creation: (u.data as CreationRow[] | null)?.[0] ?? row, state: row.creation_state, message: "The Sale could not be read back; it was NOT linked. Reconcile.", alreadyCreated: true, linked: false };
  }
  const diffs = verifyCreatedSale(row.plan, view);
  if (diffs.length) {
    const msg = trunc(`${SALE_MESSAGES.verification} ${diffs.join("; ")}.`);
    const u = await db.from("project_cin7_sale_creations").update({ last_error_code: "VERIFICATION_FAILED", last_error_message: msg, evidence: { checkedAt: now.toISOString(), differences: diffs } }).eq("org_id", orgId).eq("id", row.id).select("*");
    return { creation: (u.data as CreationRow[] | null)?.[0] ?? row, state: row.creation_state, message: msg, alreadyCreated: true, linked: false };
  }
  await linkVerifiedSale(db, { ...row, org_id: orgId } as CreationRow, view, number ?? row.cin7_sale_number, email);
  const u = await db.from("project_cin7_sale_creations").update({ creation_state: "RECONCILED", verified_at: now.toISOString(), last_error_code: null, last_error_message: null, evidence: { method: "READ_BACK_VERIFIED", checkedAt: now.toISOString() } })
    .eq("org_id", orgId).eq("id", row.id).eq("creation_state", "CREATED").select("*");
  if (u.error || !u.data?.length) fail("The creation record changed while verifying; reconcile again.");
  return { creation: (u.data as CreationRow[])[0], state: "RECONCILED", message: `Created and verified in Cin7 as ${number ?? view.id}, and linked to the project.`, alreadyCreated: true, linked: true };
}

export interface CreateInput {
  orgId: string; projectId: string; instanceId: string; confirmation: string; customerName: string; location: string; revenueAccount: string;
  /** The tax rule's NAME as Cin7 knows it (e.g. "Standard Rate Sales"). The project's own tax_rule is a Toolbox label and is never sent to Cin7. The VAT RATE still comes from the project. */
  cin7TaxRule: string;
  now?: Date;
}

export async function createSaleForProject(db: Db, port: SaleCreationPort, gates: WriteGates, email: string, input: CreateInput): Promise<CreateResult> {
  const now = input.now ?? new Date();
  if (!gates.writesEnabled) fail("Cin7 writes are switched off (NEWQUIP_CIN7_WRITES_ENABLED).");
  if (!gates.orgEnabled) fail("Cin7 Sale creation is not enabled for this organization.");
  if (!gates.isManager) fail("Only a manager (org owner/admin) can create a Cin7 Sale.");
  if (input.confirmation !== CREATE_CONFIRMATION_TEXT) fail("The confirmation was not given.");

  const p = await db.from("projects").select("id, status, project_reference, tax_rule, tax_rate_bps, original_contract_cents, billing_scope, baseline_snapshot").eq("org_id", input.orgId).eq("id", input.projectId).maybeSingle();
  if (p.error) fail(p.error.message);
  if (!p.data) fail("Project not found.");
  const project = p.data as { status: string; project_reference: string; tax_rule: string | null; tax_rate_bps: number; original_contract_cents: number; billing_scope?: string; baseline_snapshot?: unknown };
  if (project.status !== "ACTIVE") fail("Only an ACTIVE project can have a Cin7 Sale created.");
  const role = project.billing_scope === "VARIATION" ? "VARIATION" : "BASE";

  // Replay / concurrency: an existing intent answers before anything else; an existing link without one means there is nothing to create.
  const existing = await loadCreation(db, input.orgId, input.projectId);
  if (existing && (existing.creation_state === "CREATED" || existing.creation_state === "RECONCILED")) {
    return { creation: existing, state: existing.creation_state, message: "A Cin7 Sale was already created for this project. Nothing was sent.", alreadyCreated: true, linked: existing.creation_state === "RECONCILED" };
  }
  const link = await db.from("project_cin7_sale_links").select("id, cin7_sale_id").eq("org_id", input.orgId).eq("project_id", input.projectId).maybeSingle();
  if (link.error) fail(link.error.message);
  if (link.data) fail("This project already has a linked Cin7 Sale; nothing to create.");
  if (existing?.creation_state === "PENDING") fail(isStaleCreationPending(existing.requested_at, now.getTime()) ? `${SALE_MESSAGES.uncertain} (a previous attempt never finished - reconcile it.)` : SALE_MESSAGES.inFlight);
  if (existing?.creation_state === "FAILED_UNCERTAIN") fail(SALE_MESSAGES.uncertain);

  const st = await db.from("project_stages").select("name, value_cents, sort_order").eq("org_id", input.orgId).eq("project_id", input.projectId);
  if (st.error) fail(st.error.message);
  const stages = ((st.data ?? []) as Array<{ name: string; value_cents: number; sort_order: number }>).sort((a, b) => a.sort_order - b.sort_order).map((s) => ({ name: s.name, valueCents: s.value_cents }));
  if (!input.cin7TaxRule.trim()) fail("Enter the Cin7 tax rule name (it must match a tax rule in Cin7 exactly).");

  // The physical lines come from the project's APPROVED PRODUCT SCOPE, never from typing. Anything unmapped and unresolved stops the creation.
  const scope = effectiveScope(scopeFromSnapshot(project.baseline_snapshot));
  if (scope.blockers.length) fail(`The project's product scope is not ready for a Cin7 Sale. Resolve these first (map to a real SKU, or exclude with a reason): ${scope.blockers.join(" | ")}`);
  const physicalLines: CreationProductInput[] = scope.lines.map((l) => ({ sku: l.sku, name: l.description, quantity: l.quantity }));
  const built = buildCreationPlan({
    projectRef: project.project_reference, role, customerName: input.customerName, location: input.location, taxRule: input.cin7TaxRule, taxRateBps: project.tax_rate_bps,
    revenueAccount: input.revenueAccount, contractCents: project.original_contract_cents, stages, physicalLines, saleOrderDate: todayStr(now),
  });
  if (!built.ok) fail(built.error);
  const plan = built.plan;
  if (existing && existing.request_fingerprint !== built.fingerprint && existing.plan.saleOrderDate !== plan.saleOrderDate) {
    // The only field that legitimately moves between attempts is the date; compare everything else.
    const a = { ...existing.plan, saleOrderDate: "" }; const b = { ...plan, saleOrderDate: "" };
    if (JSON.stringify(a) !== JSON.stringify(b)) fail("The plan no longer matches the original request; refusing to re-send.");
  } else if (existing && existing.request_fingerprint !== built.fingerprint) fail("The plan no longer matches the original request; refusing to re-send.");

  // READ-ONLY validation against Cin7 BEFORE any intent is stored.
  if (!(await port.customerExists(plan.customer))) fail(`The customer "${plan.customer}" does not exist in Cin7. Create it in Cin7 first (Toolbox never creates customers).`);
  const resolved = await port.resolveProducts(plan.lines.map((l) => l.sku));
  if (resolved.missing.length) fail(`These SKUs do not exist in Cin7: ${resolved.missing.join(", ")}. Nothing was sent.`);

  // PERSIST INTENT FIRST. unique(project_id) is the lock; a retry is a compare-and-set on the row's state.
  let row: CreationRow;
  if (!existing) {
    const ins = await db.from("project_cin7_sale_creations").insert({
      org_id: input.orgId, project_id: input.projectId, instance_id: input.instanceId, sale_role: role, external_id: plan.externalId, request_fingerprint: built.fingerprint,
      creation_state: "PENDING", attempt_count: 1, plan, contract_ex_vat_cents: plan.contractCents, progress: "NONE", requested_by_email: email, requested_at: now.toISOString(),
    }).select("*").single();
    if (ins.error || !ins.data) {
      if (/duplicate key|unique/i.test(ins.error?.message ?? "")) fail(SALE_MESSAGES.inFlight);
      fail(`record creation intent: ${ins.error?.message ?? "no row"}`);
    }
    row = ins.data as CreationRow;
  } else {
    const up = await db.from("project_cin7_sale_creations").update({ creation_state: "PENDING", attempt_count: existing.attempt_count + 1, requested_by_email: email, requested_at: now.toISOString(), last_error_code: null, last_error_message: null })
      .eq("org_id", input.orgId).eq("id", existing.id).eq("creation_state", "FAILED_CONFIRMED_NO_WRITE").select("*");
    if (up.error) fail(up.error.message);
    if (!up.data?.length) fail(SALE_MESSAGES.inFlight);
    row = (up.data as CreationRow[])[0];
  }

  // THE ONE EXTERNAL CALL (header + order, each at most once).
  let outcome: SaleCreateOutcome;
  try {
    outcome = await port.createSale({
      header: { customer: plan.customer, location: plan.location, saleOrderDate: plan.saleOrderDate, taxRule: plan.taxRule, externalId: plan.externalId },
      lines: plan.lines.map((l) => ({ productId: resolved.ids.get(l.sku)!, sku: l.sku, name: l.name, quantity: l.quantity, taxRule: plan.taxRule })),
      charges: plan.charges.map((c) => ({ description: c.description, priceExVat: rands(c.amountCents), taxAmount: rands(c.taxCents), taxRule: plan.taxRule, account: plan.revenueAccount })),
    });
  } catch {
    outcome = { kind: "uncertain", reason: "Unexpected error while calling Cin7.", saleId: null, saleNumber: null, stage: "HEADER_UNKNOWN" };
  }

  const done = new Date().toISOString();
  const rec = async (patch: Record<string, unknown>, state: CreationState, message: string): Promise<CreateResult> => {
    const u = await db.from("project_cin7_sale_creations").update(patch).eq("org_id", input.orgId).eq("id", row.id).eq("creation_state", "PENDING").select("*");
    if (u.error || !u.data?.length) fail(`${SALE_MESSAGES.uncertain} (the result could not be recorded: ${u.error?.message ?? "state changed"}).`);
    return { creation: (u.data as CreationRow[])[0], state, message, alreadyCreated: false, linked: false };
  };
  if (outcome.kind === "rejected") {
    return rec({ creation_state: "FAILED_CONFIRMED_NO_WRITE", progress: "NONE", last_error_code: outcome.httpStatus ? `HTTP_${outcome.httpStatus}` : "INVALID_REQUEST", last_error_message: trunc(outcome.message), completed_at: done }, "FAILED_CONFIRMED_NO_WRITE", SALE_MESSAGES.safeFailure);
  }
  if (outcome.kind === "uncertain") {
    return rec({
      creation_state: "FAILED_UNCERTAIN", progress: outcome.saleId ? "HEADER" : "NONE", cin7_sale_id: outcome.saleId, cin7_sale_number: outcome.saleNumber,
      last_error_code: outcome.stage === "HEADER_CREATED" ? "ORPHAN_HEADER" : "UNCERTAIN", last_error_message: trunc(outcome.reason), completed_at: done,
    }, "FAILED_UNCERTAIN", SALE_MESSAGES.uncertain);
  }
  // Created: the Sale EXISTS, so nothing below may un-create it or allow a re-send. Record it, then verify and link.
  const created = await rec({ creation_state: "CREATED", progress: "DONE", cin7_sale_id: outcome.saleId, cin7_sale_number: outcome.saleNumber, completed_at: done }, "CREATED", "Created in Cin7; verifying.");
  return verifyAndLink(db, port, input.orgId, created.creation, outcome.saleId, outcome.saleNumber, email, now);
}

// ── reconciliation (READ-ONLY against Cin7) ─────────────────────────────────

export async function reconcileSaleCreation(
  db: Db, port: SaleCreationPort, gates: Pick<WriteGates, "isManager">, email: string, input: { orgId: string; projectId: string; now?: Date },
): Promise<CreateResult> {
  if (!gates.isManager) fail("Only a manager (org owner/admin) can reconcile a Sale creation.");
  const now = input.now ?? new Date();
  let row = await loadCreation(db, input.orgId, input.projectId);
  if (!row) fail("No Sale creation has been attempted for this project; there is nothing to reconcile.");
  if (row.creation_state === "RECONCILED") return { creation: row, state: "RECONCILED", message: "Already reconciled.", alreadyCreated: true, linked: true };
  if (row.creation_state === "FAILED_CONFIRMED_NO_WRITE") return { creation: row, state: row.creation_state, message: SALE_MESSAGES.safeFailure, alreadyCreated: false, linked: false };
  const set = async (patch: Record<string, unknown>, from: CreationState): Promise<CreationRow> => {
    const u = await db.from("project_cin7_sale_creations").update(patch).eq("org_id", input.orgId).eq("id", row!.id).eq("creation_state", from).select("*");
    if (u.error || !u.data?.length) fail("The creation record changed while reconciling; try again.");
    return (u.data as CreationRow[])[0];
  };
  if (row.creation_state === "PENDING") {
    if (!isStaleCreationPending(row.requested_at, now.getTime())) fail(SALE_MESSAGES.inFlight);
    row = await set({ creation_state: "FAILED_UNCERTAIN", last_error_code: "ORPHANED_PENDING", last_error_message: "The attempt never recorded an outcome." }, "PENDING");
  }
  if (row.creation_state === "CREATED") {
    return verifyAndLink(db, port, input.orgId, row, row.cin7_sale_id!, row.cin7_sale_number, email, now);
  }

  // FAILED_UNCERTAIN: locate the Sale (by the recorded id, else by our exact ExternalID) and decide.
  let saleId = row.cin7_sale_id;
  let number = row.cin7_sale_number;
  if (!saleId) {
    const since = new Date(Date.parse(row.requested_at) - 86_400_000).toISOString();
    const found = await port.findByExternalId(row.plan.customer, row.external_id, since);
    if (found.length > 1) fail(`Cin7 holds ${found.length} Sales with this project's ExternalID; refusing to guess. Resolve it in Cin7.`);
    if (found.length === 0) {
      const p = await set({ creation_state: "FAILED_CONFIRMED_NO_WRITE", progress: "NONE", last_error_code: "RECONCILED_NO_SALE", last_error_message: "Reconciliation found no Sale in Cin7. A controlled retry is now permitted.", evidence: { method: "READ_BACK_NO_MATCH", checkedAt: now.toISOString() } }, "FAILED_UNCERTAIN");
      return { creation: p, state: p.creation_state, message: "No Sale exists in Cin7 for this project. A controlled retry is now permitted.", alreadyCreated: false, linked: false };
    }
    saleId = found[0].saleId; number = found[0].saleNumber;
  }
  const view = await port.readSale(saleId);
  const diffs = verifyCreatedSale(row.plan, view);
  if (diffs.length) {
    // A Sale exists but is incomplete or different: NEVER auto-completed, never linked, never retried. A human completes/voids it or links it.
    const msg = trunc(`A Sale (${number ?? saleId}) exists in Cin7 but is not as planned: ${diffs.join("; ")}. Complete or void it in Cin7, or link it deliberately.`);
    const p = await set({ cin7_sale_id: saleId, cin7_sale_number: number, progress: "HEADER", last_error_code: "INCOMPLETE_SALE_FOUND", last_error_message: msg, evidence: { checkedAt: now.toISOString(), differences: diffs } }, "FAILED_UNCERTAIN");
    return { creation: p, state: p.creation_state, message: msg, alreadyCreated: true, linked: false };
  }
  row = await set({ creation_state: "CREATED", progress: "DONE", cin7_sale_id: saleId, cin7_sale_number: number, completed_at: now.toISOString(), last_error_code: null, last_error_message: null }, "FAILED_UNCERTAIN");
  return verifyAndLink(db, port, input.orgId, row, saleId, number, email, now);
}
