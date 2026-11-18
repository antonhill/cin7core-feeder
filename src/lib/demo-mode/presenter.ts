import { DEMO_OWNER_EMAIL } from "./config";

// NEWQUIP PRESENTER SIGN-IN (pure, client-safe). A UAT-only way for the single presenter to start ONE signed-in session without an emailed code, so the
// existing Demo Mode selector can then switch Rep / Estimator / Manager inside that one browser. The gate is closed unless EVERY condition holds; it is closed
// in Production (VERCEL_ENV), locally, and on any Preview that is not wired to the dedicated UAT Supabase project named by the environment.

export interface PresenterEnv {
  VERCEL_ENV?: string;
  NEWQUIP_PRESENTER_LOGIN_ENABLED?: string;
  NEWQUIP_PRESENTER_ACCESS_KEY?: string;
  NEWQUIP_PRESENTER_SUPABASE_REF?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
  SUPABASE_URL?: string;
}
export type PresenterGate = { allowed: true; ownerEmail: string } | { allowed: false; reason: string };

/** The project ref of a Supabase URL (https://<ref>.supabase.co), or null. */
export function supabaseRef(url: string | undefined): string | null {
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec((url ?? "").trim());
  return m ? m[1] : null;
}

export function presenterGate(env: PresenterEnv): PresenterGate {
  if (env.VERCEL_ENV !== "preview") return { allowed: false, reason: "Presenter sign-in is available only on a Preview deployment." };
  if (env.NEWQUIP_PRESENTER_LOGIN_ENABLED !== "true") return { allowed: false, reason: "Presenter sign-in is switched off." };
  if ((env.NEWQUIP_PRESENTER_ACCESS_KEY ?? "").length < 24) return { allowed: false, reason: "Presenter sign-in is not configured." };
  const want = (env.NEWQUIP_PRESENTER_SUPABASE_REF ?? "").trim();
  const pub = supabaseRef(env.NEXT_PUBLIC_SUPABASE_URL);
  const srv = supabaseRef(env.SUPABASE_URL);
  if (!want || pub !== want || srv !== want) return { allowed: false, reason: "Presenter sign-in is restricted to the dedicated UAT database." };
  return { allowed: true, ownerEmail: DEMO_OWNER_EMAIL };
}
