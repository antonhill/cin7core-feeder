"use server";

// UAT-only presenter sign-in: checks the gate and a server-held access key, then starts a REAL Supabase session for the fixed owner account (server-side
// one-time code, no email sent). It is not an impersonation: the session is the owner's own and every later role switch goes through Demo Mode's audited,
// server-verified path. Only async functions and erased types are exported.
import { timingSafeEqual } from "node:crypto";
import { redirect } from "next/navigation";
import { createServiceRoleClient } from "@/supabase/server";
import { createSessionClient } from "@/supabase/server-session";
import { logActivity } from "@/lib/activity-log";
import { presenterGate } from "@/lib/demo-mode/presenter";

export interface PresenterResult { ok: false; error: string }

const sameKey = (given: string, expected: string): boolean => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export async function presenterSignInAction(_prev: PresenterResult | null, form: FormData): Promise<PresenterResult> {
  const gate = presenterGate(process.env as Record<string, string | undefined>);
  if (!gate.allowed) return { ok: false, error: gate.reason };
  const given = String(form.get("key") ?? "");
  if (!sameKey(given, process.env.NEWQUIP_PRESENTER_ACCESS_KEY ?? "")) {
    await new Promise((r) => setTimeout(r, 1500));
    return { ok: false, error: "That access key is not correct." };
  }
  const admin = createServiceRoleClient();
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: gate.ownerEmail });
  const otp = link.data?.properties?.email_otp;
  if (link.error || !otp) return { ok: false, error: "The presenter account is not set up in this UAT database." };
  const session = await createSessionClient();
  const verified = await session.auth.verifyOtp({ email: gate.ownerEmail, token: otp, type: "magiclink" });
  if (verified.error || !verified.data.user) return { ok: false, error: "Could not start the presenter session." };
  const m = await admin.from("org_members").select("org_id").eq("user_id", verified.data.user.id).limit(1).maybeSingle();
  if (m.data?.org_id) {
    await logActivity(admin, { orgId: m.data.org_id as string, actor: { userId: verified.data.user.id, email: gate.ownerEmail }, action: "newquip.presenter_signin", summary: "[UAT] Presenter session started", detail: { uat: true } }).catch(() => undefined);
  }
  const quoteId = (process.env.NEWQUIP_DEMO_QUOTE_ID ?? "").trim();
  redirect(/^[0-9a-f-]{36}$/.test(quoteId) ? `/newquip-grower/${quoteId}` : "/newquip-grower");
}
