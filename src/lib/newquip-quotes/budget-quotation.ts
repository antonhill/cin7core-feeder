import "server-only";
// BUDGET QUOTATION: preview and send (customer UAT feedback). LOCAL + the existing Resend wrapper only: no Cin7, no approval, no issued document, no acceptance link, no Project.
//
// What this is NOT, enforced by construction: it never writes to newquip_quotes / approval_requests / newquip_quote_documents / newquip_quote_sends / projects (the quotation stays exactly where it
// is in the workflow) and the email carries NO Accept / Decline / Request-changes links. Its ONLY record is the audit trail (activity_log), which stores the exact document model, its hash and the
// PDF's SHA-256, so the precise document that was sent can be reproduced.
//
// Environment rules (fail closed):
//  - Any RESTRICTED environment (UAT, Preview, local): the UAT test-email switch must be on, the document is watermarked TEST ONLY, the placeholder company details are tolerated, and the recipient must be
//    on the authorised test-mailbox allowlist (anyone else is refused, never redirected).
//  - Anywhere else (Production): the same strict company-details check as a final quotation, the owner's approval of the budget wording (NEWQUIP_BUDGET_QUOTATION_WORDING_APPROVED=true) and the Production
//    email switch are ALL required. A "provisional" label bypasses none of them.
import { createHash } from "node:crypto";
import type { createServiceRoleClient } from "@/supabase/server";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import type { QuoteDraft } from "@/newquip/grower/draft";
import { packageFor, provisionalPackageBasis, templateRevisionOf } from "@/newquip/grower/commercial";
import type { DocumentStorage } from "./document-store";
import { hashOf } from "@/newquip/quote/baseline";
import { applyEmailPolicy, isRestricted, productionEmailBlocked, PRODUCTION_EMAIL_OFF, type EmailEnv } from "@/lib/approvals/email-policy";
import { sendEmail as resendSend, type SendEmailInput, type SendEmailResult } from "@/lib/email/resend";
import { logActivityStrict } from "@/lib/activity-log";
import { loadQuote } from "./quote-store";
import { evaluationContext } from "./context";
import { latestSnapshot } from "./customer-store";
import { latestProfile, supabaseStorage } from "./document-store";
import { describeProfileProblems, profileProblems } from "./company-profile";
import { isValidEmail } from "./customer-snapshot";
import { BUDGET_DISCLAIMER, buildBudgetDocumentModel, presentsPartialAsTotal, type BudgetDocumentModel } from "./budget-document";
import { renderBudgetPdf } from "./budget-pdf";
import { recipientAllowed, testPdfEmailEnabled } from "./test-pdf-email";

type Db = ReturnType<typeof createServiceRoleClient>;
export const BUDGET_STATES = ["REP_DRAFT", "ESTIMATOR_REVIEW"] as const;
export const BUDGET_SEND_ACTION = "newquip.budget_quotation_sent";
export const BUDGET_SEND_STARTED = "newquip.budget_quotation_send_started";
export const BUDGET_WORDING_FLAG = "NEWQUIP_BUDGET_QUOTATION_WORDING_APPROVED";
export const MAX_BUDGET_MESSAGE = 1500;
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

export interface BudgetPreparation { model: BudgetDocumentModel; draftHash: string; quoteRef: string; revision: number; state: string; testMode: boolean; repEmail: string | null; /** SERVER-INTERNAL: the saved draft (it carries pricing). Never returned to a browser. */ draft: QuoteDraft }

/** Builds the budget document model from the SAVED draft of this organisation's quotation. Read-only. Throws a readable error when it cannot be built. */
export async function prepareBudget(db: Db, orgId: string, quoteId: string, env: EmailEnv, today: () => string = () => new Date().toISOString().slice(0, 10)): Promise<BudgetPreparation> {
  const q = await loadQuote(db, orgId, quoteId);
  if (!q) throw new Error("Quotation not found.");
  if (!(BUDGET_STATES as readonly string[]).includes(q.state)) throw new Error("A budget quotation is for a quotation that is still being prepared. This quotation has already been approved: use the final quotation.");
  const profile = await latestProfile(db, orgId);
  const testMode = isRestricted(env);
  // The preview always needs a BUILDABLE company block; a customer SEND (below) additionally needs REAL details outside the test environment.
  const hard = profileProblems(profile?.profile, { lenient: true });
  if (!profile || hard.length) throw new Error(`The budget quotation cannot be built: ${profile ? describeProfileProblems(hard).join("; ") : "no company details have been saved"}.`);
  // BUDGET evaluation: cost withheld (selling prices only) and evidence-complete packages priced PROVISIONALLY. Nothing is confirmed and no other flow uses this option.
  const ev = evaluateDraft(q.draft, { ...evaluationContext(true), provisionalPackages: true });
  if (!ev.budget) throw new Error("The quotation has no valid configuration yet (check the room measurements); there is nothing to put in a budget quotation.");
  const snap = (await latestSnapshot(db, orgId, quoteId))?.snapshot ?? null;
  const contact = snap?.chosenContact ? { name: snap.chosenContact.name, email: snap.chosenContact.email } : null;
  const model = buildBudgetDocumentModel({
    budget: ev.budget, quoteRef: q.quote_ref, revision: q.revision, draftHash: q.draft_hash, preparedOn: today(), siteName: q.draft.siteName, customerName: q.draft.customerName, contact,
    profile: profile.profile, config: q.draft.config, testOnly: testMode,
  });
  if (presentsPartialAsTotal(model)) throw new Error("The budget quotation would present a partial subtotal as a total; it was not produced.");
  return { model, draftHash: q.draft_hash, quoteRef: q.quote_ref, revision: q.revision, state: q.state, testMode, repEmail: q.created_by_email ?? null, draft: q.draft };
}

export async function previewBudgetPdf(db: Db, orgId: string, quoteId: string, env: EmailEnv): Promise<{ bytes: Uint8Array; prep: BudgetPreparation }> {
  const prep = await prepareBudget(db, orgId, quoteId, env);
  return { bytes: await renderBudgetPdf(prep.model), prep };
}

/** The customer-facing email: the fixed disclaimer first and last, what is unpriced, and no link of any kind. Pure. */
export function buildBudgetEmail(i: { model: BudgetDocumentModel; to: string; message: string; bytes: Uint8Array }): SendEmailInput {
  const m = i.model;
  const lines = [
    ...(m.testOnly ? ["TEST ONLY – NOT FOR CUSTOMER ISSUE. This is a UAT test message: do not act on it and do not forward it.", ""] : []),
    BUDGET_DISCLAIMER, "",
    i.message.trim() || `Please find attached our budget quotation ${m.quote.reference}.`, "",
    `Budget quotation: ${m.quote.reference}${m.quote.siteName ? ` – ${m.quote.siteName}` : ""}`,
    ...(m.provisional.count > 0 ? [`PROVISIONAL PRICING: ${m.provisional.count} item${m.provisional.count === 1 ? " is" : "s are"} priced from the best information available today and most likely to change once our Estimator confirms the products (${m.provisional.items.join("; ")}).`] : []),
    ...(m.complete ? [] : [`INCOMPLETE PRICING: ${m.unpriced.count} item${m.unpriced.count === 1 ? " is" : "s are"} not yet priced (${m.unpriced.items.join("; ")}). The attached document shows them as "Price to be confirmed" and presents no total.`]),
    "", "This email carries a PDF attachment only. It cannot be accepted or declined online: a final quotation will follow once pricing is confirmed.", "", BUDGET_DISCLAIMER, "", m.company.legalName,
  ];
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<p style="font-weight:700;color:#92400e;background:#fef3c7;border:1px solid #92400e;padding:8px">${esc(BUDGET_DISCLAIMER)}</p>${m.testOnly ? `<p style="font-weight:700;color:#fff;background:#b91c1c;padding:8px">TEST ONLY – NOT FOR CUSTOMER ISSUE</p>` : ""}<p>${esc(i.message.trim() || `Please find attached our budget quotation ${m.quote.reference}.`).replace(/\n/g, "<br>")}</p><p><strong>Budget quotation ${esc(m.quote.reference)}</strong></p>${m.complete ? "" : `<p style="color:#b91c1c;font-weight:700">INCOMPLETE PRICING: ${m.unpriced.count} item${m.unpriced.count === 1 ? " is" : "s are"} not yet priced. The attached document shows them as &ldquo;Price to be confirmed&rdquo; and presents no total.</p>`}${m.provisional.count > 0 ? `<p style="color:#92400e;font-weight:700">PROVISIONAL PRICING: ${m.provisional.count} item${m.provisional.count === 1 ? " is" : "s are"} priced from the best information available today and most likely to change once our Estimator confirms the products.</p>` : ""}<p>This email carries a PDF attachment only. It cannot be accepted or declined online: a final quotation will follow once pricing is confirmed.</p><p style="font-weight:700">${esc(BUDGET_DISCLAIMER)}</p><p>${esc(m.company.legalName)}</p>`;
  const prefix = m.testOnly ? "TEST ONLY – " : "";
  return { to: [i.to], subject: `${prefix}BUDGET QUOTATION – INDICATIVE PRICING ONLY – ${m.quote.reference}`, text: lines.join("\n"), html, attachments: [{ filename: `${m.testOnly ? "TEST-ONLY-" : ""}BUDGET-${m.quote.reference}-draft-${m.quote.draftRef}.pdf`, content: Buffer.from(i.bytes) }] };
}

export interface BudgetSendRequest {
  to: string; message?: string; idempotencyKey: string;
  /** The saved-draft hash the Rep previewed. The send is refused if the draft changed since (the customer receives exactly what was previewed). */
  expectedDraftHash: string;
  /** Required when anything is unpriced: the Rep has seen the incomplete-estimate warning and agrees to send scope without a total. */
  acknowledgeIncomplete?: boolean;
}
export interface BudgetSendResult { status: "ACCEPTED" | "FAILED" | "SUPPRESSED"; to: string; reused: boolean; incompleteCount: number; testMode: boolean; draftRef: string; pdfSha256: string }

export type BudgetSendDeps = { send: (i: SendEmailInput) => Promise<SendEmailResult>; today: () => string; now: () => string; /** Private, service-role-only store for the INTERNAL snapshot (the saved draft with its pricing). Absent = no internal snapshot is kept (a send then fails: it must be reproducible). */ storage?: Pick<DocumentStorage, "upload"> };
export const BUDGET_PROVISIONAL_FLAG = "NEWQUIP_PROVISIONAL_PACKAGES_APPROVED";

/** INTERNAL explanation of every provisional package (Estimator / Manager / audit only; never a Rep payload or the PDF): composition, why it qualifies, and the questions still open. */
export function provisionalInternalOf(draft: QuoteDraft, itemKeys: readonly string[]): Array<{ itemKey: string; qualifies: string; composition: Array<{ sku: string; qtyPerUnit: number }>; openQuestions: string[] }> {
  const rev = templateRevisionOf(draft);
  return itemKeys.flatMap((k) => { const b = provisionalPackageBasis(packageFor(k as never, rev)); return b ? [{ itemKey: k, qualifies: b.qualifies, composition: b.composition, openQuestions: b.internalReasons }] : []; });
}
export const liveBudgetDepsFor = (db: Db): BudgetSendDeps => ({ send: resendSend, today: () => new Date().toISOString().slice(0, 10), now: () => new Date().toISOString(), storage: supabaseStorage(db) });

/** Environment gate for a SEND. Returns the reason it is refused, or null. Pure. */
export function budgetSendRefusal(env: EmailEnv, profileOk: boolean, problems: string[]): string | null {
  if (isRestricted(env)) return testPdfEmailEnabled(env) ? null : "Budget quotation email is available only on the UAT deployment (test email switch is off).";
  if (productionEmailBlocked(env)) return PRODUCTION_EMAIL_OFF;
  if (env[BUDGET_WORDING_FLAG] !== "true") return "The budget quotation wording has not been approved for customers yet (the owner must approve it first). Nothing was sent.";
  if (!profileOk) return `The company details cannot be used on a customer document: ${problems.join("; ")}. Nothing was sent.`;
  return null;
}

export async function sendBudgetQuotation(
  db: Db, who: { orgId: string; userId: string; email: string; isRep: boolean }, quoteId: string, req: BudgetSendRequest, env: EmailEnv, deps: BudgetSendDeps = liveBudgetDepsFor(db),
  audit: typeof logActivityStrict = logActivityStrict,
): Promise<BudgetSendResult> {
  if (!who.isRep) throw new Error("Only a Rep sends a budget quotation.");
  const to = (req.to ?? "").trim().toLowerCase();
  if (!isValidEmail(to)) throw new Error("Enter the customer's email address.");
  const message = (req.message ?? "").trim();
  if (message.length > MAX_BUDGET_MESSAGE) throw new Error("The message is too long.");
  if (/\b(margins?|mark-?ups?|gross profit|cost price|landed cost|supplier price|sku)\b/i.test(message)) throw new Error("Your message appears to contain internal information (costs, margins, SKUs). Remove it before sending.");
  if (!req.idempotencyKey || req.idempotencyKey.trim().length < 8) throw new Error("Missing send reference; reload and try again.");

  const profile = await latestProfile(db, who.orgId);
  const refusal = budgetSendRefusal(env, !!profile && profileProblems(profile.profile).length === 0, profile ? describeProfileProblems(profileProblems(profile.profile)) : ["no company details have been saved"]);
  if (refusal) throw new Error(refusal);
  // Restricted environments: only the authorised test mailboxes, never redirected (checked here AND again by the email policy at send).
  if (isRestricted(env) && !recipientAllowed(to)) throw new Error("In the UAT environment a budget quotation can be sent only to an authorised Spark test mailbox. Nothing was sent.");

  // Idempotency: a repeat of the same click returns the recorded outcome and emits nothing.
  const prior = await db.from("activity_log").select("action, detail, created_at").eq("org_id", who.orgId).in("action", [BUDGET_SEND_ACTION, BUDGET_SEND_STARTED]).filter("detail->>idempotencyKey", "eq", req.idempotencyKey).limit(10);
  if (prior.error) throw new Error(`Could not check for an earlier send: ${prior.error.message}`);
  const rows = (prior.data ?? []) as Array<{ action?: string; detail: Record<string, unknown>; created_at?: string }>;
  // Only an ACCEPTED send is reused: a FAILED or SUPPRESSED one may be retried. A send that STARTED moments ago and has no outcome yet is still in flight: refuse a second one.
  const earlier = rows.find((r) => r.detail?.status === "ACCEPTED")?.detail;
  const inFlight = !earlier && rows.some((r) => r.action === BUDGET_SEND_STARTED && r.created_at && Date.now() - Date.parse(r.created_at) < 120_000) && !rows.some((r) => r.action === BUDGET_SEND_ACTION);
  if (inFlight) throw new Error("This budget quotation is already being sent. Wait a moment and check before sending again.");
  if (earlier) return { status: earlier.status as BudgetSendResult["status"], to: String(earlier.to ?? to), reused: true, incompleteCount: Number(earlier.incompleteCount ?? 0), testMode: earlier.testMode === true, draftRef: String(earlier.draftRef ?? ""), pdfSha256: String(earlier.pdfSha256 ?? "") };

  const prep = await prepareBudget(db, who.orgId, quoteId, env, deps.today);
  if (prep.draftHash !== req.expectedDraftHash) throw new Error("The quotation changed after you previewed it. Save your changes, preview the budget quotation again, then send.");
  if (!prep.model.complete && req.acknowledgeIncomplete !== true) throw new Error(`Pricing is incomplete (${prep.model.unpriced.count} item${prep.model.unpriced.count === 1 ? "" : "s"} unpriced). Confirm that you want to send the scope with "Price to be confirmed" and no total.`);
  // Provisional package definitions are approved for UAT ONLY. A genuine customer budget quotation needs NewQuip management to approve the package composition and alternative rules first.
  if (!isRestricted(env) && prep.model.provisional.count > 0 && env[BUDGET_PROVISIONAL_FLAG] !== "true") throw new Error("This budget quotation contains provisional package prices, whose compositions NewQuip management has not approved for customers yet. Nothing was sent.");
  const bytes = await renderBudgetPdf(prep.model);
  const pdfSha256 = sha256(bytes);
  const mail = buildBudgetEmail({ model: prep.model, to, message, bytes });
  const decision = applyEmailPolicy(env, { to, subject: mail.subject, text: mail.text });
  const snapshot = { model: prep.model, modelHash: hashOf(prep.model), pdfSha256, pdfBytes: bytes.length };
  // INTERNAL snapshot (the saved draft WITH its pricing, the cost-visible evaluation and the provisional explanations) goes to the private, service-role-only store. The audit row holds only its path and hash:
  // no supplier cost, rate, freight or markup is ever put in the audit log. It lets the budget be compared line by line with the final approved quotation (see budget-variance.ts).
  if (!deps.storage) throw new Error("The internal budget snapshot store is unavailable; nothing was sent.");
  const internalEval = evaluateDraft(prep.draft, { ...evaluationContext(false), provisionalPackages: true }).budget;
  const provisionalKeys = prep.model.equipment.filter((l) => l.status === "provisional").map((l) => internalEval?.lines.find((x) => x.label === l.label)?.itemKey).filter((k): k is NonNullable<typeof k> => !!k);
  const internal = { schema: 1, quoteId, quoteRef: prep.quoteRef, draftHash: prep.draftHash, savedAt: deps.now(), draft: prep.draft, lines: (internalEval?.lines ?? []).filter((l) => l.status !== "not_selected").map((l) => ({ itemKey: l.itemKey, status: l.status, quantity: l.quantity, unitPrice: l.unitPrice, revenueExTax: l.revenueExTax, provisional: !!l.provisional })), subtotalExTax: internalEval?.totals.subtotalExTax ?? null, provisional: provisionalInternalOf(prep.draft, provisionalKeys) };
  const internalBytes = new TextEncoder().encode(JSON.stringify(internal));
  const internalPath = `${who.orgId}/budget-snapshots/${quoteId}/${prep.draftHash.slice(0, 16)}-${pdfSha256.slice(0, 12)}-${req.idempotencyKey.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24)}.json`;
  await deps.storage.upload(internalPath, internalBytes, "application/json");
  const internalRef = { path: internalPath, sha256: sha256(internalBytes) };

  const base = { quoteId, quoteRef: prep.quoteRef, quoteRevision: prep.revision, quoteState: prep.state, draftHash: prep.draftHash, draftRef: prep.model.quote.draftRef, idempotencyKey: req.idempotencyKey, to, testMode: prep.testMode,
    complete: prep.model.complete, provisionalCount: prep.model.provisional.count, internalSnapshot: internalRef, incompleteCount: prep.model.unpriced.count, unpricedItems: prep.model.unpriced.items, knownSubtotalExVat: prep.model.totals.knownSubtotalExVat, totalIncVat: prep.model.totals.totalIncVat, pdfSha256, modelHash: snapshot.modelHash };
  const actor = { userId: who.userId, email: who.email };

  // The audit record is written BEFORE anything leaves: if it cannot be written, nothing is sent.
  await audit(db, { orgId: who.orgId, actor, action: BUDGET_SEND_STARTED, summary: `Preparing to send BUDGET quotation ${prep.quoteRef} (indicative; not a final quotation)`, detail: { ...base, snapshot } });
  let status: BudgetSendResult["status"] = "SUPPRESSED"; let providerMessageId: string | null = null; let error: string | null = null;
  if (decision.action === "SEND") {
    let res: SendEmailResult;
    try { res = await deps.send({ ...mail, subject: decision.subject, text: decision.text }); } catch (e) { res = { ok: false, error: e instanceof Error ? e.message : "Unknown error" }; }
    status = res.ok && res.messageId ? "ACCEPTED" : "FAILED"; providerMessageId = res.messageId ?? null; error = res.ok ? null : (res.error ?? "The provider did not accept the message").slice(0, 300);
  } else error = decision.reason;
  // Settled outcome: provider acceptance is NOT proof of inbox delivery.
  await audit(db, { orgId: who.orgId, actor, action: BUDGET_SEND_ACTION, summary: `${status === "ACCEPTED" ? "Sent" : status === "FAILED" ? "Failed to send" : "Suppressed"} BUDGET quotation ${prep.quoteRef} (indicative; no approval, acceptance, Project or Cin7 record created)`, detail: { ...base, status, providerMessageId, error, snapshot } });
  return { status, to, reused: false, incompleteCount: prep.model.unpriced.count, testMode: prep.testMode, draftRef: prep.model.quote.draftRef, pdfSha256 };
}
