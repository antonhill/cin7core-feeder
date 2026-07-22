// Route segment config applies to every Server Action invoked from any page
// under /migrate (startPullJobAction/continuePullJobAction, and the shared
// push-job actions) — /migrate never had this override at all, unlike
// /import and /reports which each needed their own (Server Actions don't
// automatically pick up a sibling route's maxDuration). Confirmed live
// 2026-07-22: Pull against a real instance (I-Light and LBL / "Lights by
// Linea") failed every time with a bare browser timeout error, no in-app
// message — the Pull step was running under Vercel's much shorter default
// duration. Even with the pull-job rebuild chunking work across fetch
// groups (see pull-instance.ts), each individual group's fetch+import still
// has to complete inside one function call, so this override is required
// regardless.
export const maxDuration = 300;

export default function MigrateLayout({ children }: { children: React.ReactNode }) {
  return children;
}
