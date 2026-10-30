// Pure, dependency-free building blocks shared by the internal Toolbox and the separately deployed PUBLIC customer portal (portal/). Nothing here touches a database, the session,
// Cin7 or any costing code, so importing it into the public portal pulls no internal logic with it. (The portal's import graph is asserted by a test.)
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export type CustomerResponse = "ACCEPTED" | "DECLINED" | "CHANGES_REQUESTED";
export interface StoredResponse {
  id: string; org_id: string; quote_id: string; document_id: string; response: CustomerResponse; contact_name: string; responded_on: string; evidence_ref: string; note: string;
  recorded_by_email: string; recorded_by_owner_email: string | null; created_at: string;
  /** Migration 0117 (absent before it): where the response came from and who the responding contact is. Rows without `origin` are staff-recorded and behave as before. */
  origin?: "STAFF" | "CUSTOMER_LINK"; contact_email?: string | null; contact_source?: string | null; contact_company?: string | null; exception_reason?: string | null;
  authority_confirmed?: boolean; document_hash?: string | null; link_id?: string | null; origin_hint?: string | null;
}
export interface StoredReview { id: string; org_id: string; quote_id: string; response_id: string; decision: "VERIFIED" | "REJECTED"; note: string; reviewed_by_email: string; reviewed_by_owner_email: string | null; created_at: string }
/**
 * Where a response stands. Only a RECORDED (staff, with its evidence) or a VERIFIED (customer-link) acceptance can be a formal acceptance.
 *   STAFF         -> RECORDED. A staff acceptance recorded after migration 0117 (it carries a contact_source) also needs its evidence file(s) to count; one recorded before is unchanged.
 *   CUSTOMER_LINK -> an ACCEPTANCE is PENDING_VERIFICATION until an internal review VERIFIED it (or REJECTED); a decline / change request is informational (RECORDED).
 */
export type Standing = "RECORDED" | "EVIDENCE_MISSING" | "PENDING_VERIFICATION" | "VERIFIED" | "REJECTED";
export function standingOf(r: StoredResponse, reviews: readonly StoredReview[], evidenceByResponse: ReadonlyMap<string, number> = new Map()): Standing {
  if (r.origin === "CUSTOMER_LINK") {
    if (r.response !== "ACCEPTED") return "RECORDED";
    const rv = reviews.find((x) => x.response_id === r.id);
    return !rv ? "PENDING_VERIFICATION" : rv.decision === "VERIFIED" ? "VERIFIED" : "REJECTED";
  }
  if (r.response === "ACCEPTED" && r.contact_source && (evidenceByResponse.get(r.id) ?? 0) === 0) return "EVIDENCE_MISSING";
  return "RECORDED";
}
/** A formal acceptance: an ACCEPTED response that is RECORDED (staff, with evidence) or VERIFIED. */
export const countsAsAcceptance = (r: StoredResponse, reviews: readonly StoredReview[], ev?: ReadonlyMap<string, number>): boolean => {
  if (r.response !== "ACCEPTED") return false;
  const st = standingOf(r, reviews, ev);
  return st === "RECORDED" || st === "VERIFIED";
};

export type LinkEnv = Record<string, string | undefined>;

export const LINK_ACTIONS: readonly CustomerResponse[] = ["ACCEPTED", "DECLINED", "CHANGES_REQUESTED"];
export const MAX_LINK_ATTEMPTS = 25;
/**
 * The environment a link belongs to / is accepted by. Normally the deployment's own VERCEL_ENV. The separately deployed public portal may pin NEWQUIP_LINK_ENVIRONMENT
 * (e.g. "preview" while the POC runs on Preview data); an unrecognised value is ignored, so a typo can never widen what the portal accepts.
 */
export const environmentOf = (env: LinkEnv): "production" | "preview" | "development" => {
  const pinned = env.NEWQUIP_LINK_ENVIRONMENT?.trim().toLowerCase();
  const e = pinned === "production" || pinned === "preview" || pinned === "development" ? pinned : env.VERCEL_ENV;
  return e === "production" ? "production" : e === "preview" ? "preview" : "development";
};
/** Link lifetime in days: NEWQUIP_RESPONSE_LINK_DAYS, default 14, never below 1 or above 30. */
export function linkTtlDays(env: LinkEnv): number { const n = Number(env.NEWQUIP_RESPONSE_LINK_DAYS); return Number.isFinite(n) && n >= 1 ? Math.min(30, Math.floor(n)) : 14; }

export interface StoredLink {
  id: string; org_id: string; quote_id: string; document_id: string; send_id: string; document_hash: string; baseline_hash: string; revision: number; customer_name: string;
  recipients: string[]; allowed_actions: CustomerResponse[]; token_hash: string; environment: string; expires_at: string; created_by_email: string; created_at: string;
  revoked_at: string | null; revoked_reason: string | null; attempts: number;
}

export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
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
export const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export type LinkFailure = "INVALID" | "EXPIRED" | "REVOKED" | "USED" | "SUPERSEDED" | "ALREADY_ACCEPTED" | "PENDING_VERIFICATION" | "LOCKED" | "UNAVAILABLE";
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
const EMAIL = /^[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']{2,}$/;
export const isValidEmail = (e: string): boolean => e.length <= 254 && EMAIL.test(e.trim());
