import "server-only";
// Emailed customer-response links. The customer receives an opaque token `<link id>.<secret>`; ONLY the SHA-256 of the secret is stored. The token is bound to the organisation,
// quotation, the exact issued document (id + content hash), the approved revision and baseline, the send's recipients, the permitted actions and an expiry, and it is
// one-shot (a link carries at most one response - enforced by a unique index). A link issued by Preview is refused by Production and the other way round.
// GET never records anything: the public page only SHOWS the quotation; a response needs an explicit POST (see customer-response.ts).
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { createServiceRoleClient } from "@/supabase/server";
import { loadQuote } from "./quote-store";
import { listDocuments, type StoredDocument } from "./document-store";
import type { StoredSend } from "./send-store";
import { countsAsAcceptance, evidenceCounts, listResponses, listReviews, standingOf, type CustomerResponse } from "./acceptance";

type Db = ReturnType<typeof createServiceRoleClient>;
export type LinkEnv = Record<string, string | undefined>;

export const LINK_ACTIONS: readonly CustomerResponse[] = ["ACCEPTED", "DECLINED", "CHANGES_REQUESTED"];
export const MAX_LINK_ATTEMPTS = 25;
export const environmentOf = (env: LinkEnv): "production" | "preview" | "development" => (env.VERCEL_ENV === "production" ? "production" : env.VERCEL_ENV === "preview" ? "preview" : "development");
/** Link lifetime in days: NEWQUIP_RESPONSE_LINK_DAYS, default 14, never below 1 or above 30. */
export function linkTtlDays(env: LinkEnv): number { const n = Number(env.NEWQUIP_RESPONSE_LINK_DAYS); return Number.isFinite(n) && n >= 1 ? Math.min(30, Math.floor(n)) : 14; }

export interface StoredLink {
  id: string; org_id: string; quote_id: string; document_id: string; send_id: string; document_hash: string; baseline_hash: string; revision: number; customer_name: string;
  recipients: string[]; allowed_actions: CustomerResponse[]; token_hash: string; environment: string; expires_at: string; created_by_email: string; created_at: string;
  revoked_at: string | null; revoked_reason: string | null; attempts: number;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function newToken(): { id: string; secret: string; token: string } {
  const id = randomUUID(); const secret = randomBytes(32).toString("base64url");
  return { id, secret, token: `${id}.${secret}` };
}
export function parseToken(raw: string): { id: string; secret: string } | null {
  const t = (raw ?? "").trim();
  const i = t.indexOf(".");
  if (i !== 36 || t.length !== 36 + 1 + 43) return null; // uuid (36) + '.' + 32 random bytes in base64url (43)
  const id = t.slice(0, 36); const secret = t.slice(37);
  return UUID.test(id) && /^[A-Za-z0-9_-]{43}$/.test(secret) ? { id, secret } : null;
}
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const missing = (m: string | undefined) => /does not exist|schema cache|could not find the table/i.test(m ?? "");

/** Issues a link for ONE send of the current issued document. Earlier active links of the quotation are revoked (superseded). The raw token is returned once and never stored. */
export async function issueResponseLink(
  db: Db, p: { orgId: string; doc: StoredDocument; send: StoredSend; recipients: string[]; customerName: string; by: string }, env: LinkEnv, now = new Date(),
): Promise<{ link: StoredLink; token: string }> {
  const { id, secret, token } = newToken();
  const expires = new Date(now.getTime() + linkTtlDays(env) * 86_400_000).toISOString();
  const ins = await db.from("newquip_response_links").insert({
    id, org_id: p.orgId, quote_id: p.doc.quote_id, document_id: p.doc.id, send_id: p.send.id, document_hash: p.doc.content_hash, baseline_hash: p.doc.baseline_hash, revision: p.doc.revision,
    customer_name: p.customerName, recipients: p.recipients, allowed_actions: [...LINK_ACTIONS], token_hash: sha(secret), environment: environmentOf(env), expires_at: expires, created_by_email: p.by, attempts: 0,
  }).select("*").single();
  if (ins.error || !ins.data) throw new Error(`Could not create the response link: ${ins.error?.message ?? "no row"}`);
  await revokeActiveLinks(db, p.orgId, p.doc.quote_id, "Superseded by a newer send of the quotation", id, now);
  return { link: ins.data as StoredLink, token };
}

export async function listLinks(db: Db, orgId: string, quoteId: string): Promise<StoredLink[]> {
  const r = await db.from("newquip_response_links").select("*").eq("org_id", orgId).eq("quote_id", quoteId).order("created_at", { ascending: false });
  if (r.error) { if (missing(r.error.message)) return []; throw new Error(r.error.message); }
  return (r.data ?? []) as StoredLink[];
}

export async function revokeActiveLinks(db: Db, orgId: string, quoteId: string, reason: string, exceptId: string | null = null, now = new Date()): Promise<number> {
  const links = (await listLinks(db, orgId, quoteId)).filter((l) => !l.revoked_at && l.id !== exceptId);
  let n = 0;
  for (const l of links) {
    const up = await db.from("newquip_response_links").update({ revoked_at: now.toISOString(), revoked_reason: reason }).eq("org_id", orgId).eq("id", l.id).is("revoked_at", null).select("id");
    if (!up.error && (up.data ?? []).length) n++;
  }
  return n;
}

export type LinkFailure = "INVALID" | "EXPIRED" | "REVOKED" | "USED" | "SUPERSEDED" | "ALREADY_ACCEPTED" | "PENDING_VERIFICATION" | "LOCKED" | "UNAVAILABLE";
export type Resolved =
  | { ok: true; link: StoredLink; doc: StoredDocument; quote: NonNullable<Awaited<ReturnType<typeof loadQuote>>> }
  | { ok: false; reason: LinkFailure; link?: StoredLink };

/** Counts a failed submission against the link (compare-and-set, so concurrent failures cannot undercount below the truth by more than one). */
export async function noteFailedAttempt(db: Db, link: StoredLink): Promise<void> {
  await db.from("newquip_response_links").update({ attempts: link.attempts + 1 }).eq("org_id", link.org_id).eq("id", link.id).eq("attempts", link.attempts);
}

/** Validates a presented token against everything it is bound to. Never records anything. */
export async function resolveLink(db: Db, rawToken: string, env: LinkEnv, now = new Date()): Promise<Resolved> {
  const t = parseToken(rawToken);
  if (!t) return { ok: false, reason: "INVALID" };
  const r = await db.from("newquip_response_links").select("*").eq("id", t.id).maybeSingle();
  if (r.error) return { ok: false, reason: missing(r.error.message) ? "UNAVAILABLE" : "INVALID" };
  const link = r.data as StoredLink | null;
  if (!link || !sameHash(link.token_hash, sha(t.secret))) {
    if (link) await noteFailedAttempt(db, link); // a wrong secret against a real link id counts toward its lock-out
    return { ok: false, reason: "INVALID" };
  }
  if (link.environment !== environmentOf(env)) return { ok: false, reason: "INVALID", link }; // a Preview link means nothing in Production, and vice versa
  if (link.attempts >= MAX_LINK_ATTEMPTS) return { ok: false, reason: "LOCKED", link };
  if (link.revoked_at) return { ok: false, reason: "REVOKED", link };
  if (new Date(link.expires_at).getTime() <= now.getTime()) return { ok: false, reason: "EXPIRED", link };
  const q = await loadQuote(db, link.org_id, link.quote_id);
  if (!q || q.state !== "MANAGER_APPROVED_FINAL" || !q.baseline_hash) return { ok: false, reason: "SUPERSEDED", link };
  const docs = await listDocuments(db, link.org_id, link.quote_id);
  const doc = docs[0];
  if (!doc || doc.id !== link.document_id || doc.content_hash !== link.document_hash || doc.revision !== link.revision || q.revision !== link.revision || q.baseline_hash !== link.baseline_hash || doc.baseline_hash !== link.baseline_hash) {
    return { ok: false, reason: "SUPERSEDED", link };
  }
  const [responses, reviews, ev] = await Promise.all([listResponses(db, link.org_id, link.quote_id), listReviews(db, link.org_id, link.quote_id), evidenceCounts(db, link.org_id, link.quote_id)]);
  if (responses.some((x) => x.link_id === link.id)) return { ok: false, reason: "USED", link };
  if (responses.some((x) => countsAsAcceptance(x, reviews, ev))) return { ok: false, reason: "ALREADY_ACCEPTED", link };
  if (responses.some((x) => x.document_id === doc.id && x.response === "ACCEPTED" && standingOf(x, reviews, ev) === "PENDING_VERIFICATION")) return { ok: false, reason: "PENDING_VERIFICATION", link };
  return { ok: true, link, doc, quote: q };
}

export const FAILURE_MESSAGE: Record<LinkFailure, string> = {
  INVALID: "This link is not valid. If you were sent a quotation, please use the link in the original email or contact the sender.",
  EXPIRED: "This response link has expired. Please contact the sender for a new link.",
  REVOKED: "This response link is no longer active, usually because a newer version was sent. Please use the most recent email or contact the sender.",
  USED: "A response has already been submitted through this link. Thank you. Please contact the sender if you need to change it.",
  SUPERSEDED: "This quotation has been revised or replaced, so this link can no longer be used. Please contact the sender for the current version.",
  ALREADY_ACCEPTED: "This quotation has already been accepted. No further response is needed.",
  PENDING_VERIFICATION: "Your acceptance has already been received and is being verified by the sender. Thank you.",
  LOCKED: "Too many unsuccessful attempts were made with this link, so it has been locked. Please contact the sender.",
  UNAVAILABLE: "Online responses are not available right now. Please reply to the sender by email.",
};
