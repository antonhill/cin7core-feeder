"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createBrowserSupabaseClient } from "@/supabase/browser";
import { Spinner } from "@/app/Spinner";
import { completeNewquipSignInAction } from "@/actions/newquip-access";
import { NEWQUIP_ENTRY_COOKIE, NEWQUIP_ENTRY_COOKIE_MAX_AGE, NEWQUIP_NO_ACCESS_MESSAGE, safeNewquipNext } from "@/newquip/entry";

type Step = "email" | "code";

// NewQuip-branded sign-in over the SAME Supabase email-code auth as /login (no second auth system). Branding is NewQuip only.
function NewquipLoginForm() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>("email");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Remember that this browser signs in via NewQuip (no secrets): middleware also sets it on render.
  useEffect(() => {
    try { document.cookie = `${NEWQUIP_ENTRY_COOKIE}=1; path=/; max-age=${NEWQUIP_ENTRY_COOKIE_MAX_AGE}; SameSite=Lax`; } catch { /* non-essential */ }
  }, []);

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    const supabase = createBrowserSupabaseClient();
    // Typed code, no clickable link (email scanners consume one-time links); shouldCreateUser:false so this can never self-register (see /login).
    const { error: signInError } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    setIsSubmitting(false);
    if (signInError) {
      setError(signInError.message);
      return;
    }
    setStep("code");
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    const supabase = createBrowserSupabaseClient();
    const { error: verifyError } = await supabase.auth.verifyOtp({ email, token: code, type: "magiclink" });
    if (verifyError) {
      setIsSubmitting(false);
      setError(verifyError.message);
      return;
    }
    // Server decides NewQuip access (member of the NewQuip organisation, or super-admin) and selects the NewQuip organisation for multi-org users.
    const access = await completeNewquipSignInAction().catch(() => ({ ok: false as const, error: "We could not confirm your access. Please try again." }));
    if (!access.ok) {
      const refused = access.error === NEWQUIP_NO_ACCESS_MESSAGE;
      if (refused) await supabase.auth.signOut().catch(() => undefined);
      setIsSubmitting(false);
      setError(refused ? NEWQUIP_NO_ACCESS_MESSAGE : (access.error ?? "We could not confirm your access. Please try again."));
      if (refused) { setStep("email"); setCode(""); }
      return;
    }
    // Hard navigation (fresh session cookie must go through middleware), same-origin NewQuip-only `next`, else the NewQuip dashboard.
    window.location.href = safeNewquipNext(searchParams.get("next")) ?? "/";
  }

  const cardClass = "mt-8 flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm";
  const buttonClass = "rounded-lg bg-indigo-600 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50";
  return (
    <main className="mx-auto flex min-h-[80vh] w-full max-w-md flex-col justify-center px-6">
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">NewQuip</h1>
      <p className="mt-2 text-lg text-slate-500">
        {step === "email" ? "Enter your email and we'll send you a sign-in code." : `Enter the 6-digit code we sent to ${email}.`}
      </p>

      {step === "email" ? (
        <form onSubmit={handleSendCode} className={cardClass}>
          <label className="flex flex-col gap-1.5 text-base">
            <span className="font-medium text-slate-700">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              className="rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none"
              placeholder="you@company.com"
            />
          </label>
          <button type="submit" disabled={isSubmitting} className={buttonClass}>
            {isSubmitting && <Spinner className="mr-1.5" />}
            {isSubmitting ? "Sending…" : "Send sign-in code"}
          </button>
          {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        </form>
      ) : (
        <form onSubmit={handleVerifyCode} className={cardClass}>
          <label className="flex flex-col gap-1.5 text-base">
            <span className="font-medium text-slate-700">6-digit code</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoFocus
              inputMode="numeric"
              maxLength={6}
              className="rounded-lg border border-slate-300 px-3 py-2 text-center font-mono text-lg tracking-widest focus:border-indigo-500 focus:outline-none"
              placeholder="000000"
            />
          </label>
          <button type="submit" disabled={isSubmitting} className={buttonClass}>
            {isSubmitting && <Spinner className="mr-1.5" />}
            {isSubmitting ? "Verifying…" : "Verify & sign in"}
          </button>
          {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <button
            type="button"
            onClick={() => {
              setStep("email");
              setCode("");
              setError(null);
            }}
            className="text-sm text-slate-500 hover:underline"
          >
            Use a different email
          </button>
        </form>
      )}
    </main>
  );
}

export default function NewquipLoginPage() {
  return (
    <Suspense fallback={null}>
      <NewquipLoginForm />
    </Suspense>
  );
}
