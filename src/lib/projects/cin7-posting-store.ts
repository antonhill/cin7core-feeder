import "server-only";
// Projects -> Cin7 claim posting: persistence + orchestration. This module imports NOTHING from src/cin7 and never calls fetch: it
// talks to Cin7 only through the injected `Cin7Port` (the real adapter is cin7-adapter.ts), so every rule here is testable without
// a network and the write boundary stays in one small, named place. Every query is org-scoped.
//
// The sequence for a send is deliberate:
//   gates -> eligibility -> persist PENDING (unique per claim = the concurrency lock) -> ONE external call -> record the outcome.
import type { createServiceRoleClient } from "@/supabase/server";
import {
  MESSAGES, POST_CONFIRMATION_TEXT, amountDifferences, buildPostingPlan, canSend, isStalePending, matchInvoices, rands,
  resolvePhysicalLines, type OrderLineView, type PhysicalSelection, type ResolvedPhysicalLine, type PostingClaim, type PostingClaimLine, type PostingDisplayState, type PostingState, type ReadInvoice,
} from "./cin7-posting";
import { proposeInvoice, validateSelection } from "./invoice-proposal";

type Db = ReturnType<typeof createServiceRoleClient>;

// ── the port (structurally identical to src/cin7/sale-invoice-write.ts; declared here so this module has no Cin7 import) ──
export interface InvoiceRequest {
  saleId: string; memo: string; invoiceDate: string; invoiceDueDate: string; taxRule: string; account: string;
  /** `taxAmount` is the VAT in rands (a monetary amount, NOT a percentage). */
  charges: Array<{ description: string; priceExVat: number; taxAmount: number; comment?: string }>;
  /** Physical products at R0 (empty for deposit-only / commercial-only). */
  lines?: Array<{ productId: string; sku: string; name: string; quantity: number }>;
}
export type InvoiceOutcome =
  | { kind: "created"; invoiceNumber: string; taskId: string; status: string; totalBeforeTax: number | null; tax: number | null; total: number | null }
  | { kind: "rejected"; httpStatus: number; message: string }
  | { kind: "uncertain"; reason: string };
export interface Cin7SaleView { id: string; saleNumber: string | null; type: string | null; orderStatus: string | null; taxRule: string | null; invoices: ReadInvoice[]; orderLines?: OrderLineView[];
  /** Verified shipped quantity per SKU from fulfilments whose Ship step is authorised / shipped (null = unreadable). Undefined = not read. */
  shipped?: Record<string, number | null> }
export interface Cin7Port {
  fetchSale(saleId: string): Promise<Cin7SaleView>;
  createInvoice(req: InvoiceRequest): Promise<InvoiceOutcome>;
}

export interface PostingRow {
  id: string; claim_id: string; sale_link_id: string; idempotency_key: string; request_fingerprint: string; memo: string;
  posting_state: PostingState; attempt_count: number; amount_ex_vat_cents: number; tax_cents: number; total_cents: number;
  cin7_sale_id: string; cin7_invoice_number: string | null; cin7_task_id: string | null; cin7_status: string | null;
  requested_by_email: string; requested_at: string; completed_at: string | null; reconciled_at: string | null;
  last_error_code: string | null; last_error_message: string | null;
  /** Physical products on the invoice (R0). Column added by migration 0105; absent on rows written before it. */
  physical_lines?: Array<{ sku: string; quantity: number; earlyReason?: string }> | null;
}
export interface SaleLinkRow {
  id: string; project_id: string; instance_id: string; cin7_sale_id: string; cin7_sale_number: string | null; link_status: string;
  tax_rule: string; revenue_account: string; linked_by_email: string; created_at: string; last_reconciled_at: string | null;
}

/** Server-derived permissions for the caller. Computed by the Server Action (NEVER by the browser). */
export interface WriteGates {
  /** NEWQUIP_CIN7_WRITES_ENABLED === "true" */
  writesEnabled: boolean;
  /** The org is one the writer is rolled out to (NewQuip POC). */
  orgEnabled: boolean;
  /** The caller is a manager (org owner/admin). */
  isManager: boolean;
}

function fail(message: string): never {
  throw new Error(message);
}

export interface PostResult { posting: PostingRow; state: PostingDisplayState; message: string; alreadyPosted: boolean }

// ── reads ───────────────────────────────────────────────────────────────────

export async function loadSaleLink(db: Db, orgId: string, projectId: string): Promise<SaleLinkRow | null> {
  const r = await db.from("project_cin7_sale_links").select("*").eq("org_id", orgId).eq("project_id", projectId).maybeSingle();
  if (r.error) fail(`load sale link: ${r.error.message}`);
  return (r.data as SaleLinkRow | null) ?? null;
}

export async function listPostings(db: Db, orgId: string, projectId: string): Promise<PostingRow[]> {
  const r = await db.from("project_claim_cin7_postings").select("*").eq("org_id", orgId).eq("project_id", projectId);
  if (r.error) {
    if (/does not exist|schema cache/i.test(r.error.message)) return []; // deploy-order safety (migration 0104 not applied yet)
    fail(`load postings: ${r.error.message}`);
  }
  return (r.data ?? []) as PostingRow[];
}

// ── Sale link ───────────────────────────────────────────────────────────────

/**
 * Links the Project to ONE existing Cin7 Advanced Sale (read-only against Cin7: a single GET). Permanent once linked. Verifies the
 * Sale really is an Advanced Sale that is AUTHORISED and carries a tax rule; the revenue account is supplied explicitly by the
 * manager (never guessed).
 */
export async function linkCin7Sale(
  db: Db, port: Cin7Port, gates: Pick<WriteGates, "orgEnabled" | "isManager">, email: string,
  input: { orgId: string; projectId: string; instanceId: string; saleId: string; revenueAccount: string },
): Promise<SaleLinkRow> {
  if (!gates.orgEnabled) fail("Cin7 posting is not enabled for this organization.");
  if (!gates.isManager) fail("Only a manager (org owner/admin) can link a Cin7 Sale.");
  const saleId = input.saleId.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(saleId)) fail("Enter the Cin7 SaleID (a GUID, from the sale's URL in Cin7).");
  if (!input.revenueAccount.trim()) fail("The Cin7 revenue account code is required.");
  const p = await db.from("projects").select("id, status, billing_scope").eq("org_id", input.orgId).eq("id", input.projectId).maybeSingle();
  if (p.error) fail(p.error.message);
  if (!p.data) fail("Project not found.");
  if ((p.data as { status: string }).status !== "ACTIVE") fail("Only an ACTIVE project can be linked to a Cin7 Sale.");
  // A variation billing project links its OWN Sale (role VARIATION); the BASE project links the BASE Sale. Rows written before migration 0105 are BASE.
  const saleRole = (p.data as { billing_scope?: string }).billing_scope === "VARIATION" ? "VARIATION" : "BASE";
  if (await loadSaleLink(db, input.orgId, input.projectId)) fail("This project is already linked to a Cin7 Sale. A link is permanent.");

  const sale = await port.fetchSale(saleId);
  if (sale.id !== saleId) fail("Cin7 returned a different sale than requested; nothing was linked.");
  if ((sale.type ?? "").toLowerCase() !== "advanced sale") fail(`Only an Advanced Sale can be linked (this sale is "${sale.type ?? "unknown"}").`);
  if ((sale.orderStatus ?? "").toUpperCase() !== "AUTHORISED") fail(`The Cin7 sale must be AUTHORISED (it is "${sale.orderStatus ?? "unknown"}").`);
  if (!sale.taxRule) fail("The Cin7 sale has no tax rule; nothing was linked.");

  const ins = await db.from("project_cin7_sale_links").insert({
    org_id: input.orgId, project_id: input.projectId, instance_id: input.instanceId, cin7_sale_id: saleId, cin7_sale_number: sale.saleNumber,
    link_status: "LINKED", tax_rule: sale.taxRule, revenue_account: input.revenueAccount.trim(),
    sale_snapshot: { type: sale.type, orderStatus: sale.orderStatus, invoiceCount: sale.invoices.length }, linked_by_email: email,
    ...(saleRole === "VARIATION" ? { sale_role: saleRole } : {}),
  }).select("*").single();
  if (ins.error || !ins.data) fail(`link sale: ${ins.error?.message ?? "no row"}`); // incl. unique(project) / unique(org, sale)
  return ins.data as SaleLinkRow;
}

// ── posting ─────────────────────────────────────────────────────────────────

/** Physical units held by OTHER postings on the same Sale link that Cin7 may not show yet (PENDING, or uncertain). Excludes the given claim's own posting. */
export async function reservedByOthers(db: Db, orgId: string, saleLinkId: string, claimId: string): Promise<Record<string, number>> {
  const r = await db.from("project_claim_cin7_postings").select("*").eq("org_id", orgId).eq("sale_link_id", saleLinkId);
  if (r.error) fail(`load postings: ${r.error.message}`);
  const out: Record<string, number> = {};
  for (const p of (r.data ?? []) as PostingRow[]) {
    if (p.claim_id === claimId || !["PENDING", "FAILED_UNCERTAIN"].includes(p.posting_state)) continue;
    for (const l of p.physical_lines ?? []) out[l.sku] = (out[l.sku] ?? 0) + l.quantity;
  }
  return out;
}

const today = (now: Date) => now.toISOString().slice(0, 10);
const addDays = (now: Date, d: number) => new Date(now.getTime() + d * 86_400_000).toISOString().slice(0, 10);
const trunc = (s: string) => s.replace(/\s+/g, " ").slice(0, 500);

/**
 * Posts ONE approved claim to Cin7 as ONE invoice. Fails closed on every gate, server-side. Returns the existing result (no write)
 * when the claim is already posted. Never retries blindly: only a CONFIRMED no-write failure may be re-sent, with the same key/memo.
 */
export async function postClaimToCin7(
  db: Db, port: Cin7Port, gates: WriteGates, email: string,
  input: { orgId: string; projectId: string; claimId: string; confirmation: string; now?: Date; physicalLines?: PhysicalSelection[]; earlyReason?: string },
): Promise<PostResult> {
  const now = input.now ?? new Date();
  // 1–3: flag, org, manager, explicit confirmation — all enforced HERE, whatever the UI showed.
  if (!gates.writesEnabled) fail("Cin7 writes are switched off (NEWQUIP_CIN7_WRITES_ENABLED).");
  if (!gates.orgEnabled) fail("Cin7 posting is not enabled for this organization.");
  if (!gates.isManager) fail("Only a manager (org owner/admin) can post a claim to Cin7.");
  if (input.confirmation !== POST_CONFIRMATION_TEXT) fail("The confirmation was not given.");

  // 5–7: project ACTIVE, linked Sale, APPROVED claim.
  const proj = await db.from("projects").select("id, status, project_reference").eq("org_id", input.orgId).eq("id", input.projectId).maybeSingle();
  if (proj.error) fail(proj.error.message);
  if (!proj.data) fail("Project not found.");
  const project = proj.data as { status: string; project_reference: string };
  if (project.status !== "ACTIVE") fail("Only an ACTIVE project can post claims.");
  const link = await loadSaleLink(db, input.orgId, input.projectId);
  if (!link) fail("This project has no linked Cin7 Sale. Link one first.");
  const c = await db.from("project_claims").select("id, claim_number, status, tax_rate_bps, subtotal_cents, tax_cents, total_cents").eq("org_id", input.orgId).eq("project_id", input.projectId).eq("id", input.claimId).maybeSingle();
  if (c.error) fail(c.error.message);
  if (!c.data) fail("Claim not found in this project.");
  const claim = c.data as PostingClaim;
  const ls = await db.from("project_claim_lines").select("stage_name, current_claim_cents, tax_cents, stage_id").eq("org_id", input.orgId).eq("claim_id", input.claimId);
  if (ls.error) fail(ls.error.message);
  const lines = ((ls.data ?? []) as Array<PostingClaimLine & { stage_id: string }>).sort((a, b) => a.stage_id.localeCompare(b.stage_id));

  // 8–9: not already posted; state safe to attempt.
  const ex = await db.from("project_claim_cin7_postings").select("*").eq("org_id", input.orgId).eq("claim_id", input.claimId).maybeSingle();
  if (ex.error) fail(ex.error.message);
  const existing = (ex.data as PostingRow | null) ?? null;
  if (existing && (existing.posting_state === "CREATED" || existing.posting_state === "RECONCILED")) {
    return { posting: existing, state: existing.posting_state, message: "This claim is already in Cin7. Nothing was sent.", alreadyPosted: true };
  }
  if (existing?.posting_state === "PENDING") fail(isStalePending(existing.requested_at, now.getTime()) ? `${MESSAGES.uncertain} (a previous attempt never finished — reconcile it.)` : MESSAGES.inFlight);
  if (existing?.posting_state === "FAILED_UNCERTAIN") fail(MESSAGES.uncertain);
  if (!canSend(existing?.posting_state ?? "NOT_SENT")) fail("This claim cannot be posted in its current state.");

  // Physical products (optional): validated against the Sale's ORDER and what is already invoiced, by a READ-ONLY fetch BEFORE any intent
  // is persisted. A retry of an existing posting must repeat the identical selection (the fingerprint covers it).
  const selection = input.physicalLines ?? [];
  let resolved: ResolvedPhysicalLine[] = [];
  const baseRemaining: Record<string, number> = {};
  if (selection.length > 0) {
    const view = await port.fetchSale(link.cin7_sale_id);
    const r = resolvePhysicalLines(selection, view.orderLines, view.invoices);
    if (!r.ok) fail(r.error);
    // The eligibility rule is RECOMPUTED here from live Cin7 facts, never taken from what the screen showed: a stale or concurrent selection cannot slip through.
    const reserved = await reservedByOthers(db, input.orgId, link.id, input.claimId);
    const orderLines = view.orderLines ?? [];
    const proposal = proposeInvoice({
      claimLines: lines.map((l) => ({ stageName: l.stage_name, amountCents: l.current_claim_cents, taxCents: l.tax_cents })),
      orderLines: orderLines.map((o) => ({ sku: o.sku, description: o.name, ordered: Number.isFinite(o.quantity) ? o.quantity : null })),
      invoices: view.invoices.map((i) => ({ status: i.status, lines: i.lines ? i.lines.map((l) => ({ sku: l.sku, quantity: l.quantity })) : null })),
      shipped: Object.fromEntries(orderLines.map((o) => [o.sku, view.shipped ? view.shipped[o.sku] : null])),
      reserved, scopeSkus: [],
    });
    const bad = validateSelection(proposal, selection, input.earlyReason ?? null);
    if (bad) fail(bad);
    for (const l of proposal.lines) if (l.ordered !== null && l.invoiced !== null) baseRemaining[l.sku] = Math.max(0, l.ordered - l.invoiced);
    resolved = r.lines.map((l) => {
      const eligible = proposal.lines.find((x) => x.sku === l.sku)?.eligible ?? 0;
      return l.quantity > eligible + 1e-9 ? { ...l, earlyReason: (input.earlyReason ?? "").trim() } : l;
    });
  }
  const built = buildPostingPlan({ projectRef: project.project_reference, claim, lines, link, physicalLines: resolved });
  if (!built.ok) fail(built.error);
  const plan = built.plan;

  // PERSIST INTENT FIRST. unique(claim_id) is the lock: a concurrent attempt cannot also create a row; a retry is a
  // compare-and-set on the row's state, so only one caller wins.
  let posting: PostingRow;
  if (!existing) {
    const ins = await db.from("project_claim_cin7_postings").insert({
      org_id: input.orgId, project_id: input.projectId, claim_id: input.claimId, sale_link_id: link.id, idempotency_key: plan.idempotencyKey,
      request_fingerprint: plan.fingerprint, memo: plan.memo, posting_state: "PENDING", attempt_count: 1,
      amount_ex_vat_cents: plan.subtotalCents, tax_cents: plan.taxCents, total_cents: plan.totalCents, cin7_sale_id: link.cin7_sale_id,
      requested_by_email: email, requested_at: now.toISOString(),
      ...(plan.physicalLines.length ? { physical_lines: plan.physicalLines.map((l) => ({ sku: l.sku, quantity: l.quantity, ...(l.earlyReason ? { earlyReason: l.earlyReason } : {}) })) } : {}),
    }).select("*").single();
    if (ins.error || !ins.data) {
      if (/duplicate key|unique/i.test(ins.error?.message ?? "")) fail(MESSAGES.inFlight);
      fail(`record posting intent: ${ins.error?.message ?? "no row"}`);
    }
    posting = ins.data as PostingRow;
  } else {
    if (existing.request_fingerprint !== plan.fingerprint) fail("The approved claim no longer matches the original request; refusing to re-send.");
    const up = await db.from("project_claim_cin7_postings").update({
      posting_state: "PENDING", attempt_count: existing.attempt_count + 1, requested_by_email: email, requested_at: now.toISOString(),
      last_error_code: null, last_error_message: null,
    }).eq("org_id", input.orgId).eq("id", existing.id).eq("posting_state", "FAILED_CONFIRMED_NO_WRITE").select("*");
    if (up.error) fail(up.error.message);
    if (!up.data || up.data.length === 0) fail(MESSAGES.inFlight);
    posting = (up.data as PostingRow[])[0];
  }

  // CONCURRENCY: now that this posting's intent is stored, make sure no OTHER in-flight posting on the same Sale holds the same units. If the
  // combined demand exceeds what is still invoiceable, this one stands down BEFORE anything is sent (both may stand down: fail closed).
  if (plan.physicalLines.length) {
    const others = await reservedByOthers(db, input.orgId, link.id, input.claimId);
    const clash = plan.physicalLines.find((l) => (others[l.sku] ?? 0) + l.quantity > (baseRemaining[l.sku] ?? 0) + 1e-9);
    if (clash) {
      const msg = `${clash.sku}: another posting on this Sale is already holding some of the remaining quantity; nothing was sent. Reconcile or finish that posting first.`;
      await db.from("project_claim_cin7_postings").update({ posting_state: "FAILED_CONFIRMED_NO_WRITE", last_error_code: "CONCURRENT_QUANTITY", last_error_message: msg, completed_at: new Date().toISOString() })
        .eq("org_id", input.orgId).eq("id", posting.id).eq("posting_state", "PENDING");
      fail(msg);
    }
  }

  // THE ONE EXTERNAL CALL.
  let outcome: InvoiceOutcome;
  try {
    outcome = await port.createInvoice({
      saleId: link.cin7_sale_id, memo: plan.memo, invoiceDate: today(now), invoiceDueDate: addDays(now, 30), taxRule: link.tax_rule, account: link.revenue_account,
      ...(plan.physicalLines.length ? { lines: plan.physicalLines } : {}),
      charges: plan.charges.map((ch) => ({ description: ch.description, priceExVat: rands(ch.amountCents), taxAmount: rands(ch.taxCents), comment: `Toolbox claim ${claim.claim_number}` })),
    });
  } catch {
    outcome = { kind: "uncertain", reason: "Unexpected error while calling Cin7." };
  }

  // RECORD THE OUTCOME (compare-and-set from PENDING). If this write itself fails the row stays PENDING and is reconciled later.
  const done = new Date().toISOString();
  let patch: Record<string, unknown>;
  let state: PostingState;
  let message: string;
  if (outcome.kind === "created") {
    // The invoice EXISTS (it carries our memo), so nothing below may un-create it or allow a re-send. Verify the AMOUNTS from what Cin7
    // holds: the POST echo when it carries finite numbers, otherwise a READ-ONLY read-back. Missing/unreadable is never a match.
    const cents = (n: number | null) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) : null);
    let lineDiffs: string[] = [];
    let seen = { subtotalCents: cents(outcome.totalBeforeTax), taxCents: cents(outcome.tax), totalCents: cents(outcome.total) };
    if (seen.subtotalCents === null || seen.taxCents === null || seen.totalCents === null) {
      try {
        const back = matchInvoices((await port.fetchSale(link.cin7_sale_id)).invoices, { memo: plan.memo, amount_ex_vat_cents: plan.subtotalCents, tax_cents: plan.taxCents, total_cents: plan.totalCents, physical_lines: plan.physicalLines });
        if (back.kind === "matched" || back.kind === "mismatch") seen = { subtotalCents: back.invoice.subtotalCents, taxCents: back.invoice.taxCents, totalCents: back.invoice.totalCents };
        if (back.kind === "mismatch") lineDiffs = back.differences.filter((d) => !/^(ex VAT|VAT|total) /.test(d));
      } catch { /* the read-back is best effort; the invoice is already recorded below */ }
    }
    const differences = [...amountDifferences(seen, { amount_ex_vat_cents: plan.subtotalCents, tax_cents: plan.taxCents, total_cents: plan.totalCents }), ...lineDiffs];
    const same = differences.length === 0;
    state = "CREATED";
    patch = {
      posting_state: "CREATED", cin7_invoice_number: outcome.invoiceNumber, cin7_task_id: outcome.taskId, cin7_status: outcome.status, completed_at: done,
      ...(same ? {} : { last_error_code: "AMOUNT_MISMATCH", last_error_message: trunc(`${MESSAGES.mismatch} ${differences.join("; ")}.`) }),
    };
    message = same ? `Created in Cin7 as ${outcome.invoiceNumber}.` : `Created in Cin7 as ${outcome.invoiceNumber}, but ${MESSAGES.mismatch} ${differences.join("; ")}.`;
  } else if (outcome.kind === "rejected") {
    state = "FAILED_CONFIRMED_NO_WRITE";
    patch = { posting_state: state, last_error_code: `HTTP_${outcome.httpStatus}`, last_error_message: trunc(outcome.message), completed_at: done };
    message = MESSAGES.safeFailure;
  } else {
    state = "FAILED_UNCERTAIN";
    patch = { posting_state: state, last_error_code: "UNCERTAIN", last_error_message: trunc(outcome.reason), completed_at: done };
    message = MESSAGES.uncertain;
  }
  const rec = await db.from("project_claim_cin7_postings").update(patch).eq("org_id", input.orgId).eq("id", posting.id).eq("posting_state", "PENDING").select("*");
  if (rec.error || !rec.data || rec.data.length === 0) {
    fail(`${MESSAGES.uncertain} (the result could not be recorded: ${rec.error?.message ?? "state changed"}).`);
  }
  return { posting: (rec.data as PostingRow[])[0], state, message, alreadyPosted: false };
}

// ── reconciliation (READ-ONLY against Cin7) ─────────────────────────────────

/**
 * Reads the linked Sale back from Cin7 and decides, by the EXACT memo and the frozen amounts:
 *   matched   -> CREATED/RECONCILED            mismatch -> CREATED (the invoice exists, so no retry) + an explicit mismatch
 *   not found -> FAILED_CONFIRMED_NO_WRITE     (only from an uncertain / orphaned attempt — retry becomes possible)
 *   several   -> fail closed, nothing changes
 * Never writes to Cin7. Allowed regardless of the write flag (it is a read).
 */
export async function reconcileClaimPosting(
  db: Db, port: Cin7Port, gates: Pick<WriteGates, "isManager">,
  input: { orgId: string; projectId: string; claimId: string; now?: Date },
): Promise<PostResult> {
  if (!gates.isManager) fail("Only a manager (org owner/admin) can reconcile a posting.");
  const now = input.now ?? new Date();
  const r = await db.from("project_claim_cin7_postings").select("*").eq("org_id", input.orgId).eq("project_id", input.projectId).eq("claim_id", input.claimId).maybeSingle();
  if (r.error) fail(r.error.message);
  let posting = r.data as PostingRow | null;
  if (!posting) fail("This claim has not been sent to Cin7; there is nothing to reconcile.");
  if (posting.posting_state === "RECONCILED") return { posting, state: "RECONCILED", message: "Already reconciled.", alreadyPosted: true };
  if (posting.posting_state === "FAILED_CONFIRMED_NO_WRITE") return { posting, state: posting.posting_state, message: MESSAGES.safeFailure, alreadyPosted: false };
  if (posting.posting_state === "PENDING") {
    if (!isStalePending(posting.requested_at, now.getTime())) fail(MESSAGES.inFlight);
    const u = await db.from("project_claim_cin7_postings").update({ posting_state: "FAILED_UNCERTAIN", last_error_code: "ORPHANED_PENDING", last_error_message: "The attempt never recorded an outcome." })
      .eq("org_id", input.orgId).eq("id", posting.id).eq("posting_state", "PENDING").select("*");
    if (u.error || !u.data?.length) fail("The posting changed while reconciling; try again.");
    posting = (u.data as PostingRow[])[0];
  }

  const sale = await port.fetchSale(posting.cin7_sale_id);
  const m = matchInvoices(sale.invoices, posting);
  const at = now.toISOString();
  const set = async (patch: Record<string, unknown>, from: PostingState): Promise<PostingRow> => {
    const u = await db.from("project_claim_cin7_postings").update(patch).eq("org_id", input.orgId).eq("id", posting!.id).eq("posting_state", from).select("*");
    if (u.error || !u.data?.length) fail("The posting changed while reconciling; try again.");
    return (u.data as PostingRow[])[0];
  };

  if (m.kind === "multiple") fail(`Cin7 holds ${m.count} invoices with this claim's memo; refusing to guess. Resolve it in Cin7.`);
  if (m.kind === "not_found") {
    if (posting.posting_state === "FAILED_UNCERTAIN") {
      const p = await set({ posting_state: "FAILED_CONFIRMED_NO_WRITE", evidence: { method: "READ_BACK_NO_MATCH", checkedAt: at, detail: "No invoice with this memo exists on the linked Sale." }, last_error_code: "RECONCILED_NO_INVOICE", last_error_message: "Reconciliation found no invoice in Cin7. A controlled retry is now permitted." }, "FAILED_UNCERTAIN");
      return { posting: p, state: p.posting_state, message: "No invoice exists in Cin7 for this claim. A controlled retry is now permitted.", alreadyPosted: false };
    }
    fail("The posting is recorded as created, but the invoice was NOT found in Cin7. Investigate in Cin7; nothing was changed.");
  }
  const inv = m.invoice;
  let row = posting;
  if (row.posting_state === "FAILED_UNCERTAIN") {
    row = await set({ posting_state: "CREATED", cin7_invoice_number: inv.invoiceNumber, cin7_task_id: inv.taskId, cin7_status: inv.status, completed_at: at, last_error_code: null, last_error_message: null }, "FAILED_UNCERTAIN");
  }
  if (m.kind === "mismatch") {
    const p = await set({ last_error_code: "AMOUNT_MISMATCH", last_error_message: `${MESSAGES.mismatch} (${m.differences.join("; ")})` }, row.posting_state);
    return { posting: p, state: p.posting_state, message: `${MESSAGES.mismatch} ${m.differences.join("; ")}`, alreadyPosted: true };
  }
  const p = await set({ posting_state: "RECONCILED", reconciled_at: at, cin7_status: inv.status, last_error_code: null, last_error_message: null, evidence: { method: "READ_BACK_MEMO_MATCH", checkedAt: at, invoiceNumber: inv.invoiceNumber, taskId: inv.taskId } }, row.posting_state === "RECONCILED" ? "RECONCILED" : "CREATED");
  await db.from("project_cin7_sale_links").update({ last_reconciled_at: at }).eq("org_id", input.orgId).eq("project_id", input.projectId);
  return { posting: p, state: "RECONCILED", message: `Reconciled with Cin7 invoice ${inv.invoiceNumber}.`, alreadyPosted: true };
}
