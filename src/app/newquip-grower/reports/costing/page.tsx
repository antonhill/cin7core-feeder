import Link from "next/link";
import { pageContainerClass } from "@/app/PageContainer";
import { Alert } from "@/components/ui/Alert";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { reportSession } from "@/lib/newquip-reports/session";
import { costingReport } from "@/lib/newquip-reports/service";
import { parseFilters } from "@/lib/newquip-reports/params";
import { MARGIN_BASIS_LABEL, type MarginBasis } from "@/lib/newquip-reports/costing-model";
import { Bars, Empty, FilterForm, Kpi, Pager, ReportTabs, SelectField, money, pct, queryOf } from "../ReportsUi";

// CONFIDENTIAL. Rendered only for a cost-entitled viewer (Estimator / Manager): the server refuses everyone else before any commercial data is read.
export const dynamic = "force-dynamic";
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function CostingReportPage({ searchParams }: { searchParams: SP }) {
  const raw = await searchParams; const f = parseFilters(raw); const q = queryOf(raw); const qs = q.toString();
  let s: Awaited<ReturnType<typeof reportSession>> | null = null; let error: string | null = null;
  try { s = await reportSession(); } catch { error = "Your NewQuip access could not be confirmed."; }
  if (s && !s.viewer.canSeeCost) { error = "Costing & Margin Analysis is confidential and is available to Estimators and Managers only."; }
  let d: Awaited<ReturnType<typeof costingReport>> | null = null;
  if (s && !error) { try { d = await costingReport(s.db, s.viewer, f); } catch { error = "The report could not be built. Nothing was changed; please try again."; } }
  return (
    <main className={`${pageContainerClass("data")} space-y-4`}>
      <div className="border-b border-slate-200 pb-4"><h1 className="text-xl font-semibold tracking-tight text-slate-900">Costing &amp; Margin Analysis</h1>
        <p className="mt-0.5 max-w-3xl text-sm text-slate-600"><strong>Confidential.</strong> Figures come from the quotation engine itself (the same margin sheet used at approval); nothing is recalculated here. Approved quotations show the margin frozen at approval. Other quotations show today&apos;s costing, labelled by how reliable it is.</p></div>
      <ReportTabs active="costing" canSeeCost={!!s?.viewer.canSeeCost} />
      {error && <Alert tone="info">{error}</Alert>}
      {d && (<>
        <FilterForm action="/newquip-grower/reports/costing" values={{ from: f.from, to: f.to, q: f.q }} exportHref={`/newquip-grower/reports/export/costing${qs ? `?${qs}` : ""}`}>
          <SelectField name="basis" label="Margin basis" value={f.basis} options={(Object.keys(MARGIN_BASIS_LABEL) as MarginBasis[]).map((b) => [b, MARGIN_BASIS_LABEL[b]])} />
          <SelectField name="exceptions" label="Exceptions" value={f.exceptionsOnly ? "1" : ""} options={[["1", "Only with exceptions"]]} />
        </FilterForm>
        {d.truncated && <Alert tone="warning">More than {d.cap} quotations match: only the first {d.cap} (by reference) were costed. Narrow the dates to see the rest.</Alert>}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="Selling value (ex VAT)" value={money(d.totals.sellingCents)} note={`${d.totals.quotations} quotation(s)`} />
          <Kpi label="Estimated cost, fully costed" value={money(d.totals.costCents)} note={`Against ${money(d.totals.costedSellingCents)} selling`} />
          <Kpi label="Expected gross profit" value={money(d.totals.gpCents)} note="Fully costed quotations only" />
          <Kpi label="Expected gross margin" value={pct(d.totals.marginPct)} note="Fully costed quotations only" />
          <Kpi label="Incomplete costing exposure" value={money(d.totals.exposureCents)} note="Selling value with no complete cost" tone={d.totals.exposureCents ? "warn" : undefined} />
          <Kpi label="With exceptions" value={d.totals.withExceptions} />
        </div>
        <p className="text-xs text-slate-600">No minimum-margin policy is configured, so no quotation is flagged as “below threshold”. Escalation and per-line freight factors are not itemised in this report: a quotation shows when freight is unrecorded, when an FX rate was overridden and how many price overrides apply.</p>
        {d.totals.byBasis.length > 0 && <div className="rounded-lg border border-slate-200 bg-white p-4"><Bars label="Quotations by margin basis" rows={d.totals.byBasis.map((b) => ({ label: b.label, count: b.count }))} /></div>}
        {d.total === 0 ? <Empty>No quotations match these filters.</Empty> : (<>
          <div className="overflow-x-auto"><Table scrollLabel="Costing and margin">
            <THead><TR><TH>Quotation</TH><TH>Margin basis</TH><TH align="right">Selling (ex VAT)</TH><TH align="right">Est. cost</TH><TH align="right">Gross profit</TH><TH align="right">Margin</TH><TH align="right">Delivery &amp; install</TH><TH>Cost quality</TH><TH>Exceptions</TH><TH>Cost &amp; Verify</TH></TR></THead>
            <TBody>{d.rows.map((r) => (
              <TR key={r.id}><TD><Link href={r.href} className="inline-flex min-h-11 items-center font-medium text-indigo-700 hover:underline">{r.quoteRef}</Link> <span className="text-xs text-slate-600">rev {r.revision}</span><span className="block text-xs text-slate-600">{r.customer || "—"}</span></TD>
                <TD>{MARGIN_BASIS_LABEL[r.basis]}</TD><TD align="right" className="tabular-nums whitespace-nowrap">{money(r.sellingCents)}</TD><TD align="right" className="tabular-nums whitespace-nowrap">{r.costCents == null ? "Unavailable" : money(r.costCents)}</TD>
                <TD align="right" className="tabular-nums whitespace-nowrap">{r.gpCents == null ? "Unavailable" : money(r.gpCents)}</TD><TD align="right" className="tabular-nums">{r.marginPct == null ? "Unavailable" : pct(r.marginPct)}</TD><TD align="right" className="tabular-nums whitespace-nowrap">{money(r.deliveryInstallCents)}</TD>
                <TD className="text-xs">{r.lines ? `${r.lines.verified} verified · ${r.lines.provisional} estimated · ${r.lines.override} manual · ${r.lines.missing} missing` : "Unavailable"}{r.fxOverrideCurrencies.length > 0 && <span className="block text-slate-600">FX override: {r.fxOverrideCurrencies.join(", ")}</span>}</TD>
                <TD className="text-xs">{r.exceptions.length ? r.exceptions.join("; ") : "None"}</TD><TD><Link href={`${r.href}?stage=2`} className="inline-flex min-h-11 items-center text-indigo-700 hover:underline">Open</Link></TD></TR>))}</TBody></Table></div>
          <Pager base="/newquip-grower/reports/costing" query={q} page={d.page} pages={d.pages} total={d.total} />
        </>)}
      </>)}
    </main>
  );
}
