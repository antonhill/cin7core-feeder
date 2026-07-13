import { ModuleHeader } from "@/app/ModuleHeader";
import { REPLENISH_MODULE } from "@/app/module-nav";
import { ReplenishNav } from "./ReplenishNav";

/**
 * Shared shell for the Replenish module's two tabs — Transfers (the
 * original feature: propose and create Stock Transfers from a chosen
 * source location) and Reorder Points (bulk-set one location's
 * MinimumBeforeReorder/ReorderQuantity across a filtered set of products).
 * Both operate on the same underlying Cin7 concept (per-location
 * ReorderLevels) and reuse the same live product fetch
 * (fetchAllProductsForReplenish), so they live under one module/nav entry
 * with a small tab switcher rather than being split into two separate
 * top-level modules — mirrors the Reports hub's own layout.tsx pattern,
 * scaled down from a full sidebar to a 2-tab pill row since there are only
 * two related views here, not a growing list of reports.
 */
export default function ReplenishLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-[1800px] px-6 py-12">
      <ModuleHeader module={REPLENISH_MODULE}>
        Reads each product&rsquo;s stock-on-hand per location (already synced) against its reorder point — a
        location-specific override when Cin7 has one set, otherwise the product&rsquo;s flat/global minimum.
        <strong> Transfers</strong> proposes and creates Stock Transfers from a chosen source location to top up
        locations that have fallen below it; <strong>Reorder Points</strong> bulk-sets the reorder point itself for
        one location across a Category/Brand/search-filtered set of products.
      </ModuleHeader>
      <div className="mt-6">
        <ReplenishNav />
      </div>
      <div className="mt-6">{children}</div>
    </main>
  );
}
