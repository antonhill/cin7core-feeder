"use client";

import { useEffect, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { createBrowserSupabaseClient } from "@/supabase/browser";
import { ModuleHeader } from "@/app/ModuleHeader";
import { SECURITY_MODULE } from "@/app/module-nav";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Alert } from "@/components/ui/Alert";
import { Panel } from "@/components/ui/Panel";

interface MfaFactor {
  id: string;
  friendly_name?: string;
  factor_type: string;
  status: string;
}

/** In-progress enrollment: a freshly-created unverified TOTP factor waiting on its first code. */
interface PendingEnrollment {
  factorId: string;
  qrCode: string;
  secret: string;
}

export default function SecurityPage() {
  const [factors, setFactors] = useState<MfaFactor[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, startLoadTransition] = useTransition();

  const [pending, setPending] = useState<PendingEnrollment | null>(null);
  const [code, setCode] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [isSubmitting, startSubmitTransition] = useTransition();

  // Set when middleware bounced a privileged (super-admin / paid owner-admin)
  // user here to enrol MFA before they can use the rest of the app (Phase 1.5).
  const mfaRequired = useSearchParams().get("mfa") === "required";

  function refresh() {
    startLoadTransition(async () => {
      setLoadError(null);
      const supabase = createBrowserSupabaseClient();
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) {
        setLoadError(error.message);
        return;
      }
      setFactors((data?.totp ?? []) as MfaFactor[]);
      setLoaded(true);
    });
  }

  useEffect(() => {
    refresh();
  }, []);

  function handleEnroll() {
    setActionError(null);
    setActionSuccess(null);
    startSubmitTransition(async () => {
      const supabase = createBrowserSupabaseClient();
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
      if (error) {
        setActionError(error.message);
        return;
      }
      setPending({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
    });
  }

  function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!pending) return;
    setActionError(null);
    startSubmitTransition(async () => {
      const supabase = createBrowserSupabaseClient();
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: pending.factorId });
      if (challengeError) {
        setActionError(challengeError.message);
        return;
      }
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: pending.factorId,
        challengeId: challenge.id,
        code,
      });
      if (verifyError) {
        setActionError(verifyError.message);
        return;
      }
      setPending(null);
      setCode("");
      setActionSuccess("Two-factor authentication is now enabled.");
      refresh();
    });
  }

  function handleCancelEnroll() {
    if (!pending) return;
    startSubmitTransition(async () => {
      const supabase = createBrowserSupabaseClient();
      // Unverified factors don't protect anything yet, but leaving them
      // registered clutters the account with dead enrollments if the user
      // backs out of the QR step — clean it up rather than leaving it orphaned.
      await supabase.auth.mfa.unenroll({ factorId: pending.factorId });
      setPending(null);
      setCode("");
    });
  }

  function handleRemove(factorId: string) {
    if (!confirm("Remove two-factor authentication? You'll only need your email code to sign in.")) return;
    setActionError(null);
    setActionSuccess(null);
    startSubmitTransition(async () => {
      const supabase = createBrowserSupabaseClient();
      const { error } = await supabase.auth.mfa.unenroll({ factorId });
      if (error) {
        setActionError(error.message);
        return;
      }
      setActionSuccess("Two-factor authentication removed.");
      refresh();
    });
  }

  const verifiedFactors = factors.filter((f) => f.status === "verified");

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <ModuleHeader module={SECURITY_MODULE}>
        Add a second step to sign-in using an authenticator app (Google Authenticator, Authy, 1Password, etc.) — after
        your email code, you&rsquo;ll also enter a 6-digit code from the app.
      </ModuleHeader>

      {mfaRequired && verifiedFactors.length === 0 && (
        <div className="mt-6">
          <Alert tone="warning">
            <p className="font-semibold text-amber-900">Two-factor authentication is required for your account.</p>
            <p className="mt-1 text-amber-800">
              Because you can change your organization&rsquo;s data or settings, you need to set up an authenticator app
              before continuing. Finish the setup below to unlock the rest of the app.
            </p>
          </Alert>
        </div>
      )}

      <Panel className="mt-6">
        {loadError && <Alert tone="danger">{loadError}</Alert>}
        {actionError && (
          <div className="mt-2">
            <Alert tone="danger">{actionError}</Alert>
          </div>
        )}
        {actionSuccess && (
          <div className="mt-2">
            <Alert tone="success">{actionSuccess}</Alert>
          </div>
        )}

        {!loaded && !loadError && <p className="text-base text-slate-500">Loading…</p>}

        {loaded && !pending && (
          <>
            {verifiedFactors.length > 0 ? (
              <div className="flex flex-col gap-3">
                <p className="font-medium text-slate-900">Two-factor authentication is enabled.</p>
                {verifiedFactors.map((factor) => (
                  <div key={factor.id} className="flex items-center justify-between rounded-md border border-slate-200 px-4 py-3">
                    <span className="text-sm text-slate-700">{factor.friendly_name || "Authenticator app"}</span>
                    {/* Not the `link` Button variant — that's fixed to text-primary, and this destructive action needs the danger tone (same precedent as Quotes' bare Delete/Discard link). */}
                    <button
                      type="button"
                      onClick={() => handleRemove(factor.id)}
                      disabled={isSubmitting}
                      className="text-sm font-medium text-danger hover:underline disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div>
                <p className="text-base text-slate-600">
                  Two-factor authentication isn&rsquo;t set up yet. Your account is protected only by your email sign-in code.
                </p>
                <Button onClick={handleEnroll} disabled={isLoading} loading={isSubmitting} className="mt-4">
                  Set up two-factor authentication
                </Button>
              </div>
            )}
          </>
        )}

        {pending && (
          <form onSubmit={handleVerify} className="flex flex-col gap-4">
            <p className="font-medium text-slate-900">Scan this QR code with your authenticator app.</p>
            {/* eslint-disable-next-line @next/next/no-img-element -- Supabase returns the QR as an inline SVG data URI, not a remote image */}
            <img src={pending.qrCode} alt="Scan with your authenticator app" className="h-48 w-48 self-center" />
            <p className="text-center text-sm text-slate-500">
              Can&rsquo;t scan it? Enter this code manually: <span className="font-mono">{pending.secret}</span>
            </p>
            <Input
              label="6-digit code from the app"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoFocus
              inputMode="numeric"
              maxLength={6}
              className="text-center font-mono text-lg tracking-widest"
              placeholder="000000"
            />
            <div className="flex gap-3">
              <Button type="submit" loading={isSubmitting} className="flex-1">
                {isSubmitting ? "Verifying…" : "Verify & enable"}
              </Button>
              <Button type="button" variant="secondary" onClick={handleCancelEnroll} disabled={isSubmitting}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Panel>
    </main>
  );
}
