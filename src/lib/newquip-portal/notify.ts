// Queues the Rep's in-app + email notifications for a customer-response event. Shared by the internal Toolbox (verify / reject) and the public portal (a customer responded).
// Deliberately lean: it only INSERTS outbox rows (deduplicated by key). Delivery is the internal outbox's job (see src/lib/newquip-quotes/response-notify.ts), so the public portal
// needs no email-provider credentials. Rows hang off the QUOTATION (migration 0117 quote_id); the latest approval request is attached when one exists, but none is invented.
// No financial figures are included. Preview recipients are filtered by the delivery policy, not here.
import type { createServiceRoleClient } from "@/supabase/server";
import { formatSast } from "@/lib/approvals/time";
import type { StoredResponse } from "./core";

type Db = ReturnType<typeof createServiceRoleClient>;
export type ResponseEvent = "ACCEPTED_PENDING" | "DECLINED" | "CHANGES_REQUESTED" | "VERIFIED" | "REJECTED_ON_VERIFICATION";

const COPY: Record<ResponseEvent, { headline: string; action: string }> = {
  ACCEPTED_PENDING: { headline: "customer accepted - verification required", action: "Open Customer Acceptance, check who responded and that they could accept for the customer, then verify or reject the acceptance. No Project is created until it is verified." },
  DECLINED: { headline: "customer declined", action: "Review the reason in Customer Acceptance and contact the customer. A revised quotation goes through Estimator and Manager approval again." },
  CHANGES_REQUESTED: { headline: "customer requested changes", action: "Review the requested changes in Customer Acceptance. A revised quotation goes through Estimator and Manager approval again." },
  VERIFIED: { headline: "customer acceptance verified", action: "The acceptance is now formal. Open Project Handover to create the Project (nothing is created automatically)." },
  REJECTED_ON_VERIFICATION: { headline: "customer acceptance rejected during verification", action: "The acceptance does not authorise a Project. See the reason in Customer Acceptance and contact the customer." },
};
/**
 * Customer-supplied text (a reason, a name, a company) is UNTRUSTED and ends up in an internal staff email and notification. It must not be able to carry a clickable link, a
 * look-alike address, hidden or direction-changing characters, or unbounded length. Links, web addresses and email addresses are replaced by a visible marker; control, zero-width
 * and bidirectional-override characters become spaces; whitespace is collapsed; length is capped. The readable remainder is kept. (A bare "word.word" that looks like a web
 * address - including a one-letter host such as t.co, an internationalised domain or a dotted IP - is also replaced: a deliberate, slightly over-eager trade for plain-text mail
 * clients that auto-link. Known cost: a missing space after a full stop, "expensive.Please", reads as a host and is replaced.)
 */
export const LINK_MARKER = "[link removed]";
export const EMAIL_MARKER = "[email removed]";
export function safeCustomerText(raw: string | null | undefined, max = 300): string {
  let t = String(raw ?? "")
    .normalize("NFKC")
    // invisible / control / formatting characters: C0+C1 controls, ALL format characters (zero-width, joiners, bidi marks and overrides, soft hyphen, BOM, Unicode TAG characters used to hide text),
    // private-use, line/paragraph separators, plus code points that render as blank (combining grapheme joiner, Hangul fillers, braille blank, variation selectors)
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}͏ᅟᅠㅤﾠ⠀᠋-᠍︀-️\u{E0100}-\u{E01EF}]/gu, " ")
    .replace(/[^\s@]+@[^\s@]+/g, EMAIL_MARKER)                                                                                    // email addresses (mailto auto-links)
    .replace(/(?<![\p{L}\p{N}])(?:(?:https?|ftp|sftp|file|mailto|tel|sms|javascript|vbscript|data|blob):\S*|\p{L}[\p{L}\p{N}+.-]{1,15}:\/\/\S*|www\.\S*)/giu, LINK_MARKER) // known schemes, any scheme://, www.
    .replace(/(?<![\p{L}\p{N}.])\d{1,3}(?:\.\d{1,3}){3}(?![\p{L}\p{N}])(?::\d+)?(?:[\/?#]\S*)?/gu, LINK_MARKER)                    // dotted IPv4 (with optional port/path)
    .replace(/(?<![\p{L}\p{N}])(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}(?::\d+)?(?:[\/?#]\S*)?/gu, LINK_MARKER);                           // bare domains incl. 1-character labels (t.co, x.com) and non-ASCII (IDN) labels
  t = t.replace(/(?:\[link removed\]\s*){2,}/g, `${LINK_MARKER} `).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => !!x && x.includes("@")).map((x) => x.trim().toLowerCase()))];

export interface NotifyParams {
  orgId: string; quoteId: string; quoteRef: string; customerName: string; event: ResponseEvent; response: StoredResponse; recipients: Array<string | null | undefined>;
  by?: string | null; reason?: string | null; at?: string;
  /** The internal Toolbox address used for the "Open" link; null/absent = no link line (the portal knows it only through NEWQUIP_INTERNAL_APP_URL). */
  internalBaseUrl?: string | null;
}

export async function queueResponseNotifications(db: Db, p: NotifyParams): Promise<{ notified: number }> {
  const to = uniq(p.recipients);
  if (!to.length) return { notified: 0 };
  let requestId: string | null = null;
  const rq = await db.from("approval_requests").select("id, revision").eq("org_id", p.orgId).eq("doc_type", "QUOTE").eq("doc_id", p.quoteId);
  if (!rq.error) requestId = ((rq.data ?? []) as Array<{ id: string; revision: number }>).sort((a, b) => b.revision - a.revision)[0]?.id ?? null;
  const copy = COPY[p.event];
  const r = p.response;
  const who = safeCustomerText(r.origin === "CUSTOMER_LINK" ? `${r.contact_name}${r.contact_company ? `, ${r.contact_company}` : ""}` : r.contact_name, 160);
  const safeReason = safeCustomerText(p.reason, 400);
  const reasonLine = safeReason && !/\b(costs?|margins?|mark-?ups?|gross\s+profit|supplier)\b/i.test(safeReason) ? `Reason: ${safeReason}` : "";
  const base = (p.internalBaseUrl ?? "").replace(/\/+$/, "");
  const body = [
    `Quotation ${p.quoteRef} - ${copy.headline}`, "",
    `Customer: ${p.customerName}`, `Response: ${r.response === "ACCEPTED" ? "Accepted" : r.response === "DECLINED" ? "Declined" : "Changes requested"}`,
    `From: ${who}`, `Time: ${formatSast(p.at ?? r.created_at)}`, p.by ? `Recorded by: ${p.by}` : "", reasonLine, "",
    `Required action: ${copy.action}`, base ? `Open: ${base}/newquip-grower/${p.quoteId}?stage=5` : "Open the quotation in NewQuip, Customer Acceptance (Stage 5).",
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");
  const subject = `NewQuip Quotation ${p.quoteRef}: ${copy.headline}`;
  const kind = `CUSTOMER_${p.event}`;
  let notified = 0;
  for (const recipient of to) {
    for (const channel of ["IN_APP", "EMAIL"] as const) {
      const dedupe = `${kind}:${requestId ?? p.quoteId}:${recipient}:${channel}:${r.id}`;
      const ins = await db.from("approval_notifications").insert({
        org_id: p.orgId, request_id: requestId, quote_id: p.quoteId, kind, recipient_email: recipient, channel, subject, body, dedupe_key: dedupe,
        ...(channel === "IN_APP" ? { status: "SENT", sent_at: new Date().toISOString() } : { status: "PENDING" }),
      });
      if (!ins.error && channel === "IN_APP") notified++; // a duplicate-key error means this exact notification already exists
    }
  }
  return { notified };
}
