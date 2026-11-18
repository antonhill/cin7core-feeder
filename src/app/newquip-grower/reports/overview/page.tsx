import { pageContainerClass } from "@/app/PageContainer";
import { Alert } from "@/components/ui/Alert";
import { reportSession } from "@/lib/newquip-reports/session";
import { overviewReport } from "@/lib/newquip-reports/service";
import { parseFilters } from "@/lib/newquip-reports/params";
import { Bars, Empty, FilterForm, Kpi, Panel, PanelTitle, QuoteLink, ReportTabs, StageBadge, ageText, fmtDate, money, queryOf } from "../ReportsUi";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";

export const dynamic = "force-dynamic";
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function OverviewReportPage({ searchParams }: { searchParams: SP }) {
  const raw = await searchParams; const f = parseFilters(raw); const qs = queryOf(raw).toString();
  let s: Awaited<ReturnType<typeof reportSession>> | null = null; let error: string | null = null;
  try { s = await reportSession(); } catch { error = "Your NewQuip access could not be confirmed."; }
  if (s && !s.viewer.roles.has("manager")) error = "The Management Overview is available to Managers. The Quotation Pipeline and Bottlenecks reports show your own work.";
  let data: Awaited<ReturnType<typeof overviewReport>> | null = null;
  if (s && !error) { try { data = await overviewReport(s.db, s.viewer, f); } catch { error = "The report could not be built. Nothing was changed; please try again."; } }
  const o = data?.overview;
  const link = (action: string) => `/newquip-grower/reports/bottlenecks?action=${action}`;
  return (
    <main className={`${pageContainerClass("data")} space-y-4`}>
      <div className="border-b border-slate-200 pb-4"><h1 className="text-xl font-semibold tracking-tight text-slate-900">Management Overview</h1>
        <p className="mt-0.5 max-w-3xl text-sm text-slate-600">Where every quotation stands today. Values are ex VAT: the approved contract once approved, otherwise the amount the customer confirmed (indicative).</p></div>
      <ReportTabs active="overview" canSeeCost={!!s?.viewer.canSeeCost} />
      {error && <Alert tone="info">{error}</Alert>}
      {o && (<>
        <FilterForm action="/newquip-grower/reports/overview" values={{ from: f.from, to: f.to, q: f.q }} exportHref={`/newquip-grower/reports/export/overview${qs ? `?${qs}` : ""}`} />
        <p className="text-xs text-slate-600">Quotations created in range: {data!.filtered}. Dates filter on the quotation creation date; projects on the project creation date. Generated {fmtDate(o.generatedAt)}.</p>
        {o.total === 0 ? <Empty>No quotations in this range. Clear the dates to see everything.</Empty> : (<>
          <section aria-label="Quotation pipeline" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Open quotations" value={o.open} note="Not yet a Project, excluding declined" href="/newquip-grower/reports/bottlenecks" />
            <Kpi label="Indicative pipeline (ex VAT)" value={money(o.indicativePipelineCents)} note={o.withoutValue ? `${o.withoutValue} open quotation(s) have no value yet and are not counted` : "All open quotations have a value"} />
            <Kpi label="Awaiting Rep action" value={o.awaitingRep} href={link("REP_DRAFT")} />
            <Kpi label="Awaiting Estimator costing" value={o.awaitingEstimator} href={link("ESTIMATOR_REVIEW")} />
            <Kpi label="Awaiting Manager approval" value={o.awaitingManager} href={link("MANAGER_APPROVAL")} />
            <Kpi label="Awaiting customer response" value={o.awaitingCustomer} href={link("AWAITING_CUSTOMER")} />
            <Kpi label="Accepted by customer" value={o.accepted} />
            <Kpi label="Declined, returned or changes requested" value={o.declinedOrReturned} />
          </section>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel><PanelTitle>Quotations by stage</PanelTitle><div className="mt-3"><Bars label="Quotations by stage" rows={o.byCategory.map((c) => ({ label: c.label, count: c.count, note: money(c.valueCents), href: c.category === "COMPLETE" ? undefined : link(c.category) }))} /></div></Panel>
            <Panel><PanelTitle>Projects</PanelTitle>
              <div className="mt-3 grid grid-cols-2 gap-3"><Kpi label="Active projects" value={o.projects.active} /><Kpi label="Quotations converted" value={o.projects.convertedQuotes} /></div>
              {o.projects.byStatus.length ? <div className="mt-3"><Bars label="Projects by status" rows={o.projects.byStatus.map((p) => ({ label: p.status, count: p.count, note: money(p.valueCents) }))} /></div> : <p className="mt-3 text-sm text-slate-600">No projects yet.</p>}
              <p className="mt-3 text-xs text-slate-600">Projects awaiting the next milestone: not available here. Milestone progress is reported per project, so it is not summarised in this report.</p></Panel>
          </div>
          <Panel><PanelTitle>Work requiring attention (longest waiting first)</PanelTitle>
            {o.attention.length === 0 ? <p className="mt-3 text-sm text-slate-700">Nothing is waiting.</p> : (
              <div className="mt-3 overflow-x-auto"><Table scrollLabel="Work requiring attention"><THead><TR><TH>Quotation</TH><TH>Customer</TH><TH>Stage</TH><TH>Next action</TH><TH>Responsible</TH><TH>Age in stage</TH></TR></THead>
                <TBody>{o.attention.map((r) => (<TR key={r.id}><TD><QuoteLink r={r} /></TD><TD>{r.customer || "—"}</TD><TD><StageBadge c={r.category}>{r.stage}</StageBadge></TD><TD>{r.nextAction}</TD><TD>{r.waitingOnLabel}</TD><TD className="whitespace-nowrap">{ageText(r.ageDays)}</TD></TR>))}</TBody></Table></div>)}
          </Panel>
        </>)}
      </>)}
    </main>
  );
}
