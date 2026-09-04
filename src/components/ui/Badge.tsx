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
 * Generic status pill for anything that isn't Reporting's own Combined*Status
 * classification (src/app/reports/status-badge.tsx, which encodes real
 * product logic about specific Cin7 status strings and stays where it is,
 * untouched). This is the presentation-only building block everything else
 * — connection state, sync freshness, assurance level — reaches for instead
 * of inventing its own pill styling per page.
 */
export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: React.ReactNode }) {
  return (
    <span className={`inline-block max-w-full whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${TONE_CLASSES[tone]}`}>
      {children}
    </span>
  );
}
