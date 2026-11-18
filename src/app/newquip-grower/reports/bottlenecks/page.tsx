import Link from "next/link";
import { pageContainerClass } from "@/app/PageContainer";
import { Alert } from "@/components/ui/Alert";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { reportSession } from "@/lib/newquip-reports/session";
import { bottleneckReport } from "@/lib/newquip-reports/service";
import { parseFilters } from "@/lib/newquip-reports/params";
import { CATEGORY_LABEL, OUTSTANDING_CATEGORIES } from "@/lib/newquip-reports/ops";
import { Bars, Empty, FilterForm, Kpi, Pager, QuoteLink, ReportTabs, SelectField, StageBadge, ageText, fmtDate, queryOf } from "../ReportsUi";

export const dynamic = "force-dynamic";
type SP = Promise<Record<string, string | string[] | undefined>>;
const VIEWS: Array<[string, string]> = [["mine", "My actions"], ["all", "All outstanding"], ["over3", "Waiting over 3 days"], ["over7", "Waiting over 7 days"]];

export default async function BottleneckReportPage({ searchParams }: { searchParams: SP }) {
  const raw = await searchParams; const f = parseFilters(raw); const q = queryOf(raw); const qs = q.toString();
  let s: Awaited<ReturnType<typeof reportSession>> | null = null; let error: string | null = null;
  try { s = await reportSession(); } catch { error = "Your NewQuip access could not be confirmed."; }
  const isManager = !!s?.viewer.roles.has("manager");
  const view = f.view ?? "mine";
  let d: Awaited<ReturnType<typeof bottleneckReport>> | null = null;
  if (s) { try { d = await bottleneckReport(s.db, s.viewer, { ...f, view }); } catch { error = "The report could not be built. Nothing was changed; please try again."; } }
  const tab = (v: string, label: string) => { const n = new URLSearchParams([...q].filter(([k]) => k !== "page")); n.set("view", v); return <Link key={v} href={`/newquip-grower/reports/bottlenecks?${n.toString()}`} aria-current={view === v ? "page" : undefined} className={`inline-flex min-h-11 items-center rounded-md px-3 text-sm ${view === v ? "bg-primary-subtle font-semibold text-indigo-900" : "font-medium text-slate-700 hover:bg-slate-100"}`}>{label}</Link>; };
  return (
    <main className={`${pageContainerClass("data")} space-y-4`}>
      <div className="border-b border-slate-200 pb-4"><h1 className="text-xl font-semibold tracking-tight text-slate-900">Bottlenecks &amp; Outstanding Actions</h1>
        <p className="mt-0.5 max-w-3xl text-sm text-slate-600">What is waiting for action. “Days waiting” counts from when the quotation entered its current state, using recorded workflow timestamps. The 3 and 7 day views are for visibility only: they are not a service-level commitment.</p></div>
      <ReportTabs active="bottlenecks" canSeeCost={!!s?.viewer.canSeeCost} />
      {error && <Alert tone="danger">{error}</Alert>}
      {d && (<>
        <div className="flex flex-wrap gap-1" role="group" aria-label="View">{VIEWS.filter(([v]) => v !== "all" || isManager || true).map(([v, l]) => tab(v, v === "all" && !isManager ? "My role's queue" : l))}</div>
        <FilterForm action="/newquip-grower/reports/bottlenecks" values={{ from: f.from, to: f.to, q: f.q }} exportHref={`/newquip-grower/reports/export/bottlenecks${qs ? `?${qs}` : ""}`}>
          <input type="hidden" name="view" value={view} />
          <SelectField name="action" label="Outstanding action" value={f.action} options={OUTSTANDING_CATEGORIES.map((c) => [c, CATEGORY_LABEL[c]])} />
        </FilterForm>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Kpi label="Showing" value={d.total} /><Kpi label="Waiting over 3 days" value={d.over3} /><Kpi label="Waiting over 7 days" value={d.over7} tone={d.over7 ? "warn" : undefined} />{d.unknownAge > 0 && <Kpi label="Waiting time not recorded" value={d.unknownAge} note="Entry into this state was not time-stamped" />}</div>
        {d.counts.length > 0 && <div className="rounded-lg border border-slate-200 bg-white p-4"><Bars label="Outstanding by action" rows={d.counts.map((c) => ({ label: c.label, count: c.count, href: `/newquip-grower/reports/bottlenecks?view=${isManager ? "all" : "mine"}&action=${c.category}` }))} /></div>}
        {d.total === 0 ? <Empty>{view === "mine" ? "Nothing is waiting on you. Try “All outstanding”." : "Nothing matches. Clear the filters to see all outstanding work."}</Empty> : (<>
          <div className="overflow-x-auto"><Table scrollLabel="Outstanding actions">
            <THead><TR><TH>Quotation</TH><TH>Customer</TH><TH>Required action</TH><TH>Responsible</TH><TH>Entered this state</TH><TH>Days waiting</TH>{s!.viewer.canSeeCost && <TH>Costing blockers</TH>}<TH>Open</TH></TR></THead>
            <TBody>{d.rows.map((r) => (
              <TR key={r.id}><TD><QuoteLink r={r} /></TD><TD>{r.customer || "—"}</TD><TD><StageBadge c={r.category}>{CATEGORY_LABEL[r.category]}</StageBadge><span className="block text-xs text-slate-600">{r.nextAction}</span></TD>
                <TD>{r.waitingOnLabel}{r.assignedTo && <span className="block text-xs text-slate-600">Assigned</span>}</TD><TD className="whitespace-nowrap">{r.since ? fmtDate(r.since) : "Not recorded"}<span className="block text-xs text-slate-600">{r.sinceSource}</span></TD>
                <TD className="whitespace-nowrap tabular-nums">{ageText(r.ageDays)}</TD>{s!.viewer.canSeeCost && <TD className="text-xs">{r.blockers?.length ? r.blockers.join("; ") : "—"}</TD>}
                <TD><Link href={r.href} className="inline-flex min-h-11 items-center text-indigo-700 hover:underline">Open quotation</Link></TD></TR>))}</TBody></Table></div>
          <Pager base="/newquip-grower/reports/bottlenecks" query={q} page={d.page} pages={d.pages} total={d.total} />
        </>)}
      </>)}
    </main>
  );
}
