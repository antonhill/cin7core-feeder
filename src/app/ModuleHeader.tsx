import type { ModuleConfig } from "@/app/module-nav";

/**
 * Slim page-title bar shown at the top of every module page — icon chip,
 * title, and a short one-line explanation, styled to sit directly on the
 * page background rather than as its own card. Title weight/size bumped
 * (direction Option B) for a clearer page-title/section-title/body/metadata
 * hierarchy at a glance — still restrained, not marketing scale.
 */
export function ModuleHeader({ module, children, variant = "toolbox" }: { module: ModuleConfig; children: React.ReactNode; variant?: "toolbox" | "workspace" }) {
  const Icon = module.Icon;
  // The NewQuip workspace shell already names the area, so its pages get a plain title and one line of context: no gradient chip, no shadow.
  if (variant === "workspace") {
    return (
      <div className="border-b border-slate-200 pb-4">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{module.label}</h1>
        <div className="mt-0.5 max-w-3xl text-sm leading-snug text-slate-600">{children}</div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 border-b border-slate-200 pb-5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex items-center gap-3.5">
        <span
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-sm ${module.gradient}`}
        >
          <Icon className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-[22px] font-bold tracking-tight text-slate-900">{module.label}</h1>
          <div className="mt-0.5 max-w-2xl text-sm leading-snug text-slate-600">{children}</div>
        </div>
      </div>
    </div>
  );
}
