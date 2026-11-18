import Link from "next/link";
import { pageContainerClass } from "@/app/PageContainer";
import { Alert } from "@/components/ui/Alert";
import { reportSession } from "@/lib/newquip-reports/session";
import { REPORT_LINKS, ReportTabs } from "./ReportsUi";

// NewQuip Reports landing page. Lists only the reports the viewer may open; each report re-authorises on the server.
export const dynamic = "force-dynamic";

export default async function ReportsHome() {
  let canSeeCost = false; let isManager = false; let error: string | null = null;
  try { const { viewer } = await reportSession(); canSeeCost = viewer.canSeeCost; isManager = viewer.roles.has("manager"); } catch { error = "Your NewQuip access could not be confirmed, so no reports are shown."; }
  const visible = error ? [] : REPORT_LINKS.filter((r) => (!r.cost || canSeeCost) && (r.kind !== "overview" || isManager));
  return (
    <main className={`${pageContainerClass("data")} space-y-4`}>
      <div className="border-b border-slate-200 pb-4">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Reports</h1>
        <p className="mt-0.5 max-w-3xl text-sm text-slate-600">Operational visibility for quotations, costing and outstanding work. Read-only: nothing here changes a quotation, an approval or Cin7.</p>
      </div>
      <ReportTabs active="home" canSeeCost={canSeeCost} />
      {error && <Alert tone="danger">{error}</Alert>}
      <ul className="grid gap-3 sm:grid-cols-2">
        {visible.map((r) => (
          <li key={r.kind}>
            <Link href={r.href} className="block h-full rounded-lg border border-slate-200 bg-white p-4 shadow-sm hover:border-indigo-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
              <span className="text-base font-semibold text-slate-900">{r.label}</span>
              <span className="mt-1 block text-sm text-slate-600">{r.blurb}</span>
            </Link>
          </li>
        ))}
      </ul>
      {!error && !canSeeCost && <p className="text-xs text-slate-600">Costing &amp; Margin Analysis is confidential and is available to Estimators and Managers only.</p>}
    </main>
  );
}
