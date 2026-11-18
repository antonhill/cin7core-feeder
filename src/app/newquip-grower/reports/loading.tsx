import { pageContainerClass } from "@/app/PageContainer";

export default function Loading() {
  return <main className={pageContainerClass("data")} aria-busy="true"><p className="text-sm text-slate-700" role="status">Loading the report…</p><div className="mt-4 h-40 animate-pulse rounded-lg bg-slate-100" aria-hidden /></main>;
}
