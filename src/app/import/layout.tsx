// Route segment config applies to every Server Action invoked from any page
// under /import (pushToCin7Action) — confirmed live 2026-07-11 that pushing
// a 66-row CSV to 2 instances hit Vercel's default function duration limit
// partway through (6 products went through, then the request failed with no
// error surfaced to the user, leaving the import silently half-applied — no
// way to tell which rows made it across without checking Cin7 directly).
// The same class of bug was already fixed once for /reports/* (see that
// layout's own comment) — Server Actions don't automatically pick up a
// sibling route's maxDuration, so /import needs this override too.
export const maxDuration = 300;

export default function ImportLayout({ children }: { children: React.ReactNode }) {
  return children;
}
