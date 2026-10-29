import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/supabase/server";
import { assertInternalAuth, UnauthorizedError } from "@/lib/internal-auth";
import { deliverPendingEmails, sendOverdueReminders } from "@/lib/approvals/approval-store";

/**
 * GET - Vercel Cron entry point (same bearer-secret auth as the other internal routes). Delivers queued approval emails (bounded attempts; SENT is
 * recorded only when the provider accepted the message) and records overdue reminders. It reads and writes Toolbox tables only: no Cin7 traffic, and
 * it never approves, rejects or otherwise decides anything.
 */
export async function GET(req: Request) {
  try {
    assertInternalAuth(req);
    const db = createServiceRoleClient();
    const reminders = await sendOverdueReminders(db, new Date().toISOString(), process.env.NEXT_PUBLIC_SITE_URL);
    const emails = await deliverPendingEmails(db);
    return NextResponse.json({ ...reminders, ...emails });
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
