import { ModuleHeader } from "@/app/ModuleHeader";
import { REPORTS_MODULE } from "@/app/module-nav";
import { ReportsNav } from "./ReportsNav";

/**
 * Shared shell for every report under /reports — the ModuleHeader banner and
 * secondary nav (ReportsNav) render once here rather than being duplicated
 * per report page. A new report just adds a route + a ReportsNav entry; it
 * doesn't need its own ModuleHeader or top-level nav/home-tile entry, since
 * "Reporting" (module-nav.tsx's REPORTS_MODULE) is the single org-toggleable
 * module covering all of them.
 */
export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <ModuleHeader module={REPORTS_MODULE}>
        A hub for every report pulled from your connected Cin7 instances — Sales
        (revenue/COGS/profit/margin%, pivotable, exportable), Current Assembly Costs (quantity + total BOM cost,
        filterable by status), and Production Cost Estimator (re-prices every Assembly or Production BOM&rsquo;s
        components under Average/Latest/Fixed cost, exportable), with more report types to come.
      </ModuleHeader>
      <ReportsNav />
      <div className="mt-6">{children}</div>
    </main>
  );
}
