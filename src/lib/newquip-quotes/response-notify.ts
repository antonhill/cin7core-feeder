import "server-only";
// Tells the responsible Rep when a customer responds and when an emailed acceptance is verified or rejected. Reuses the approvals outbox (in-app + email rows, one per recipient and
// event, deduplicated by key) and its delivery path, so the Preview recipient allowlist and the [PREVIEW] subject marking apply unchanged. No financial figures are included.
// The rows are queued by the shared lean module (src/lib/newquip-portal/notify.ts, also used by the public portal). They hang off the QUOTATION, so a quotation that never had an
// approval request (grandfathered) still notifies the Rep; no approval request is invented. This wrapper adds inline delivery where an email provider is configured.
import type { createServiceRoleClient } from "@/supabase/server";
import { emailConfigStatus } from "@/lib/email/resend";
import { approvalBaseUrl, type EmailEnv } from "@/lib/approvals/email-policy";
import { approvalsAvailable, deliverForQuote } from "@/lib/approvals/approval-store";
import { queueResponseNotifications, type NotifyParams, type ResponseEvent } from "@/lib/newquip-portal/notify";

type Db = ReturnType<typeof createServiceRoleClient>;
export type { ResponseEvent };

export async function notifyResponseEvent(db: Db, p: Omit<NotifyParams, "internalBaseUrl">, env: EmailEnv = process.env): Promise<{ notified: number }> {
  if (!(await approvalsAvailable(db))) return { notified: 0 };
  const res = await queueResponseNotifications(db, { ...p, internalBaseUrl: approvalBaseUrl(env) });
  // Inline delivery only where an email provider is configured (the separate public portal holds no provider credentials: its rows stay QUEUED for the internal outbox).
  if (emailConfigStatus().configured) await deliverForQuote(db, p.orgId, p.quoteId).catch(() => undefined); // best effort, under the Preview allowlist
  return res;
}
