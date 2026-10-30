import "server-only";
// Sending an ISSUED customer quotation. LOCAL + the existing Resend wrapper only (no Cin7). The rules, in order of enforcement:
//  - only a Manager-approved quotation, only its LATEST issued document, and only while that document still matches the approved revision and baseline hash;
//  - the attachment is the stored PDF, re-verified against its recorded SHA-256;
//  - recipients are validated and bounded; in PRODUCTION each must be a Cin7 contact of the customer (or the quotation contact), otherwise it needs an explicit, audited reason; in Preview (anything but VERCEL_ENV=production) the SAME server-side allowlist as approval emails applies - anyone else is
//    SUPPRESSED, never redirected - and the subject is marked [PREVIEW];
//  - one logical send per (document, idempotency key); a repeat click returns the same send. A second send of a document that was already accepted needs an audited re-send;
//  - the provider result is recorded as ACCEPTED (provider accepted it - NOT proof of inbox delivery or customer receipt) or FAILED; only FAILED can be retried, once at a time.
import type { createServiceRoleClient } from "@/supabase/server";
import { sendEmail as resendSend, type SendEmailInput, type SendEmailResult } from "@/lib/email/resend";
import { applyEmailPolicy, isRestricted, PREVIEW_BODY_BANNER, type EmailEnv } from "@/lib/approvals/email-policy";
import { loadQuote } from "./quote-store";
import { messageLeaksInternal } from "./customer-document";
import { isValidEmail } from "./customer-snapshot";
import { latestSnapshot } from "./customer-store";
import { listDocuments, readDocumentBytes, type DocumentDeps, type StoredDocument } from "./document-store";
import { portalAvailable } from "./acceptance";
import { issueResponseLink, type LinkEnv } from "./response-links";

type Db = ReturnType<typeof createServiceRoleClient>;
export type SendFn = (i: SendEmailInput) => Promise<SendEmailResult>;
export const defaultSend: SendFn = resendSend;

export interface StoredSend {
  id: string; org_id: string; quote_id: string; document_id: string; idempotency_key: string; resend_of: string | null; resend_reason: string | null; to_emails: string[]; cc_emails: string[];
  suppressed_emails: string[]; alternative_recipients: string[]; alternative_reason: string | null; subject: string; message: string; status: "QUEUED" | "ACCEPTED" | "FAILED" | "SUPPRESSED"; provider_message_id: string | null; last_error: string | null;
  sent_by_email: string; sent_by_owner_email: string | null; created_at: string; attempted_at: string | null;
}
export interface SendRequest { documentId: string; to: string[]; cc?: string[]; message: string; idempotencyKey: string; resendOfId?: string; resendReason?: string; /** Production: required for any address that is not a Cin7 contact of the customer. */ alternativeReason?: string }
export const MAX_TO = 3; export const MAX_CC = 5; export const MAX_MESSAGE = 2000;

const missing = (m: string | undefined) => /does not exist|schema cache|could not find the table/i.test(m ?? "");
const clean = (list: string[] | undefined): string[] => [...new Set((list ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))];

export async function listSends(db: Db, orgId: string, quoteId: string): Promise<StoredSend[]> {
  const r = await db.from("newquip_quote_sends").select("*").eq("org_id", orgId).eq("quote_id", quoteId).order("created_at", { ascending: false });
  if (r.error) { if (missing(r.error.message)) return []; throw new Error(r.error.message); }
  return (r.data ?? []) as StoredSend[];
}

/** Validates recipients and the message. Returns the cleaned values or throws a readable error. */
export function validateRequest(req: SendRequest): { to: string[]; cc: string[]; message: string } {
  const to = clean(req.to); const cc = clean(req.cc).filter((e) => !to.includes(e));
  if (to.length === 0) throw new Error("Enter the customer's email address.");
  if (to.length > MAX_TO) throw new Error(`At most ${MAX_TO} recipients.`);
  if (cc.length > MAX_CC) throw new Error(`At most ${MAX_CC} CC recipients.`);
  for (const e of [...to, ...cc]) if (!isValidEmail(e)) throw new Error(`"${e}" is not a valid email address.`);
  const message = (req.message ?? "").trim();
  if (message.length > MAX_MESSAGE) throw new Error("The message is too long.");
  if (!req.idempotencyKey || req.idempotencyKey.trim().length < 8) throw new Error("Missing send reference; reload and try again.");
  return { to, cc, message };
}

export interface ResponseLinks { accept: string; decline: string; changes: string; expiresOn: string }

function bodyOf(doc: StoredDocument, message: string, companyName: string, links?: ResponseLinks | null): string {
  return [
    message || `Please find attached our quotation ${doc.quote_ref}.`,
    "",
    `Quotation: ${doc.quote_ref} (revision ${doc.revision})`,
    `Valid until: ${doc.content.quote.validUntil}`,
    "",
    "This email carries your quotation as a PDF attachment. Please follow the acceptance instructions inside it.",
    ...(links ? [
      "",
      `You can also respond online (secure personal links, valid until ${links.expiresOn}). Each link opens a page where you review the quotation and confirm your details; nothing is recorded until you submit:`,
      `  Accept the quotation:  ${links.accept}`,
      `  Decline the quotation: ${links.decline}`,
      `  Request changes:       ${links.changes}`,
      "Please do not forward this email: the links are personal to the recipients above.",
    ] : []),
    "",
    companyName,
  ].join("\n");
}

const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Branded HTML alternative of the quotation email (the plain text from bodyOf stays the fallback). Only customer-facing facts: no internal data. Everything is escaped. */
export function htmlOf(doc: StoredDocument, message: string, links: ResponseLinks | null, previewBanner: boolean): string {
  const brand = esc(doc.content.company.brandName); const legal = esc(doc.content.company.legalName);
  const btn = (href: string, label: string, bg: string) => `<tr><td style="padding:6px 0"><a href="${esc(href)}" style="display:block;background:${bg};color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;text-align:center;padding:14px 20px;border-radius:6px">${label}</a></td></tr>`;
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden">
${previewBanner ? `<tr><td style="background:#fef3c7;color:#92400e;font-size:12px;padding:8px 20px">${esc(PREVIEW_BODY_BANNER)}</td></tr>` : ""}
<tr><td style="background:#1e3a5f;color:#ffffff;padding:18px 20px;font-size:20px;font-weight:700">${brand}</td></tr>
<tr><td style="padding:22px 20px;font-size:15px;line-height:1.5">
<p style="margin:0 0 14px">${esc(message || `Please find attached our quotation ${doc.quote_ref}.`).replace(/\n/g, "<br>")}</p>
<p style="margin:0 0 4px"><strong>Quotation ${esc(doc.quote_ref)}</strong> (revision ${doc.revision})</p>
<p style="margin:0 0 16px;color:#475569">Valid until ${esc(doc.content.quote.validUntil)}. The quotation is attached as a PDF.</p>
${links ? `<p style="margin:0 0 8px;font-weight:700">Respond online</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${btn(links.accept, "Accept quotation", "#047857")}${btn(links.decline, "Decline quotation", "#b91c1c")}${btn(links.changes, "Request changes", "#1e3a5f")}</table>
<p style="margin:14px 0 0;font-size:12px;color:#64748b">These secure links are personal to you and valid until ${esc(links.expiresOn)}. Opening a link records nothing; your response is recorded only when you confirm it on the page. Please do not forward this email.</p>` : ""}
</td></tr>
<tr><td style="padding:14px 20px;background:#f8fafc;font-size:12px;color:#64748b">${legal}</td></tr>
</table></td></tr></table></body></html>`;
}

/**
 * The public customer portal's address (NEWQUIP_PUBLIC_PORTAL_URL), set by the owner only once the separate portal project and hostname are approved and verified.
 * Must be https (http only for localhost development); anything else - including an unset value - yields null and the email carries no response links.
 */
export function portalBaseUrl(env: EmailEnv): string | null {
  const raw = (env as Record<string, string | undefined>).NEWQUIP_PUBLIC_PORTAL_URL?.trim().replace(/\/+$/, "") ?? "";
  if (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(raw) || /^http:\/\/localhost(:\d+)?$/.test(raw)) return raw;
  return null;
}

/** Issues the emailed response links for this send, when migration 0117 is applied and a site address is known. Fails closed: otherwise the email carries no links. */
async function responseLinksFor(db: Db, orgId: string, doc: StoredDocument, send: StoredSend, recipients: string[], by: string, env: EmailEnv): Promise<ResponseLinks | null> {
  if (!(await portalAvailable(db))) return null;
  const base = portalBaseUrl(env);
  if (!base) return null; // no verified public portal address configured: fail closed (the internal host is behind Deployment Protection and must never be emailed to a customer)
  const { token, link } = await issueResponseLink(db, { orgId, doc, send, recipients, customerName: doc.content.customer.name, by }, env as LinkEnv);
  // The token travels in the URL FRAGMENT: browsers never send it to the server or in a Referer header, so it appears in no request log, analytics or referrer.
  const at = (a: string) => `${base}/quote-response#t=${token}&a=${a}`;
  return { accept: at("accept"), decline: at("decline"), changes: at("changes"), expiresOn: link.expires_at.slice(0, 10) };
}

async function deliver(db: Db, row: StoredSend, doc: StoredDocument, bytes: Uint8Array, to: string[], cc: string[], suppressed: string[], subject: string, text: string, send: SendFn, html?: string): Promise<StoredSend> {
  let res: SendEmailResult;
  try { res = await send({ to, cc, subject, text, ...(html ? { html } : {}), attachments: [{ filename: `${doc.quote_ref}-r${doc.revision}.pdf`, content: Buffer.from(bytes) }] }); }
  catch (e) { res = { ok: false, error: e instanceof Error ? e.message : "Unknown error" }; }
  const patch = res.ok && res.messageId ? { status: "ACCEPTED", provider_message_id: res.messageId, last_error: null, attempted_at: new Date().toISOString(), suppressed_emails: suppressed }
    : { status: "FAILED", last_error: (res.error ?? "The provider did not accept the message").slice(0, 500), attempted_at: new Date().toISOString(), suppressed_emails: suppressed };
  const up = await db.from("newquip_quote_sends").update(patch).eq("org_id", row.org_id).eq("id", row.id).select("*").single();
  if (up.error || !up.data) throw new Error(`The send was attempted but its outcome could not be recorded (${up.error?.message ?? "no row"}). Check the provider before sending again.`);
  return up.data as StoredSend;
}

export async function sendQuotationToCustomer(
  db: Db, orgId: string, quoteId: string, who: { email: string; ownerEmail?: string | null }, req: SendRequest,
  deps: Pick<DocumentDeps, "storage">, env: EmailEnv, send: SendFn = defaultSend,
): Promise<{ send: StoredSend; reused: boolean }> {
  const q = await loadQuote(db, orgId, quoteId);
  if (!q) throw new Error("Quote not found.");
  if (q.state !== "MANAGER_APPROVED_FINAL" || !q.accepted_baseline || !q.baseline_hash) throw new Error("A quotation can only be sent after Manager approval.");
  const { to, cc, message } = validateRequest(req);
  const docs = await listDocuments(db, orgId, quoteId);
  const doc = docs.find((d) => d.id === req.documentId);
  if (!doc) throw new Error("That document does not belong to this quotation.");
  if (docs[0].id !== doc.id) throw new Error("A newer version of this quotation has been issued; send the latest one.");
  if (doc.revision !== q.revision || doc.baseline_hash !== q.baseline_hash) throw new Error("The quotation changed after this document was issued; issue it again before sending.");
  if (message && messageLeaksInternal(message, q.accepted_baseline)) throw new Error("Your message appears to contain internal information (costs, margins, SKUs or internal notes). Remove it before sending.");

  // Production recipients: a Cin7 contact of the selected customer, or an explicitly approved alternative with an audited reason. (Outside Production the allowlist below is stricter.)
  let alternatives: string[] = [];
  if (!isRestricted(env)) {
    const snap = (await latestSnapshot(db, orgId, quoteId))?.snapshot;
    const known = new Set([...(snap?.contacts ?? []).map((c) => (c.email.state === "present" ? c.email.value.toLowerCase() : "")), snap?.chosenContact?.email.toLowerCase() ?? ""].filter(Boolean));
    alternatives = [...to, ...cc].filter((a) => !known.has(a));
    if (alternatives.length && (req.alternativeReason ?? "").trim().length < 5) throw new Error(`${alternatives.join(", ")} ${alternatives.length === 1 ? "is" : "are"} not a Cin7 contact of this customer. Use a customer contact, or give a reason (at least 5 characters) to approve ${alternatives.length === 1 ? "that address" : "those addresses"} for this send.`);
  }

  const prior = await listSends(db, orgId, quoteId);
  const mine = prior.find((s) => s.document_id === doc.id && s.idempotency_key === req.idempotencyKey);
  if (mine) return { send: mine, reused: true }; // the same click / the same dialog: the same send, nothing new is emitted
  const settled = prior.filter((s) => s.document_id === doc.id && (s.status === "ACCEPTED" || s.status === "QUEUED"));
  if (req.resendOfId) {
    if (!prior.some((s) => s.id === req.resendOfId && s.document_id === doc.id)) throw new Error("Choose the earlier send you are repeating.");
    if ((req.resendReason ?? "").trim().length < 3) throw new Error("Give a reason for sending this quotation again.");
  } else if (settled.length > 0) {
    throw new Error("This quotation has already been sent. To send it again, use Send again and give a reason.");
  }

  const { bytes } = await readDocumentBytes(db, orgId, doc.id, deps);
  const subjectBase = `Quotation ${doc.quote_ref} (revision ${doc.revision}) from ${doc.content.company.brandName}`;
  const body = bodyOf(doc, message, doc.content.company.legalName);
  // Policy per recipient: outside Production only the allowlisted mailboxes are emailed; everyone else is suppressed (recorded, never redirected).
  const decide = (addr: string) => applyEmailPolicy(env, { to: addr, subject: subjectBase, text: body });
  const sendTo = to.filter((a) => decide(a).action === "SEND"); const sendCc = cc.filter((a) => decide(a).action === "SEND");
  const suppressed = [...to, ...cc].filter((a) => !sendTo.includes(a) && !sendCc.includes(a));
  const first = decide(sendTo[0] ?? to[0]);
  const subject = first.action === "SEND" ? first.subject : subjectBase; const text = first.action === "SEND" ? first.text : body;

  const ins = await db.from("newquip_quote_sends").insert({
    org_id: orgId, quote_id: quoteId, document_id: doc.id, idempotency_key: req.idempotencyKey, resend_of: req.resendOfId ?? null, resend_reason: req.resendOfId ? (req.resendReason ?? "").trim() : null,
    to_emails: to, cc_emails: cc, suppressed_emails: suppressed, alternative_recipients: alternatives, alternative_reason: alternatives.length ? (req.alternativeReason ?? "").trim() : null, subject, message, status: sendTo.length === 0 ? "SUPPRESSED" : "QUEUED", sent_by_email: who.email, sent_by_owner_email: who.ownerEmail ?? null,
  }).select("*").single();
  if (ins.error || !ins.data) {
    if (/duplicate key|unique/i.test(ins.error?.message ?? "")) { const again = (await listSends(db, orgId, quoteId)).find((s) => s.document_id === doc.id && s.idempotency_key === req.idempotencyKey); if (again) return { send: again, reused: true }; }
    throw new Error(`Could not record the send: ${ins.error?.message ?? "no row"}`);
  }
  const row = ins.data as StoredSend;
  if (row.status === "SUPPRESSED") return { send: row, reused: false }; // nobody on the list may receive it from this environment: nothing leaves
  const links = await responseLinksFor(db, orgId, doc, row, [...sendTo, ...sendCc], who.email, env);
  const withLinks = links ? applyEmailPolicy(env, { to: sendTo[0], subject: subjectBase, text: bodyOf(doc, message, doc.content.company.legalName, links) }) : null;
  const finalText = withLinks && withLinks.action === "SEND" ? withLinks.text : text;
  return { send: await deliver(db, row, doc, bytes, sendTo, sendCc, suppressed, subject, finalText, send, links ? htmlOf(doc, message, links, finalText.startsWith(PREVIEW_BODY_BANNER)) : undefined), reused: false };
}

/** Controlled retry of a FAILED send: the row is claimed FAILED -> QUEUED by compare-and-set, so concurrent retries emit at most one email. */
export async function retryFailedSend(db: Db, orgId: string, sendId: string, deps: Pick<DocumentDeps, "storage">, env: EmailEnv, send: SendFn = defaultSend): Promise<StoredSend> {
  const found = await db.from("newquip_quote_sends").select("*").eq("org_id", orgId).eq("id", sendId).maybeSingle();
  if (found.error) throw new Error(found.error.message);
  const row = found.data as StoredSend | null;
  if (!row) throw new Error("Send not found.");
  if (row.status !== "FAILED") throw new Error(row.status === "ACCEPTED" ? "That send was accepted by the provider; it cannot be retried. Use Send again with a reason." : "Only a failed send can be retried.");
  const q = await loadQuote(db, orgId, row.quote_id);
  const docs = await listDocuments(db, orgId, row.quote_id);
  const doc = docs.find((d) => d.id === row.document_id);
  if (!q || !doc || docs[0].id !== doc.id || doc.revision !== q.revision || doc.baseline_hash !== q.baseline_hash || q.state !== "MANAGER_APPROVED_FINAL") throw new Error("The quotation changed after this send; issue and send the current document instead.");
  const claim = await db.from("newquip_quote_sends").update({ status: "QUEUED", last_error: null }).eq("org_id", orgId).eq("id", sendId).eq("status", "FAILED").select("*");
  if (claim.error) throw new Error(claim.error.message);
  const claimed = ((claim.data ?? []) as StoredSend[])[0];
  if (!claimed) throw new Error("Another retry of this send is already in progress.");
  const { bytes } = await readDocumentBytes(db, orgId, doc.id, deps);
  const body = bodyOf(doc, row.message, doc.content.company.legalName);
  const subjectBase = `Quotation ${doc.quote_ref} (revision ${doc.revision}) from ${doc.content.company.brandName}`;
  const decide = (addr: string) => applyEmailPolicy(env, { to: addr, subject: subjectBase, text: body });
  const sendTo = row.to_emails.filter((a) => decide(a).action === "SEND"); const sendCc = row.cc_emails.filter((a) => decide(a).action === "SEND");
  if (sendTo.length === 0) { const sup = await db.from("newquip_quote_sends").update({ status: "SUPPRESSED", last_error: null }).eq("org_id", orgId).eq("id", sendId).select("*").single(); return sup.data as StoredSend; }
  const first = decide(sendTo[0]);
  // A retry gets a NEW link (the earlier, never-delivered one is revoked by issuing it).
  const links = await responseLinksFor(db, orgId, doc, claimed, [...sendTo, ...sendCc], claimed.sent_by_email, env);
  const withLinks = links ? applyEmailPolicy(env, { to: sendTo[0], subject: subjectBase, text: bodyOf(doc, row.message, doc.content.company.legalName, links) }) : null;
  const text = withLinks && withLinks.action === "SEND" ? withLinks.text : first.action === "SEND" ? first.text : body;
  return deliver(db, claimed, doc, bytes, sendTo, sendCc, [...row.to_emails, ...row.cc_emails].filter((a) => !sendTo.includes(a) && !sendCc.includes(a)), first.action === "SEND" ? first.subject : subjectBase, text, send, links ? htmlOf(doc, row.message, links, text.startsWith(PREVIEW_BODY_BANNER)) : undefined);
}
