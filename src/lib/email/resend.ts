import "server-only";
import { Resend } from "resend";

export interface SendEmailInput {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
}

export interface SendEmailResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Only real outbound email capability this app has — see P4's own
 * discovery (2026-08-16): OTP/invite emails go through Supabase Auth's
 * fixed templates only, which can't send arbitrary custom content. Kept as
 * a thin wrapper (not spread inline into ship-by-notifications.ts) so a
 * future P5.1 BOM alert — the brief explicitly says "reuse the P4
 * notification pipeline" — can send through the same function without
 * re-deriving provider setup.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    return { ok: false, error: "RESEND_API_KEY / RESEND_FROM_EMAIL not configured" };
  }

  try {
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from,
      to: input.to,
      cc: input.cc?.length ? input.cc : undefined,
      subject: input.subject,
      text: input.text,
    });
    if (result.error) return { ok: false, error: result.error.message };
    return { ok: true, messageId: result.data?.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
