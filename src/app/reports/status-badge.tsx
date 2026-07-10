/**
 * Shared Combined*Status badge — first built for Order Fulfillment, now
 * reused by the Shipping Calendar's cards too, so a color-scheme change
 * (or a newly-seen status value) only needs fixing in one place.
 *
 * Every Combined* status this app tracks shares the same shape (NOT
 * AVAILABLE/VOIDED, NOT <verb>ED, <verb>ING, PARTIALLY <verb>ED, <verb>ED) —
 * one classifier covers all of them rather than an exhaustive per-value map.
 * A "NOT <verb>ED" status is neutral (Anton, 2026-07-10): a brand-new order
 * hasn't been picked/packed/shipped/invoiced yet by definition, which isn't
 * a problem worth flashing red for — that's reserved for the Overdue/Stuck
 * badges and genuinely-unpaid orders, which actually need attention.
 */
export function statusBadgeClass(status: string | null): string {
  if (!status) return "bg-slate-100 text-slate-500";
  const s = status.toUpperCase();
  if (s === "UNPAID") return "bg-rose-100 text-rose-700";
  if (s === "VOIDED" || s.startsWith("NOT ")) return "bg-slate-100 text-slate-500";
  if (s.startsWith("PARTIALLY") || s.endsWith("ING")) return "bg-amber-100 text-amber-700";
  return "bg-emerald-100 text-emerald-700";
}

export function StatusBadge({ status, wrap = false }: { status: string | null; wrap?: boolean }) {
  if (!status) return <span className="text-xs text-slate-300">—</span>;
  // Table cells are wide enough that a status pill should never wrap (whitespace-nowrap keeps it tidy); a kanban card is not, and its overflow-hidden was silently clipping the tail of a long status instead of showing it — wrap lets the text break onto a second line in that context instead.
  return (
    <span
      className={`inline-block max-w-full rounded-full px-2 py-0.5 text-xs font-semibold ${wrap ? "whitespace-normal break-words" : "whitespace-nowrap"} ${statusBadgeClass(status)}`}
    >
      {status}
    </span>
  );
}
