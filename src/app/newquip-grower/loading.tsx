import { pageContainerClass } from "@/app/PageContainer";
import { QuoteListSkeleton } from "./QuoteSkeleton";

// UX-007: shown at once while the quotation list (or any NewQuip sub-page without its own loading state) is opened.
export default function Loading() {
  return <main className={pageContainerClass("data")}><QuoteListSkeleton what="Loading…" /></main>;
}
