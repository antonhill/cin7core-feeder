export type BadgeTone = "neutral" | "primary" | "success" | "warning" | "danger" | "info";

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-slate-100 text-slate-600",
  primary: "bg-primary-subtle text-primary",
  success: "bg-success-subtle text-success",
  warning: "bg-warning-subtle text-warning",
  danger: "bg-danger-subtle text-danger",
  info: "bg-info-subtle text-info",
};

/**
 * Generic status indicator for anything that isn't Reporting's own
 * Combined*Status classification (src/app/reports/status-badge.tsx, which
 * encodes real product logic about specific Cin7 status strings and stays
 * where it is, untouched, pill-shaped as it always was). This is the
 * presentation-only building block everything else — connection state,
 * sync freshness, assurance level — reaches for instead of inventing its
 * own pill styling per page. `rounded-md`, not fully round, and an
 * optional leading dot: a more structured "system status" read than a
 * marketing-tag pill, direction Option B.
 */
export function Badge({ tone = "neutral", dot = false, children }: { tone?: BadgeTone; dot?: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-semibold ${TONE_CLASSES[tone]}`}
    >
      {dot && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />}
      {children}
    </span>
  );
}
