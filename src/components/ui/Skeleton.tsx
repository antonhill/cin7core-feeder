/**
 * Loading placeholder for content that's about to appear in place (a table
 * about to populate, a card about to load) — distinct from `Spinner`
 * (src/app/Spinner.tsx), which is for a transient action in flight.
 * `motion-safe:animate-pulse` so it sits still rather than pulsing for
 * anyone with reduced motion set — the shimmer is decoration, not the
 * information; the placeholder shape alone still communicates "loading."
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div role="presentation" aria-hidden className={`motion-safe:animate-pulse rounded-md bg-slate-200 ${className}`} />;
}
