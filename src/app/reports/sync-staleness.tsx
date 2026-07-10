/**
 * Shared sync-staleness helpers — first built for the Fulfillment Cleanup
 * Helper (a tool that turns synced data straight into a real inventory
 * adjustment, where stale source data is a genuine correctness risk), now
 * reused by every report page that shows a "last synced"/"N pending" sync
 * status. Two different staleness signals depending on the sync's own
 * shape: a full snapshot-replace sync (e.g. product_availability) is stale
 * once too much time has passed since its one "last synced" timestamp; a
 * rate-limited queued/detail-phase sync (e.g. sales/purchases detail) is
 * stale whenever anything at all is still pending — there's no safe time
 * threshold for that, since even one un-synced row could be the exact one
 * a user is looking at right now.
 */

/** Past this many hours since a snapshot-replace sync last ran, its data could no longer reflect reality — a plain default, not meant to be precisely tuned. */
export const SNAPSHOT_STALE_HOURS = 4;

/** Outside any component body — Date.now() is an impure call the react-hooks/purity rule flags if made directly during render. */
export function hoursSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60);
}

/** A pulsing badge, not just a static color change — stale source data needs to actually catch the eye rather than blend into the rest of the page. */
export function StaleBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex animate-pulse items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
      ⚠ {label}
    </span>
  );
}

const SYNC_BUTTON_SIZE = {
  xs: "px-3 py-1 text-xs",
  sm: "px-4 py-1.5 text-sm",
} as const;

/** Shared class list for a sync-now button that should visually flash when its data is stale, falling back to the plain neutral style otherwise. `size` matches whichever button size the surrounding page already uses (Fulfillment Cleanup Helper's inline status rows are "xs"; most other report pages' header buttons are "sm"). */
export function staleSyncButtonClass(isStale: boolean, size: keyof typeof SYNC_BUTTON_SIZE = "xs"): string {
  return `rounded-full border font-medium disabled:opacity-50 ${SYNC_BUTTON_SIZE[size]} ${
    isStale ? "animate-pulse border-amber-300 bg-amber-100 text-amber-800 hover:bg-amber-200" : "border-slate-300 text-slate-700 hover:bg-slate-50"
  }`;
}
