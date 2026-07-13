"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/replenish", label: "Transfers" },
  { href: "/replenish/reorder-points", label: "Reorder Points" },
];

/** Two-tab pill nav for the Replenish module — "/replenish" itself must match exactly since every other tab's route also starts with "/replenish". */
export function ReplenishNav() {
  const pathname = usePathname();

  return (
    <div className="flex gap-2">
      {TABS.map((tab) => {
        const active = tab.href === "/replenish" ? pathname === "/replenish" : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
              active ? "bg-indigo-600 text-white" : "border border-slate-300 text-slate-700 hover:bg-slate-50"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
