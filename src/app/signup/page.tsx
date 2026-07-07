"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createBrowserSupabaseClient } from "@/supabase/browser";
import { createSelfServeOrgAction } from "./actions";

type Step = "details" | "code";

export default function SignupPage() {
  const router = useRouter();
  const [orgName, setOrgName] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>("details");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    const supabase = createBrowserSupabaseClient();
    // Same OTP-only approach as /login (no clickable link — see that page's
    // comment on Microsoft Defender's Safe Links pre-consuming magic-link
    // codes). The org isn't created yet at this point — only after the code
    // below is verified, so an unverified email can't start a free trial
    // clock (see createSelfServeOrgAction's own comment).
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
    const { error: verifyError } = await supabase.auth.verifyOtp({ email, token: code, type: "magiclink" });
    if (verifyError) {
      setIsSubmitting(false);
      setError(verifyError.message);
      return;
    }

    const result = await createSelfServeOrgAction(orgName);
    if (!result.ok) {
      setIsSubmitting(false);
      setError(result.error ?? "Unknown error");
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-[80vh] w-full max-w-md flex-col justify-center px-6">
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">Start your free trial</h1>
      <p className="mt-2 text-lg text-slate-500">
        {step === "details"
          ? "7 days, no card required. Connect 1 Cin7 instance and see everything — subscribe when you're ready to push changes."
          : `Enter the 6-digit code we sent to ${email}.`}
      </p>

      {step === "details" ? (
        <form onSubmit={handleSendCode} className="mt-8 flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <label className="flex flex-col gap-1.5 text-base">
            <span className="font-medium text-slate-700">Organization name</span>
            <input
              type="text"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              required
              autoFocus
              className="rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none"
              placeholder="Your company"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-base">
            <span className="font-medium text-slate-700">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
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
            {isSubmitting ? "Verifying…" : "Verify & start trial"}
          </button>
          {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <button
            type="button"
            onClick={() => {
              setStep("details");
              setCode("");
              setError(null);
            }}
            className="text-sm text-slate-500 hover:underline"
          >
            Use a different email
          </button>
        </form>
      )}

      <p className="mt-6 self-center text-sm text-slate-500">
        Already have an account?{" "}
        <Link href="/login" className="text-indigo-600 hover:underline">
          Sign in
        </Link>
      </p>
      <Link href="/privacy" className="mt-2 self-center text-sm text-slate-500 hover:underline">
        Privacy Policy
      </Link>
    </main>
  );
}
