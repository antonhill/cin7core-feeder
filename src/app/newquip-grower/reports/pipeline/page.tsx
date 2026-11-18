import Link from "next/link";
import { pageContainerClass } from "@/app/PageContainer";
import { Alert } from "@/components/ui/Alert";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { reportSession } from "@/lib/newquip-reports/session";
import { pipelineReport } from "@/lib/newquip-reports/service";
import { parseFilters } from "@/lib/newquip-reports/params";
import { Empty, FilterForm, Kpi, Pager, QuoteLink, ReportTabs, SelectField, StageBadge, ageText, fmtDate, money, queryOf } from "../ReportsUi";

export const dynamic = "force-dynamic";
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function PipelineReportPage({ searchParams }: { searchParams: SP }) {
  const raw = await searchParams; const f = parseFilters(raw); const q = queryOf(raw); const qs = q.toString();
  let s: Awaited<ReturnType<typeof reportSession>> | null = null; let error: string | null = null;
  try { s = await reportSession(); } catch { error = "Your NewQuip access could not be confirmed."; }
  let d: Awaited<ReturnType<typeof pipelineReport>> | null = null;
  if (s) { try { d = await pipelineReport(s.db, s.viewer, f); } catch { error = "The report could not be built. Nothing was changed; please try again."; } }
  const sortHref = (sort: string) => { const n = new URLSearchParams([...q].filter(([k]) => k !== "page")); n.set("sort", sort); n.set("dir", f.sort === sort && f.dir !== "asc" ? "asc" : "desc"); return `/newquip-grower/reports/pipeline?${n.toString()}`; };
  return (
    <main className={`${pageContainerClass("data")} space-y-4`}>
      <div className="border-b border-slate-200 pb-4"><h1 className="text-xl font-semibold tracking-tight text-slate-900">Quotation Pipeline</h1>
        <p className="mt-0.5 max-w-3xl text-sm text-slate-600"><strong>Created by</strong> is who started the quotation. <strong>Assigned to</strong> is shown only where the application recorded a named approver. <strong>Waiting on</strong> is the role responsible for the next action: the application does not give a quotation a permanent Rep or Estimator owner.</p></div>
      <ReportTabs active="pipeline" canSeeCost={!!s?.viewer.canSeeCost} />
      {error && <Alert tone="danger">{error}</Alert>}
      {d && (<>
        <FilterForm action="/newquip-grower/reports/pipeline" values={{ from: f.from, to: f.to, q: f.q, customer: f.customer }} exportHref={`/newquip-grower/reports/export/pipeline${qs ? `?${qs}` : ""}`}>
          <SelectField name="creator" label="Created by" value={f.creator} options={d.facets.creators.map((c) => [c, c])} />
          <SelectField name="assignee" label="Assigned to" value={f.assignee} options={[["unassigned", "Unassigned"], ...d.facets.assignees.map((c) => [c, c] as [string, string])]} />
          <SelectField name="stage" label="Stage" value={f.stage} options={d.facets.stages.map((c) => [c, c])} />
          <SelectField name="status" label="Status" value={f.status} options={d.facets.statuses.map((c) => [c, c])} />
          <label className="flex flex-col gap-1 text-xs font-medium text-slate-700">Customer<input name="customer" defaultValue={f.customer ?? ""} className="min-h-11 rounded-md border border-slate-300 bg-white px-2 text-sm font-normal text-slate-900" /></label>
        </FilterForm>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><Kpi label="Quotations" value={d.total} /><Kpi label="Value (ex VAT)" value={money(d.valueCents)} note={d.withoutValue ? `${d.withoutValue} without a value yet, not counted` : undefined} /></div>
        <p className="text-xs text-slate-600">Value is the approved contract once approved, otherwise the customer-confirmed amount (indicative). Age is measured from when the quotation entered its current stage; where that was not recorded it says so.</p>
        {d.total === 0 ? <Empty>No quotations match these filters. Clear them, or widen the dates.</Empty> : (<>
          <div className="overflow-x-auto"><Table scrollLabel="Quotation pipeline">
            <THead><TR><TH>Quotation</TH><TH>Customer / site</TH><TH><Link href={sortHref("created")} className="hover:underline">Created</Link></TH><TH>Created by</TH><TH>Stage / status</TH><TH>Next action</TH><TH>Waiting on / assigned</TH><TH>Last action by</TH><TH><Link href={sortHref("age")} className="hover:underline">Age in stage</Link></TH><TH align="right"><Link href={sortHref("value")} className="hover:underline">Value (ex VAT)</Link></TH><TH>Customer response</TH><TH>Project</TH></TR></THead>
            <TBody>{d.rows.map((r) => (
              <TR key={r.id}><TD><QuoteLink r={r} /></TD><TD>{r.customer || "—"}<span className="block text-xs text-slate-600">{r.site || "—"}</span></TD><TD className="whitespace-nowrap">{fmtDate(r.createdAt)}</TD><TD className="text-xs">{r.createdBy ?? "Unknown"}</TD>
                <TD><StageBadge c={r.category}>{r.stage}</StageBadge><span className="block text-xs text-slate-600">{r.status}</span></TD><TD>{r.nextAction}</TD>
                <TD>{r.waitingOnLabel}<span className="block text-xs text-slate-600">{r.waitingOn === "Manager" ? (r.assignedTo ? "Assigned" : "Unassigned") : r.waitingOn === "Estimator" ? "Unassigned" : ""}</span></TD>
                <TD className="text-xs">{r.lastActionBy ?? "Not recorded"}<span className="block text-slate-600">{fmtDate(r.lastActionAt)}</span></TD><TD className="whitespace-nowrap">{r.outstanding ? ageText(r.ageDays) : "—"}</TD>
                <TD align="right" className="whitespace-nowrap tabular-nums">{money(r.valueCents)}{r.valueBasis === "CONFIRMED" && <span className="block text-xs text-slate-600">indicative</span>}</TD>
                <TD>{r.customerResponse}</TD><TD>{r.projectId ? <Link href={`/projects/${r.projectId}`} className="inline-flex min-h-11 items-center text-indigo-700 hover:underline">{r.projectRef ?? "Open"}</Link> : "—"}</TD></TR>))}</TBody></Table></div>
          <Pager base="/newquip-grower/reports/pipeline" query={q} page={d.page} pages={d.pages} total={d.total} />
        </>)}
      </>)}
    </main>
  );
}
