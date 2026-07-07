import type { ModuleConfig } from "@/app/module-nav";

/** Slim page-title bar shown at the top of every module page — icon chip, title, and a short one-line explanation, styled to sit directly on the page background rather than as its own card. */
export function ModuleHeader({ module, children }: { module: ModuleConfig; children: React.ReactNode }) {
  const Icon = module.Icon;
  return (
    <div className="flex flex-col gap-3 border-b border-slate-200 pb-5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex items-center gap-3">
        <span
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-sm ${module.gradient}`}
        >
          <Icon className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900">{module.label}</h1>
          <div className="max-w-2xl text-sm leading-snug text-slate-500">{children}</div>
        </div>
      </div>
    </div>
  );
}
