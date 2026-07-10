/**
 * Shared click-to-sort column header — first built for the Fulfillment
 * Cleanup Helper's sale-exclusion table, now reused by every report table
 * that lists multiple rows of data. Each page keeps its own sort-column
 * union type, sort state, and sorted-rows memo (row shapes differ too much
 * per report to force through one generic hook) — this module only centralizes
 * the genuinely identical parts: the null-safe comparator and the header
 * button/arrow UI.
 */

/** Nulls sort last regardless of direction — a missing value shouldn't jump to the top just because asc treats it as "smallest". */
export function compareNullable(a: string | number | null | undefined, b: string | number | null | undefined): number {
  const an = a ?? null;
  const bn = b ?? null;
  if (an === null && bn === null) return 0;
  if (an === null) return 1;
  if (bn === null) return -1;
  if (typeof an === "number" && typeof bn === "number") return an - bn;
  return String(an).localeCompare(String(bn));
}

export type SortDirection = "asc" | "desc";

export function SortHeader<TColumn extends string>({
  label,
  column,
  align = "left",
  sortColumn,
  sortDirection,
  onSort,
  thClassName = "py-2 pr-4",
}: {
  label: string;
  column: TColumn;
  align?: "left" | "right";
  sortColumn: TColumn;
  sortDirection: SortDirection;
  onSort: (column: TColumn) => void;
  /** Override the `<th>` wrapper's own classes when a table uses a header style other than the "py-2 pr-4" convention most report tables share (e.g. Assemblies' uppercase/tracking-wide/px-4 header row) — the button/arrow inside inherits font-size/transform/spacing from whatever ancestor styles the caller's own `<tr>` sets, same as a plain `<th>` would. */
  thClassName?: string;
}) {
  const active = sortColumn === column;
  return (
    <th className={`${thClassName} ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1 font-medium hover:text-slate-700 ${active ? "text-slate-700" : "text-slate-500"}`}
      >
        {label}
        <span className="text-slate-400">{active ? (sortDirection === "asc" ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );
}
