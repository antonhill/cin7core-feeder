import { ModuleHeader } from "@/app/ModuleHeader";
import { REPORTS_MODULE } from "@/app/module-nav";
import { ReportsNav } from "./ReportsNav";

// Route segment config applies to every Server Action invoked from any page
// under /reports/* (Order Fulfillment's "Sync sales now", Stock Health's
// "Sync stock levels now", Fulfillment Cleanup Helper's sync trigger and
// preview build, etc.) — confirmed live 2026-07-10 that one of these (a
// single-instance product availability sync) hit Vercel's default function
// duration limit. The equivalent standalone routes (/api/sync-sales,
// /api/sync-product-availability, ...) were already raised to 300s; nothing
// under /reports/* had been, since Server Actions don't automatically pick
// up a sibling route's maxDuration.
export const maxDuration = 300;

/**
 * Shared shell for every report under /reports — the ModuleHeader banner and
 * category sidebar (ReportsNav) render once here rather than being
 * duplicated per report page. A new report just adds a route + a ReportsNav
 * entry; it doesn't need its own ModuleHeader or top-level nav/home-tile
 * entry, since "Reporting" (module-nav.tsx's REPORTS_MODULE) is the single
 * org-toggleable module covering all of them. Wider than most module shells
 * (max-w-7xl, not max-w-5xl) to make room for the sidebar alongside a
 * report's own content.
 */
export default function ReportsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-7xl px-6 py-12 print:max-w-none print:p-0">
      <div className="print:hidden">
        <ModuleHeader module={REPORTS_MODULE}>
          A hub for every report pulled from your connected Cin7 instances — Sales
          (revenue/COGS/profit/margin%, pivotable, exportable), Current Assembly
          Costs (quantity + total BOM cost, filterable by status), Production
          Cost Estimator (re-prices every Assembly or Production BOM&rsquo;s
          components under Average/Latest/Fixed cost, exportable), Inventory
          Movement (in/out per product over an adjustable period, with a
          Fast/Medium/Slow mover classification), Stock Health (current
          stock levels combined with velocity — days of cover, excess/stockout
          flagging), Order Fulfillment (a working pick/ship-today
          dashboard, order and product-level detail together), and the
          Fulfillment Cleanup Helper (a completed Bulk Stock Adjustment CSV
          for every oversold SKU, ready to import into Cin7), with more
          report types to come.
        </ModuleHeader>
      </div>
      <div className="mt-6 flex items-start gap-8 print:mt-0 print:block">
        <div className="print:hidden">
          <ReportsNav />
        </div>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </main>
  );
}
