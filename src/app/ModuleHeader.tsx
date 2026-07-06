import type { ModuleConfig } from "@/app/module-nav";

/** The gradient-chip-plus-explanation banner shown at the top of every module page — same visual language as the sidebar nav and home page tiles. */
export function ModuleHeader({ module, children }: { module: ModuleConfig; children: React.ReactNode }) {
  const Icon = module.Icon;
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center">
      <span
        className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-sm ${module.gradient}`}
      >
        <Icon className="h-7 w-7" />
      </span>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{module.label}</h1>
        <div className="mt-1.5 max-w-2xl text-base leading-relaxed text-slate-500">{children}</div>
      </div>
    </div>
  );
}
