"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CASA_DAS_NATAS_ORG_ID } from "@/lib/casa-das-natas";

interface ReportLink {
  href: string;
  label: string;
}

interface ReportCategory {
  label: string;
  links: ReportLink[];
}

/**
 * Grouped sidebar nav for the Reporting hub — mirrors Cin7 Core's own
 * reporting module (a category sidebar: Sale reports / Purchase reports /
 * Inventory reports / etc.) rather than a flat pill row, which stops
 * scaling once there are more than a handful of reports. Add a new report
 * by adding a route under src/app/reports/<name>/ and a link here, under
 * whichever category it belongs to (or a new category if none fits yet) —
 * everything else (the ModuleHeader banner, org-visibility gating on the
 * whole "Reporting" module) is already shared via layout.tsx.
 */
const REPORT_CATEGORIES: ReportCategory[] = [
  {
    label: "Fulfillment",
    links: [
      { href: "/reports/order-fulfillment", label: "Order Fulfillment" },
      { href: "/reports/shipping-calendar", label: "Shipping Calendar" },
      // "Picking Calendar" is appended conditionally in ReportsNav() below,
      // not listed here — unlike every other report on this page, it has
      // its own org-toggleable module (PICKING_CALENDAR_MODULE) and ships
      // off by default, so the link should only show once an admin has
      // turned it on for this org (see module-nav.tsx's own comment on why).
      { href: "/reports/invoicing-scheduler", label: "Invoicing Scheduler" },
      { href: "/reports/fulfillment-cleanup", label: "Fulfillment Cleanup Helper" },
    ],
  },
  { label: "Sales", links: [{ href: "/reports", label: "Sales" }] },
  // "Natas Sold" is appended conditionally in ReportsNav() below, not listed
  // here — it's a Casa das Natas-only report (see
  // src/lib/casa-das-natas.ts), not a category every org should see.
  {
    label: "Costing",
    links: [
      { href: "/reports/assemblies", label: "Current Assembly Costs" },
      { href: "/reports/cost-estimator", label: "Production Cost Estimator" },
    ],
  },
  {
    label: "Manufacturing",
    links: [{ href: "/reports/production-tracking", label: "Production Tracking" }],
  },
  {
    label: "Inventory",
    links: [
      { href: "/reports/inventory-movement", label: "Inventory Movement" },
      { href: "/reports/stock-health", label: "Stock Health" },
      { href: "/reports/reorder-report", label: "Reorder Report" },
    ],
  },
  {
    label: "Custom",
    links: [{ href: "/reports/custom", label: "Custom Reports" }],
  },
];

export function ReportsNav({
  currentOrgId,
  pickingCalendarVisible,
}: {
  currentOrgId: string | null;
  /** Mirrors the Casa das Natas-only link below — a per-org visibility check that isn't a blanket "always show" like every other link here. */
  pickingCalendarVisible: boolean;
}) {
  const pathname = usePathname();

  let categories =
    currentOrgId === CASA_DAS_NATAS_ORG_ID
      ? REPORT_CATEGORIES.map((category) =>
          category.label === "Sales"
            ? { ...category, links: [...category.links, { href: "/reports/natas", label: "Natas Sold" }] }
            : category
        )
      : REPORT_CATEGORIES;

  if (pickingCalendarVisible) {
    categories = categories.map((category) =>
      category.label === "Fulfillment"
        ? {
            ...category,
            links: [
              category.links[0],
              { href: "/reports/picking-calendar", label: "Picking Calendar" },
              ...category.links.slice(1),
            ],
          }
        : category
    );
  }

  return (
    <nav className="sticky top-6 w-56 shrink-0">
      <div className="flex flex-col gap-6">
        {categories.map((category) => (
          <div key={category.label}>
            <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
              {category.label}
            </p>
            <div className="flex flex-col gap-0.5">
              {category.links.map((link) => {
                // "/reports" itself must match exactly — every other report's
                // route also starts with "/reports", which would otherwise make
                // the Sales link look active everywhere.
                const active =
                  link.href === "/reports"
                    ? pathname === "/reports"
                    : pathname.startsWith(link.href);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                      active
                        ? "bg-indigo-50 text-indigo-700"
                        : "text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </nav>
  );
}
