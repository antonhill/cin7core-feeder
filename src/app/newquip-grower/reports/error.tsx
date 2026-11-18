"use client";
import { pageContainerClass } from "@/app/PageContainer";

export default function ReportError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className={pageContainerClass("data")}>
      <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
        The report could not be loaded. Nothing was changed. <button type="button" onClick={reset} className="font-semibold underline">Try again</button>
      </div>
    </main>
  );
}
