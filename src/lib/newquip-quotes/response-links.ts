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
import { LINK_ACTIONS, MAX_LINK_ATTEMPTS, environmentOf, linkTtlDays, newToken, sha, type LinkEnv, type StoredLink } from "@/lib/newquip-portal/core";
export { LINK_ACTIONS, MAX_LINK_ATTEMPTS, environmentOf, linkTtlDays, newToken, parseToken, FAILURE_MESSAGE } from "@/lib/newquip-portal/core";
export type { LinkEnv, StoredLink, LinkFailure } from "@/lib/newquip-portal/core";

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

