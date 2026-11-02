import { Skeleton } from "@/components/ui/Skeleton";

// PERF-001: a page that is still loading shows its FINAL structure straight away - fixed-size blocks where the cards, tabs and tables will be - so nothing jumps when the
// data arrives, with one plain status line saying what it is waiting for. These are placeholders only: they carry no data and decide nothing.

export const Block = Skeleton;

/** The project page before its data arrives: the tab bar and the four summary cards are in their final places. */
export function WorkspaceSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" data-testid="workspace-loading">
      <p className="mt-6 text-sm text-slate-600">Loading the project…</p>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <Block key={i} className="h-28" />)}
      </div>
      <Block className="mt-6 h-12 w-full max-w-4xl" />
      <Block className="mt-6 h-96 w-full" />
    </div>
  );
}

/** The executive overview before its data arrives: the summary cards, the attention list and the milestone table keep their space. */
export function OverviewSkeleton() {
  return (
    <div className="space-y-8" role="status" aria-live="polite" aria-busy="true" data-testid="overview-loading">
      <p className="text-sm text-slate-600">Loading the executive overview…</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <Block key={i} className="h-24" />)}
      </div>
      <Block className="h-24 w-full" />
      <Block className="h-64 w-full" />
    </div>
  );
}
