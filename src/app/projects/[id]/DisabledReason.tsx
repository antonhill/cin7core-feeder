// The visible "why is this disabled" line (D4 F-12). It sits beside the control and is wired to it with aria-describedby, so a keyboard or screen-reader user reaches the
// reason from the control itself - never title-only. Text only: it never decides whether the control is enabled (the caller's own flags do) and the server re-checks everything.
export function DisabledReason({ id, children, className = "" }: { id: string; children: React.ReactNode; className?: string }) {
  return <p id={id} data-testid="disabled-reason" className={`text-xs leading-snug text-slate-600 ${className}`}>{children}</p>;
}
