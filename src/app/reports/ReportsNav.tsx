"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Secondary nav for the Reporting hub — one entry per report type. Add a new
 * report by adding a route under src/app/reports/<name>/ and a line here;
 * everything else (the ModuleHeader banner, page width, org-visibility
 * gating on the whole "Reporting" module) is already shared via layout.tsx.
 */
const REPORT_TABS = [
  { href: "/reports", label: "Sales" },
  { href: "/reports/assemblies", label: "Current Assembly Costs" },
  { href: "/reports/cost-estimator", label: "Production Cost Estimator" },
];

export function ReportsNav() {
  const pathname = usePathname();

  return (
    <div className="mt-6 flex gap-2 border-b border-slate-200 pb-4">
      {REPORT_TABS.map((tab) => {
        // "/reports" itself must match exactly — every other report's route
        // also starts with "/reports", which would otherwise make the Sales
        // tab look active everywhere.
        const active = tab.href === "/reports" ? pathname === "/reports" : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
              active ? "bg-indigo-600 text-white" : "border border-slate-300 text-slate-600 hover:bg-slate-50"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
