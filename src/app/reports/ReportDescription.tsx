/**
 * Explains what a report does and what problem it solves, shown once at the
 * top of every report page (below the shared Reporting ModuleHeader/sidebar,
 * above that report's own controls) — mirrors Cin7 Core's own reporting
 * module, where every report in the list carries its own description
 * rather than leaving the user to infer purpose from a bare title.
 */
export function ReportDescription({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6 rounded-2xl border border-slate-200 bg-slate-50 p-5">
      <p className="font-semibold text-slate-900">{title}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{children}</p>
    </div>
  );
}
