import Link from "next/link";
import { MODULES, ToolboxLogo } from "@/app/module-nav";
import { getCurrentUserInfo } from "@/actions/auth";

export default async function Home({ searchParams }: { searchParams: Promise<{ blocked?: string }> }) {
  const { disabledModules } = await getCurrentUserInfo();
  const { blocked } = await searchParams;
  const visibleModules = MODULES.filter((m) => !disabledModules.includes(m.href));
  const blockedModule = blocked ? MODULES.find((m) => m.href === blocked) : undefined;

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <div className="flex items-center gap-4">
        <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-md">
          <ToolboxLogo className="h-9 w-9" />
        </span>
        <div>
          <h1 className="text-4xl font-bold tracking-tight text-slate-900">Cin7 Core Toolbox</h1>
          <p className="mt-1 max-w-2xl text-lg text-slate-500">Do amazing things that you cannot do in Cin7 Core.</p>
        </div>
      </div>

      {blockedModule && (
        <p className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {blockedModule.label} isn&rsquo;t enabled for your organization — ask your admin if you need access.
        </p>
      )}

      <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {visibleModules.map((module) => {
          const Icon = module.Icon;
          return (
            <Link
              key={module.href}
              href={module.href}
              className="group rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-1 hover:border-slate-300 hover:shadow-lg"
            >
              <span
                className={`flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-sm transition-transform group-hover:scale-105 ${module.gradient}`}
              >
                <Icon className="h-6 w-6" />
              </span>
              <p className="mt-4 text-lg font-semibold text-slate-900">{module.label}</p>
              <p className="mt-2 text-base leading-relaxed text-slate-500">{module.blurb}</p>
            </Link>
          );
        })}
      </div>
    </main>
  );
}
