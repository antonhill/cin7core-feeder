import { Spinner } from "@/app/Spinner";

/**
 * A single, page-level "something is happening" indicator — for the cases
 * where one shared pending flag drives several buttons at once (e.g. two
 * export buttons, or every write-action button on the Data Audit page all
 * sharing one isApplying transition). Putting the spinner on each of those
 * buttons individually made all of them light up together even though only
 * one action was actually running; this renders in one fixed spot instead,
 * regardless of scroll position, so it's unambiguous which single thing is
 * in flight. Not for buttons that already have their own distinct pending
 * state (Scan, Load instances, Push, etc.) — those are fine showing their
 * own inline spinner, since only the one clicked button reacts.
 */
export function PageLoadingIndicator({ show, label }: { show: boolean; label: string }) {
  if (!show) return null;
  return (
    <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2.5 rounded-full bg-slate-900 px-4 py-2.5 text-sm font-medium text-white shadow-lg">
      <Spinner className="h-4 w-4" />
      {label}
    </div>
  );
}
