import Link from "next/link";
import { MODULES, ToolboxLogo } from "@/app/module-nav";

/**
 * Public landing page shown at "/" to a visitor with no session (see
 * page.tsx's auth branch and middleware.ts's root carve-out). Reuses
 * MODULES directly for the feature grid so this copy can never drift from
 * what the product actually shows once logged in.
 */
export default function MarketingHome() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <div className="flex items-center gap-4">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-md">
          <ToolboxLogo className="h-8 w-8" />
        </span>
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Cin7 Core Toolbox</h1>
          <p className="mt-1 max-w-2xl text-base text-slate-500">Do amazing things that you cannot do in Cin7 Core.</p>
        </div>
      </div>

      <div className="mt-10 flex flex-wrap items-center gap-3">
        <Link
          href="/signup"
          className="rounded-lg bg-indigo-600 px-5 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-indigo-500"
        >
          Start your free 7-day trial
        </Link>
        <Link href="/login" className="text-base font-medium text-slate-600 hover:text-slate-900 hover:underline">
          Sign in
        </Link>
      </div>
      <p className="mt-3 text-sm text-slate-500">No card required. Connect 1 Cin7 instance and see everything.</p>

      <h2 className="mt-14 text-xl font-semibold text-slate-900">Everything you get</h2>
      <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {MODULES.map((module) => {
          const Icon = module.Icon;
          return (
            <div key={module.href} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <span
                className={`flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-sm ${module.gradient}`}
              >
                <Icon className="h-5 w-5" />
              </span>
              <p className="mt-3.5 text-base font-semibold text-slate-900">{module.label}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-500">{module.blurb}</p>
            </div>
          );
        })}
      </div>

      <div className="mt-14 flex flex-col items-center gap-3 rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <p className="text-xl font-semibold text-slate-900">Ready to see it on your own data?</p>
        <Link
          href="/signup"
          className="rounded-lg bg-indigo-600 px-5 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-indigo-500"
        >
          Start your free 7-day trial
        </Link>
      </div>

      <p className="mt-10 text-center text-sm text-slate-500">
        <Link href="/privacy" className="hover:underline">
          Privacy Policy
        </Link>
      </p>
    </main>
  );
}
