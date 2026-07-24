// Route segment config applies to every Server Action invoked from any page
// under /supplier-planner (loadSupplierPlanAction) — /supplier-planner never
// had this override at all, unlike /import, /reports, and /migrate, which
// each needed their own (Server Actions don't automatically pick up a
// sibling route's maxDuration). Its live paginated Cin7 fetch
// (fetchAllProductsForSupplierPlanning) is exactly the kind of call this
// matters for, especially now that a persistent rate-limit response retries
// more patiently (src/cin7/http.ts) — a longer retry budget is only useful
// if the function itself doesn't get killed by Vercel's much shorter
// default duration first.
export const maxDuration = 300;

export default function SupplierPlannerLayout({ children }: { children: React.ReactNode }) {
  return children;
}
