"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabaseClient } from "@/supabase/browser";
import { signOutAction } from "@/actions/auth";

export default function MfaChallengePage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    const supabase = createBrowserSupabaseClient();

    const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors();
    const factor = factors?.totp?.find((f) => f.status === "verified");
    if (factorsError || !factor) {
      setIsSubmitting(false);
      setError(factorsError?.message ?? "No two-factor authenticator found on this account.");
      return;
    }

    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: factor.id });
    if (challengeError) {
      setIsSubmitting(false);
      setError(challengeError.message);
      return;
    }

    const { error: verifyError } = await supabase.auth.mfa.verify({ factorId: factor.id, challengeId: challenge.id, code });
    if (verifyError) {
      setIsSubmitting(false);
      setError(verifyError.message);
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-[80vh] w-full max-w-md flex-col justify-center px-6">
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">Two-factor authentication</h1>
      <p className="mt-2 text-lg text-slate-500">Enter the 6-digit code from your authenticator app.</p>

      <form onSubmit={handleVerify} className="mt-8 flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <label className="flex flex-col gap-1.5 text-base">
          <span className="font-medium text-slate-700">Authenticator code</span>
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
          {isSubmitting ? "Verifying…" : "Verify"}
        </button>
        {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </form>

      <form action={signOutAction} className="mt-4 self-center">
        <button type="submit" className="text-sm text-slate-500 hover:underline">
          Sign out instead
        </button>
      </form>
    </main>
  );
}
