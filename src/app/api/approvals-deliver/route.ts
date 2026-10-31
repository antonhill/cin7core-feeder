import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/supabase/server";
import { assertInternalAuth, UnauthorizedError } from "@/lib/internal-auth";
import { approvalBaseUrl } from "@/lib/approvals/email-policy";
import { deliverPendingEmails, sendOverdueReminders } from "@/lib/approvals/approval-store";
import { APPROVALS_DISABLED } from "@/lib/approvals/kill-switch";
import { emailConfigStatus } from "@/lib/email/resend";

/**
 * GET - Vercel Cron entry point (same bearer-secret auth as the other internal routes). Delivers queued approval emails (bounded attempts; SENT is
 * recorded only when the provider accepted the message) and records overdue reminders. It reads and writes Toolbox tables only: no Cin7 traffic, and
 * it never approves, rejects or otherwise decides anything.
 */
export async function GET(req: Request) {
  try {
    assertInternalAuth(req);
    // Fail safe BEFORE touching the queue. (1) The approvals kill switch stops reminders and sends too. (2) Without a configured provider nothing may claim an attempt: every claim would
    // burn one of the row's three attempts for an email that could not be sent, abandoning queued mail. The queue is shared with Preview deployments and carries no environment tag, so
    // this route must stay unscheduled (see vercel.json) until notifications record the environment that created them.
    if (APPROVALS_DISABLED) return NextResponse.json({ skipped: "approvals are switched off" });
    const cfg = emailConfigStatus();
    if (!cfg.configured) return NextResponse.json({ skipped: "email provider not configured", missing: cfg.missing });
    const db = createServiceRoleClient();
    const reminders = await sendOverdueReminders(db, new Date().toISOString(), approvalBaseUrl(process.env));
    const emails = await deliverPendingEmails(db);
    return NextResponse.json({ ...reminders, ...emails });
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
