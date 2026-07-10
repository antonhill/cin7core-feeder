"use client";

import { useEffect, useState, useTransition } from "react";
import { getBillingStatusAction, getCheckoutUrlAction, getManageSubscriptionUrlAction } from "@/actions/billing";
import type { BillingStatus } from "@/lib/billing";
import { ModuleHeader } from "@/app/ModuleHeader";
import { BILLING_MODULE } from "@/app/module-nav";
import { Spinner } from "@/app/Spinner";

const STATUS_LABEL: Record<BillingStatus["status"], string> = {
  trialing: "Free trial",
  active: "Active",
  past_due: "Payment failed",
  canceled: "Canceled",
};

const STATUS_BADGE: Record<BillingStatus["status"], string> = {
  trialing: "bg-amber-100 text-amber-800",
  active: "bg-emerald-100 text-emerald-800",
  past_due: "bg-rose-100 text-rose-700",
  canceled: "bg-slate-100 text-slate-600",
};

/** The lone impure read in this module — pass this function itself (not a call to it) as a useState initializer so it only ever runs once, outside render, same pattern used for "today" defaults elsewhere in this codebase. */
function nowIso(): string {
  return new Date().toISOString();
}

/** Whole days remaining until trialEndsAt, floored at 0 — never shown as negative once a trial has lapsed. */
function daysRemaining(trialEndsAt: string, nowIsoValue: string): number {
  const ms = new Date(trialEndsAt).getTime() - new Date(nowIsoValue).getTime();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

export default function BillingPage() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [now] = useState(nowIso);

  const [redirectError, setRedirectError] = useState<string | null>(null);
  const [isRedirecting, startRedirectTransition] = useTransition();

  useEffect(() => {
    getBillingStatusAction().then((result) => {
      if (!result.ok) {
        setLoadError(result.error ?? "Unknown error");
        setLoaded(true);
        return;
      }
      setStatus(result.data ?? null);
      setLoaded(true);
    });
  }, []);

  function handleSubscribe() {
    setRedirectError(null);
    startRedirectTransition(async () => {
      const result = await getCheckoutUrlAction();
      if (!result.ok || !result.url) {
        setRedirectError(result.error ?? "Unknown error");
        return;
      }
      window.location.href = result.url;
    });
  }

  function handleManage() {
    setRedirectError(null);
    startRedirectTransition(async () => {
      const result = await getManageSubscriptionUrlAction();
      if (!result.ok || !result.url) {
        setRedirectError(result.error ?? "Unknown error");
        return;
      }
      window.location.href = result.url;
    });
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-12">
      <ModuleHeader module={BILLING_MODULE}>
        Trial status and subscription — payments are handled by Lemon Squeezy, not stored or processed here.
      </ModuleHeader>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        {!loaded && (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> Loading…
          </div>
        )}
        {loadError && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>}

        {status && (
          <>
            <div className="flex items-center gap-3">
              <span className={`rounded-full px-3 py-1 text-sm font-semibold ${STATUS_BADGE[status.status]}`}>
                {STATUS_LABEL[status.status]}
              </span>
              {status.status === "trialing" && (
                <span className="text-sm text-slate-500">
                  {daysRemaining(status.trialEndsAt, now)} day
                  {daysRemaining(status.trialEndsAt, now) === 1 ? "" : "s"} left
                </span>
              )}
            </div>

            <p className="mt-3 text-sm text-slate-600">
              {status.status === "trialing" &&
                "Every report and screen is read-only during the trial. Subscribe to enable write actions — syncing to Cin7, marking orders shipped, and everything else that changes your Cin7 data."}
              {status.status === "active" && "Full write access is enabled. Manage your plan, payment method, or cancel any time."}
              {status.status === "past_due" &&
                "Your last payment didn't go through. Write actions are disabled until it's resolved — update your payment method to restore access."}
              {status.status === "canceled" && "Your subscription has ended. Subscribe again to restore write access."}
            </p>

            <div className="mt-5 flex items-center gap-3">
              {status.status === "active" ? (
                <button
                  type="button"
                  onClick={handleManage}
                  disabled={isRedirecting}
                  className="rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  {isRedirecting && <Spinner className="mr-1.5" />}
                  Manage subscription
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSubscribe}
                  disabled={isRedirecting}
                  className="rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  {isRedirecting && <Spinner className="mr-1.5" />}
                  {status.status === "past_due" ? "Update payment" : status.status === "canceled" ? "Subscribe again" : "Subscribe"}
                </button>
              )}
            </div>
            {redirectError && <p className="mt-3 text-sm text-rose-600">{redirectError}</p>}
          </>
        )}
      </section>
    </main>
  );
}
