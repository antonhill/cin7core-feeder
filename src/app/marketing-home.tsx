import Image from "next/image";
import Link from "next/link";
import { MODULES, ToolboxLogo, type ModuleConfig } from "@/app/module-nav";
import Reveal from "@/app/marketing-reveal";
import Pricing from "@/app/marketing-pricing";
import { getPriceEstimates } from "@/lib/fx";

/**
 * Public landing page shown at "/" to a visitor with no session (see
 * page.tsx's auth branch and middleware.ts's root carve-out) — default
 * export, no props, matching what page.tsx renders. A server component:
 * the only interactive bits (scroll-reveal, the pricing currency toggle) are
 * split into small client children (marketing-reveal.tsx,
 * marketing-pricing.tsx) so the rest of this page can stay static — this one
 * is `async` only to fetch today's price estimates before render.
 */

// The eight customer-facing modules, pulled from the single source of truth
// by href so labels/blurbs/icons/gradients can't drift from the app itself.
// Deliberately reordered from MODULES' dashboard order into an import →
// migrate → audit → replenish → pricing → health → reports → templates
// narrative — Replenish/Bulk Pricing sit right after Audit since all three
// are "bulk-fix/act on your data" tools, before the health/reports/export
// tools that come after.
const FEATURE_HREFS = ["/import", "/migrate", "/audit", "/replenish", "/pricing", "/health", "/reports", "/templates"];
const FEATURES: ModuleConfig[] = FEATURE_HREFS.map((href) => MODULES.find((m) => m.href === href)).filter(
  (m): m is ModuleConfig => Boolean(m)
);
// public/marketing/*.png — one designed illustration per feature card.
const FEATURE_IMAGE: Record<string, string> = {
  "/import": "/marketing/importsync.png",
  "/migrate": "/marketing/migrate.png",
  "/audit": "/marketing/audit.png",
  "/replenish": "/marketing/replenish.png",
  "/pricing": "/marketing/pricing.png",
  "/health": "/marketing/health.png",
  "/reports": "/marketing/report.png",
  "/templates": "/marketing/templates.png",
};

const CTA_HREF = "/signup";
const TRIAL_LABEL = "Start your free 7-day trial";

export default async function MarketingHome() {
  const priceEstimates = await getPriceEstimates();
  return (
    <main className="bg-white">
      {/* NAV */}
      <nav className="sticky top-0 z-50 border-b border-sidebar-border bg-sidebar-bg/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-3 text-white">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-indigo-700 shadow-sm">
              <ToolboxLogo className="h-5 w-5" />
            </span>
            <span className="font-semibold tracking-tight">Cin7 Core Toolbox</span>
          </div>
          <div className="hidden items-center gap-7 md:flex">
            <a href="#gap" className="text-sm font-medium text-sidebar-text hover:text-white">
              Why
            </a>
            <a href="#features" className="text-sm font-medium text-sidebar-text hover:text-white">
              Features
            </a>
            <a href="#control" className="text-sm font-medium text-sidebar-text hover:text-white">
              How it&rsquo;s safe
            </a>
            <a href="#who" className="text-sm font-medium text-sidebar-text hover:text-white">
              Who it&rsquo;s for
            </a>
            <a href="#pricing" className="text-sm font-medium text-sidebar-text hover:text-white">
              Pricing
            </a>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/login" className="hidden text-sm font-medium text-sidebar-text hover:text-white sm:block">
              Sign in
            </Link>
            <Link
              href={CTA_HREF}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-px hover:bg-indigo-500"
            >
              Start free trial
            </Link>
          </div>
        </div>
      </nav>

      {/* HERO */}
      <header className="relative overflow-hidden bg-sidebar-bg text-slate-200">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px)",
            backgroundSize: "46px 46px",
            maskImage: "radial-gradient(ellipse 75% 70% at 72% 25%, #000 40%, transparent 100%)",
            WebkitMaskImage: "radial-gradient(ellipse 75% 70% at 72% 25%, #000 40%, transparent 100%)",
          }}
        />
        <div className="relative mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-6 py-20 lg:grid-cols-2 lg:py-24">
          <div className="mx-auto max-w-xl text-center lg:mx-0 lg:text-left">
            <p className="font-mono text-xs font-medium uppercase tracking-wide text-indigo-300">The admin layer for Cin7 Core</p>
            <h1 className="mt-5 text-4xl font-bold leading-tight tracking-tight text-white sm:text-5xl">
              Do amazing things
              <br />
              you <span className="text-indigo-300">can&rsquo;t do</span> in Cin7 Core.
            </h1>
            <p className="mt-5 max-w-xl text-lg text-sidebar-text">
              Push one import to every instance, bulk-fix your data, pricing, and reorder points, replenish stock
              across locations, score each instance&rsquo;s health, migrate cleanly, and report on what Cin7 Core keeps
              hidden — all from one console.
            </p>
            <div className="mt-7 flex flex-wrap justify-center gap-3 lg:justify-start">
              <Link
                href={CTA_HREF}
                className="rounded-lg bg-indigo-600 px-5 py-3 font-semibold text-white shadow-sm transition hover:-translate-y-px hover:bg-indigo-500"
              >
                {TRIAL_LABEL} →
              </Link>
              <a
                href="#features"
                className="rounded-lg border border-sidebar-border px-5 py-3 font-semibold text-slate-100 transition hover:-translate-y-px hover:border-slate-600"
              >
                See what it does
              </a>
            </div>
            <p className="mt-5 flex flex-wrap items-center justify-center gap-2 font-mono text-xs text-sidebar-text lg:justify-start">
              <span className="text-emerald-400">●</span> No card required · Connect 1 instance, read-only · See it on your
              own data
            </p>
          </div>
          <Image
            src="/marketing/hero.png"
            alt="From disconnected and uncertain to connected and in control — Cin7 Core Toolbox brings every Cin7 Core instance into one dashboard."
            width={1536}
            height={1024}
            priority
            className="relative w-full rounded-2xl border border-sidebar-border shadow-2xl"
          />
        </div>
      </header>

      {/* GAP */}
      <section id="gap" className="bg-slate-50 py-24">
        <div className="mx-auto max-w-6xl px-6">
          <Reveal className="mb-12 max-w-2xl">
            <p className="font-mono text-xs font-medium uppercase tracking-wide text-indigo-600">The gap</p>
            <h2 className="mt-4 text-3xl font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
              Cin7 Core wasn&rsquo;t built to manage itself.
            </h2>
            <p className="mt-4 text-lg text-slate-500">
              It runs your inventory beautifully. But the moment you have more than one instance — or data that&rsquo;s
              drifted out of shape — you&rsquo;re back in spreadsheets, editing records one at a time and hoping nothing
              broke.
            </p>
          </Reveal>
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              ["One instance at a time", "Adding a product across three entities means keying it in three times — and they drift apart the moment you do."],
              ["Record-by-record cleanup", "Fixing brands, prices, GL accounts or inventory setup across thousands of products is a manual grind."],
              ["No early warning", "Data problems only surface when a report looks wrong or a sync fails — long after the damage is done."],
              ["Reports that stop short", "The question you actually need answered means exporting to Excel and building it yourself, again."],
            ].map(([title, body]) => (
              <Reveal key={title}>
                <div className="h-full rounded-2xl border border-slate-200 bg-white p-6">
                  <p className="font-mono text-xs uppercase tracking-wide text-red-600">✕ today</p>
                  <h4 className="mt-2.5 text-lg font-semibold text-slate-900">{title}</h4>
                  <p className="mt-1.5 text-sm text-slate-500">{body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* FEATURES — from MODULES source of truth */}
      <section id="features" className="py-24">
        <div className="mx-auto max-w-6xl px-6">
          <Reveal className="mb-12 max-w-2xl">
            <p className="font-mono text-xs font-medium uppercase tracking-wide text-indigo-600">What&rsquo;s inside</p>
            <h2 className="mt-4 text-3xl font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
              Eight tools for the work Cin7 Core leaves to you.
            </h2>
            <p className="mt-4 text-lg text-slate-500">
              Connect your instances once, then work across all of them. Every capability targets a specific gap in native
              Cin7 Core administration.
            </p>
          </Reveal>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((m) => {
              const Icon = m.Icon;
              return (
                <Reveal key={m.href}>
                  <div className="h-full overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-lg">
                    <Image src={FEATURE_IMAGE[m.href]} alt="" aria-hidden width={1254} height={1254} className="aspect-square w-full object-cover" />
                    <div className="p-6">
                      <span
                        className={`flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-sm ${m.gradient}`}
                      >
                        <Icon className="h-5 w-5" />
                      </span>
                      <h3 className="mt-4 text-lg font-semibold tracking-tight text-slate-900">{m.label}</h3>
                      <p className="mt-2 text-sm leading-relaxed text-slate-500">{m.blurb}</p>
                    </div>
                  </div>
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      {/* CONTROL / trust band */}
      <section id="control" className="bg-sidebar-bg py-24 text-slate-200">
        <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-11 px-6 lg:grid-cols-2">
          <Reveal>
            <p className="font-mono text-xs font-medium uppercase tracking-wide text-indigo-300">You stay in control</p>
            <h2 className="mt-4 text-2xl font-bold leading-snug tracking-tight text-white sm:text-3xl">
              It writes to live Cin7 data. So it never hides what it did.
            </h2>
            <p className="mt-4 text-base text-sidebar-text">
              Toolbox is powerful because it can change real records across your instances. That power only works if you can
              trust it — so every action is visible, logged, and yours to authorise.
            </p>
          </Reveal>
          <Reveal className="flex flex-col gap-3.5">
            {[
              ["01", "Start read-only", "Connect one instance on the free trial and explore everything before a single record changes."],
              ["02", "Every write is logged", "The Activity Log records every live write — audit fixes, merges and sync pushes — with who triggered it and when."],
              ["03", "Your instances, your keys", "Connect, edit or remove the Cin7 Core instances your organisation syncs to, any time."],
            ].map(([k, title, body]) => (
              <div key={k} className="flex items-start gap-3 rounded-xl border border-sidebar-border bg-sidebar-bg-raised p-4">
                <span className="mt-px font-mono text-sm text-emerald-400">{k}</span>
                <div>
                  <h5 className="text-sm font-semibold text-white">{title}</h5>
                  <p className="mt-0.5 text-sm text-sidebar-text">{body}</p>
                </div>
              </div>
            ))}
          </Reveal>
        </div>
      </section>

      {/* AUDIENCE */}
      <section id="who" className="py-24">
        <div className="mx-auto max-w-6xl px-6">
          <Reveal className="mx-auto mb-12 max-w-2xl text-center">
            <p className="font-mono text-xs font-medium uppercase tracking-wide text-indigo-600">Who it&rsquo;s for</p>
            <h2 className="mt-4 text-3xl font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
              For the people responsible for the data.
            </h2>
          </Reveal>
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              ["// partners", "Implementation partners", "Manage every client's instance from one console. Standardise setups, catch issues before go-live, and cut the manual work out of onboarding."],
              ["// multi-entity", "Multi-entity businesses", "Running several instances across entities or regions? Keep products, customers and suppliers consistent everywhere without re-keying."],
              ["// ops", "Operations & inventory teams", "Own data accuracy with confidence. Spot what's at risk, fix it in bulk, and report on what the platform can't show you."],
            ].map(([icon, title, body]) => (
              <Reveal key={title}>
                <div className="h-full rounded-2xl border border-slate-200 bg-white p-6">
                  <p className="font-mono text-xs text-indigo-600">{icon}</p>
                  <h4 className="mt-3 text-lg font-semibold text-slate-900">{title}</h4>
                  <p className="mt-1.5 text-sm text-slate-500">{body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* PRICING — replaces the old generic closing CTA; itself the closing CTA now */}
      <Pricing estimates={priceEstimates} />

      {/* FOOTER */}
      <footer className="border-t border-sidebar-border bg-sidebar-bg py-9 text-sidebar-text">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 text-sm">
          <div className="flex items-center gap-3 text-white">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-indigo-700">
              <ToolboxLogo className="h-4 w-4" />
            </span>
            <span className="font-semibold">Cin7 Core Toolbox</span>
          </div>
          <p>An independent tool — not affiliated with, or endorsed by, Cin7.</p>
          <p>
            <Link href="/privacy" className="hover:text-white hover:underline">
              Privacy Policy
            </Link>{" "}
            · © 2026
          </p>
        </div>
      </footer>
    </main>
  );
}
