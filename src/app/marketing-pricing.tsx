"use client";

import { useState } from "react";
import Link from "next/link";
import Reveal from "@/app/marketing-reveal";
import type { ForeignCurrency, PriceEstimates } from "@/lib/fx";

type Currency = ForeignCurrency | "ZAR";

const CURRENCY_SYMBOL: Record<Currency, string> = { USD: "$", EUR: "€", GBP: "£", ZAR: "R" };

// ZAR 799 is the one real price (what Lemon Squeezy's product is actually
// configured with — see src/lib/fx.ts). Every other currency shown here is
// only ever an estimate: Lemon Squeezy auto-localizes the real ZAR price to
// whatever currency a customer's browser suggests at checkout, so nothing
// this app shows here is the literal amount that gets charged — each is
// computed from a live rate (getPriceEstimates) specifically so it doesn't
// visibly drift from reality as ZAR moves against it, the way a hand-set
// number would.
const ZAR_PRICE = 799;

const CTA_HREF = "/signup";

/**
 * Pricing lives here (not a checkout flow) — Lemon Squeezy isn't activated
 * yet, so this section is informational and still points at the existing
 * free-trial signup. The feature list is accurate to the real gating in
 * src/lib/billing.ts: max_instances is unlimited and canWrite is true only
 * once subscription_status is "active", both false during the trial.
 */
export default function Pricing({ estimates }: { estimates: PriceEstimates }) {
  const [currency, setCurrency] = useState<Currency>("USD");
  const amount = currency === "ZAR" ? ZAR_PRICE : estimates[currency];
  const price = { symbol: CURRENCY_SYMBOL[currency], amount };

  return (
    <section id="pricing" className="border-t border-slate-200 bg-slate-50 py-24">
      <div className="mx-auto max-w-6xl px-6">
        <Reveal className="mx-auto max-w-2xl text-center">
          <p className="font-mono text-xs font-medium uppercase tracking-wide text-indigo-600">Pricing</p>
          <h2 className="mt-4 text-3xl font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
            One plan. Everything included.
          </h2>
          <p className="mt-4 text-lg text-slate-500">7 days free, then a single plan with everything unlocked.</p>
          <p className="mt-3 text-sm text-slate-500">
            Requires your own Cin7 Core account with API access enabled — check{" "}
            <a
              href="https://www.cin7.com/pricing/"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-slate-700 underline hover:text-slate-900"
            >
              Cin7 Core&rsquo;s own pricing
            </a>{" "}
            for plan requirements.
          </p>
        </Reveal>

        <Reveal className="mt-10 flex justify-center">
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1 shadow-sm" role="group" aria-label="Currency">
            {(["USD", "EUR", "GBP", "ZAR"] as const).map((c) => (
              <button
                key={c}
                onClick={() => setCurrency(c)}
                aria-pressed={currency === c}
                className={`rounded-md px-4 py-1.5 text-sm font-semibold transition ${
                  currency === c ? "bg-indigo-600 text-white" : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </Reveal>

        <Reveal className="mx-auto mt-8 w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <p className="text-5xl font-bold tracking-tight text-slate-900">
            {price.symbol}
            {price.amount}
            <span className="text-lg font-medium text-slate-400"> / month</span>
          </p>
          {currency !== "ZAR" && (
            <p className="mt-2 text-xs text-slate-400">
              Billed in ZAR (R{ZAR_PRICE}) — shown here as today&rsquo;s approximate {currency} equivalent.
            </p>
          )}
          <ul className="mt-6 flex flex-col gap-2.5 text-left text-sm text-slate-600">
            {[
              "Unlimited connected Cin7 Core instances",
              "Full write access — sync pushes, bulk fixes, merges",
              "Every module included",
              "Cancel anytime",
            ].map((item) => (
              <li key={item} className="flex items-start gap-2.5">
                <span className="mt-0.5 text-emerald-500">✓</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
          <Link
            href={CTA_HREF}
            className="mt-7 block rounded-lg bg-indigo-600 px-5 py-3 font-semibold text-white shadow-sm transition hover:-translate-y-px hover:bg-indigo-500"
          >
            Start your free 7-day trial →
          </Link>
          <p className="mt-4 font-mono text-xs text-slate-500">No card required for the trial. Billed monthly thereafter.</p>
        </Reveal>
      </div>
    </section>
  );
}
