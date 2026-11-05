import { pageContainerClass } from "@/app/PageContainer";
import { QuoteSkeleton } from "../QuoteSkeleton";

// UX-007: shown at once while a quotation is being opened (navigation, stage change, role switch reload), before the page itself has loaded.
export default function Loading() {
  return <main className={pageContainerClass("data")}><QuoteSkeleton /></main>;
}
