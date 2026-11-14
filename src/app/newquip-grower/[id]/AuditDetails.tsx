import type { ReactNode } from "react";

// A single collapsed disclosure for technical audit information (hashes, document ids, rule-set versions, price provenance, testing tools). The content stays in the page (collapsed); it is not
// removed, and it is shown to exactly the viewers who could see it before.
export function AuditDetails({ children, testId = "audit-details", className = "mt-2 text-xs text-slate-600", label }: { children: ReactNode; testId?: string; className?: string; /** Distinguishes one row's disclosure from the next for assistive technology; must keep the words "Audit details" at the start. */ label?: string }) {
  return (
    <details className={className} data-testid={testId}>
      <summary aria-label={label} className="inline-flex min-h-11 cursor-pointer items-center font-medium text-slate-700">Audit details</summary>
      <div className="mt-1 space-y-2">{children}</div>
    </details>
  );
}
