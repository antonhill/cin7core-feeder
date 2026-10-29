// Outbound email policy for NewQuip approval notifications (pure; no I/O). The ONLY place that decides whether an approval email may leave the building.
//
// Fail closed: anything that is not exactly Vercel's "production" environment (a Preview, a local run, an unset variable) is RESTRICTED: the subject is marked
// [PREVIEW] and the message goes only to the exact allowlisted test mailboxes. A recipient outside the list is SUPPRESSED, never redirected; the in-app
// notification they have is unaffected. Production behaviour is unchanged (no prefix, no allowlist).

export const PREVIEW_EMAIL_ALLOWLIST: readonly string[] = [
  "testing@sparkconsulting.co.za",
  "rep@sparkconsulting.co.za",
  "estimator@sparkconsulting.co.za",
  "manager@sparkconsulting.co.za",
];
export const PREVIEW_SUBJECT_PREFIX = "[PREVIEW] ";
export const PREVIEW_BODY_BANNER = "NewQuip PREVIEW notification (test environment, not a production message).";
/** Marker stored in last_error for a suppressed email until the database accepts the SUPPRESSED status (migration 0114). */
export const SUPPRESSED_MARK = "SUPPRESSED:";

export type EmailEnv = Readonly<Record<string, string | undefined>>;
export type EmailDecision = { action: "SEND"; subject: string; text: string } | { action: "SUPPRESS"; reason: string };

export const isRestricted = (env: EmailEnv): boolean => env.VERCEL_ENV !== "production";

/** Exact, case-insensitive match against the list: no domain wildcards, no sub-addressing. */
export const isAllowlisted = (email: string): boolean => PREVIEW_EMAIL_ALLOWLIST.includes(email.trim().toLowerCase());

export function applyEmailPolicy(env: EmailEnv, mail: { to: string; subject: string; text: string }): EmailDecision {
  if (!isRestricted(env)) return { action: "SEND", subject: mail.subject, text: mail.text };
  if (!isAllowlisted(mail.to)) return { action: "SUPPRESS", reason: `${mail.to.trim().toLowerCase()} is not on the Preview email allowlist; no email was sent (the in-app notification is unaffected).` };
  const subject = mail.subject.startsWith(PREVIEW_SUBJECT_PREFIX) ? mail.subject : `${PREVIEW_SUBJECT_PREFIX}${mail.subject}`;
  return { action: "SEND", subject, text: `${PREVIEW_BODY_BANNER}\n\n${mail.text}` };
}

/**
 * Where approval links point. NEXT_PUBLIC_SITE_URL wins; otherwise the STABLE per-branch alias (VERCEL_BRANCH_URL), never the per-deployment host
 * (VERCEL_URL), which goes stale at the next push. The deployment host is only the last resort.
 */
export function approvalBaseUrl(env: EmailEnv): string {
  const pick = env.NEXT_PUBLIC_SITE_URL?.trim() || (env.VERCEL_BRANCH_URL ? `https://${env.VERCEL_BRANCH_URL}` : "") || (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : "");
  return pick.replace(/\/+$/, "");
}

/** Free text typed by an approver can mention costs or margins; the email (and notification) never repeats such a reason. It stays on the approval page. */
const CONFIDENTIAL_WORDS = /\b(costs?|costing|margins?|mark-?ups?|gross\s+profit|gp|profit(?:ability)?|landed|supplier\s+price)\b/i;
export const WITHHELD_REASON = "(withheld from email: it appears to mention costs or margins; open the approval to read it)";
export function safeReason(reason: string | null | undefined): string | null {
  const r = (reason ?? "").trim();
  if (!r) return null;
  return CONFIDENTIAL_WORDS.test(r) ? WITHHELD_REASON : r;
}

export interface EmailRowLike { status: string; last_error: string | null; channel?: string }
export type EmailDisplayStatus = "ACCEPTED" | "FAILED" | "SUPPRESSED" | "ABANDONED" | "QUEUED";
/** Honest status: SENT means the provider API accepted the message, not that it reached an inbox. */
export function displayEmailStatus(n: EmailRowLike): EmailDisplayStatus {
  if (n.status === "SUPPRESSED" || (n.status === "ABANDONED" && (n.last_error ?? "").startsWith(SUPPRESSED_MARK))) return "SUPPRESSED";
  if (n.status === "SENT") return "ACCEPTED";
  if (n.status === "FAILED") return "FAILED";
  if (n.status === "ABANDONED") return "ABANDONED";
  return "QUEUED";
}
export const EMAIL_STATUS_NOTE: Record<EmailDisplayStatus, string> = {
  ACCEPTED: "Accepted by the mail provider (Resend). This is not confirmation that it reached the inbox.",
  FAILED: "The provider refused it or could not be reached; it will not be retried automatically on a Preview.",
  SUPPRESSED: "Not sent: the Preview policy only emails the listed test mailboxes. The in-app notification was delivered.",
  ABANDONED: "Failed repeatedly; waiting for a manual retry.",
  QUEUED: "Waiting to be sent.",
};
