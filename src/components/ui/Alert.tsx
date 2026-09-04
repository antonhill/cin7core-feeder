export type AlertTone = "info" | "success" | "warning" | "danger";

const TONE_CLASSES: Record<AlertTone, string> = {
  info: "border-info-border bg-info-subtle text-sky-900",
  success: "border-success-border bg-success-subtle text-emerald-900",
  warning: "border-warning-border bg-warning-subtle text-amber-900",
  danger: "border-danger-border bg-danger-subtle text-red-900",
};

/**
 * Replaces the copy-pasted `rounded-lg border ... bg-...-50 ... text-...-700`
 * boxes the Phase 1 audit found repeated per page for error/success
 * messages. `role="alert"` on danger/warning so assistive tech announces it
 * without the page needing to remember to add that itself.
 */
export function Alert({ tone = "info", children }: { tone?: AlertTone; children: React.ReactNode }) {
  const assertive = tone === "danger" || tone === "warning";
  return (
    <div
      role={assertive ? "alert" : "status"}
      className={`rounded-lg border px-3 py-2 text-sm ${TONE_CLASSES[tone]}`}
    >
      {children}
    </div>
  );
}
