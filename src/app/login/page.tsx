"use client";

import { useState } from "react";
import Link from "next/link";
import { createBrowserSupabaseClient } from "@/supabase/browser";

type Step = "email" | "code";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>("email");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    const supabase = createBrowserSupabaseClient();
    // Deliberately no emailRedirectTo / clickable-link flow — Microsoft
    // Defender's Safe Links (and similar corporate email scanners) pre-visit
    // URLs in incoming mail to scan them, which silently consumes a
    // one-time magic-link code before the user ever clicks it. A typed
    // code has nothing for a scanner to click, so it isn't affected.
    const { error: signInError } = await supabase.auth.signInWithOtp({ email });
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
    // Confirmed live: type: "email" is rejected with "Verify requires a
    // verification type" even though the request genuinely includes it —
    // the token's underlying record was created via the magic-link code
    // path (Supabase's signInWithOtp doesn't distinguish "link" vs "OTP" at
    // request time, only in which email-template variable gets rendered),
    // so it must be verified with the matching (deprecated but still
    // functional) "magiclink" type instead of "email".
    const { error: verifyError } = await supabase.auth.verifyOtp({ email, token: code, type: "magiclink" });
    if (verifyError) {
      // Only re-enable the button on failure — on success, keep it disabled
      // through the redirect below so an impatient second click can't
      // resubmit the same (now-consumed) one-time code and show a confusing
      // "invalid" error immediately after a real, successful sign-in.
      setIsSubmitting(false);
      setError(verifyError.message);
      return;
    }
    // A hard navigation, not router.push()/router.refresh() — right after
    // establishing a brand-new session, a client-side soft transition can
    // render before the fresh session cookie is reliably picked up by
    // middleware (confirmed on /signup's identical pattern — looked like the
    // page hanging on Verifying… until a manual refresh). A full reload
    // always goes through middleware fresh.
    window.location.href = "/";
  }

  return (
    <main className="mx-auto flex min-h-[80vh] w-full max-w-md flex-col justify-center px-6">
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">Cin7 Core Toolbox</h1>
      <p className="mt-2 text-lg text-slate-500">
        {step === "email"
          ? "Enter your email and we'll send you a sign-in code."
          : `Enter the 6-digit code we sent to ${email}.`}
      </p>

      {step === "email" ? (
        <form onSubmit={handleSendCode} className="mt-8 flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
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
          <button
            type="submit"
            disabled={isSubmitting}
            className="rounded-lg bg-indigo-600 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {isSubmitting ? "Sending…" : "Send sign-in code"}
          </button>
          {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        </form>
      ) : (
        <form onSubmit={handleVerifyCode} className="mt-8 flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
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
          <button
            type="submit"
            disabled={isSubmitting}
            className="rounded-lg bg-indigo-600 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {isSubmitting ? "Verifying…" : "Verify & sign in"}
          </button>
          {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
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

      <Link href="/privacy" className="mt-6 self-center text-sm text-slate-500 hover:underline">
        Privacy Policy
      </Link>
    </main>
  );
}
