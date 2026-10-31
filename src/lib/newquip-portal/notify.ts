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
  const who = r.origin === "CUSTOMER_LINK" ? `${r.contact_name}${r.contact_company ? `, ${r.contact_company}` : ""}` : r.contact_name;
  const reasonLine = p.reason && !/\b(costs?|margins?|mark-?ups?|gross\s+profit|supplier)\b/i.test(p.reason) ? `Reason: ${p.reason.trim().slice(0, 400)}` : "";
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
