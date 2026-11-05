import { Skeleton } from "@/components/ui/Skeleton";

// UX-007: what a NewQuip page shows the instant it is opened, before its data arrives - the final structure in fixed-size blocks, so nothing jumps when the
// data lands. Placeholders only: they carry no data and decide nothing. One status line names what it is waiting for.

/** A single quotation: step rail, summary bar and the working area keep their places. */
export function QuoteSkeleton({ what = "Loading the quotation…" }: { what?: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" data-testid="quote-loading">
      <p className="mt-6 text-sm text-slate-600">{what}</p>
      <Skeleton className="mt-4 h-14 w-full max-w-4xl" />
      <Skeleton className="mt-4 h-12 w-full" />
      <Skeleton className="mt-4 h-96 w-full" />
    </div>
  );
}

/** The quotation list: the heading row and a table of rows keep their places. */
export function QuoteListSkeleton({ what = "Loading quotations…" }: { what?: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" data-testid="quote-list-loading" className="mt-4">
      <p className="text-sm text-slate-600">{what}</p>
      {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="mt-2 h-11 w-full" />)}
    </div>
  );
}
