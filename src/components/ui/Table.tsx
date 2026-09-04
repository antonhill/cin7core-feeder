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

export function THead({ children }: { children: React.ReactNode }) {
  return <thead className="border-b border-slate-200 bg-slate-50">{children}</thead>;
}

export function TBody({ children }: { children: React.ReactNode }) {
  return <tbody className="divide-y divide-slate-100">{children}</tbody>;
}

export function TH({
  children,
  align = "left",
  className = "",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-500 ${align === "right" ? "text-right" : "text-left"} ${className}`}
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
  children: React.ReactNode;
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

export function TR({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <tr className={`hover:bg-slate-50 ${className}`}>{children}</tr>;
}
