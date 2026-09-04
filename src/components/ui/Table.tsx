/**
 * Minimal, shared operational-table shell: a horizontally-scrollable
 * container (so a wide table degrades to scroll rather than breaking layout
 * — the brief's own responsive rule) plus a header cell with a real `scope`
 * attribute, which the Phase 1 audit found missing from every sampled table
 * in the app. Row/cell markup otherwise stays plain `<tr>`/`<td>` — a table's
 * actual columns are too different per page to force through one generic
 * row component.
 */
export function Table({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className="w-full overflow-x-auto rounded-lg border border-slate-200">
      <table className={`w-full border-collapse text-sm ${className}`}>{children}</table>
    </div>
  );
}

/** A firmer two-tone rule (bg + a border a shade darker than the row dividers below it) reads as a real header boundary rather than one more thin gray line — direction Option B; deliberately not a literal black rule, which read as too harsh in the live app. */
export function THead({ children }: { children: React.ReactNode }) {
  return <thead className="border-b-2 border-slate-300 bg-slate-50">{children}</thead>;
}

export function TBody({ children }: { children: React.ReactNode }) {
  return <tbody className="divide-y divide-slate-100">{children}</tbody>;
}

export function TH({
  children,
  align = "left",
  className = "",
}: {
  /** Optional — an action/controls column legitimately has no label. */
  children?: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600 ${align === "right" ? "text-right" : "text-left"} ${className}`}
    >
      {children}
    </th>
  );
}

export function TD({
  children,
  align = "left",
  numeric = false,
  className = "",
}: {
  /** Optional — a conditionally-rendered cell (e.g. a badge that only sometimes appears) legitimately has nothing some of the time. */
  children?: React.ReactNode;
  align?: "left" | "right";
  /** Applies `tabular-nums` so numeric columns line up — the reskin's default numeric treatment. Reach for `font-mono` separately, only on identifiers/SKUs/codes where a fixed-width face genuinely helps, never as a blanket "this is a number" costume. */
  numeric?: boolean;
  className?: string;
}) {
  return (
    <td className={`px-3 py-2 text-slate-700 ${align === "right" ? "text-right" : "text-left"} ${numeric ? "tabular-nums" : ""} ${className}`}>
      {children}
    </td>
  );
}

/**
 * `flagged` amplifies a row's EXISTING warning/danger state with a left-edge
 * accent — it must only be passed for a condition the page already computes
 * (needs-reorder, stockout risk, stale, etc.), never invented here. Purely a
 * visual restatement of a fact the row's own data already carries.
 */
export function TR({
  children,
  className = "",
  flagged,
}: {
  children: React.ReactNode;
  className?: string;
  flagged?: "warning" | "danger";
}) {
  const flagClass = flagged === "danger" ? "border-l-2 border-l-danger" : flagged === "warning" ? "border-l-2 border-l-warning" : "";
  return <tr className={`hover:bg-slate-50 ${flagClass} ${className}`}>{children}</tr>;
}
