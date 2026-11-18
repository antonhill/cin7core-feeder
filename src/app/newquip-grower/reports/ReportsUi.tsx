import Link from "next/link";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Status } from "@/components/ui/Status";
import type { BadgeTone } from "@/components/ui/Badge";
import { formatZarCents } from "@/lib/format-money";
import { ageText, fmtDate, type Category, type PipelineRow } from "@/lib/newquip-reports/ops";

// Presentation only (server-rendered, no client state, no chart library). It is handed view-models that were already built for the authorised viewer: nothing here fetches data.
export const money = (c: number | null | undefined) => formatZarCents(c, "—");
export const pct = (n: number | null | undefined) => (n == null ? "—" : `${n.toFixed(2)}%`);

export const REPORT_LINKS = [
  { kind: "overview", href: "/newquip-grower/reports/overview", label: "Management Overview", blurb: "Pipeline, projects and the work that needs attention. For Managers.", cost: false },
  { kind: "pipeline", href: "/newquip-grower/reports/pipeline", label: "Quotation Pipeline", blurb: "Every quotation: who created it, where it is, who must act next and what it is worth.", cost: false },
  { kind: "costing", href: "/newquip-grower/reports/costing", label: "Costing & Margin Analysis", blurb: "Cost, margin and costing quality. Confidential: Estimators and Managers only.", cost: true },
  { kind: "bottlenecks", href: "/newquip-grower/reports/bottlenecks", label: "Bottlenecks & Outstanding Actions", blurb: "The daily work list: what is waiting, on whom, and for how long.", cost: false },
] as const;

export function ReportTabs({ active, canSeeCost }: { active: string; canSeeCost: boolean }) {
  return (
    <nav aria-label="Reports" className="-mx-1 flex flex-wrap gap-1 border-b border-slate-200 pb-3">
      <Link href="/newquip-grower/reports" className={`inline-flex min-h-11 items-center rounded-md px-3 text-sm ${active === "home" ? "bg-primary-subtle font-semibold text-indigo-900" : "font-medium text-slate-700 hover:bg-slate-100"}`}>All reports</Link>
      {REPORT_LINKS.filter((r) => !r.cost || canSeeCost).map((r) => (
        <Link key={r.kind} href={r.href} aria-current={active === r.kind ? "page" : undefined} className={`inline-flex min-h-11 items-center rounded-md px-3 text-sm ${active === r.kind ? "bg-primary-subtle font-semibold text-indigo-900" : "font-medium text-slate-700 hover:bg-slate-100"}`}>{r.label}</Link>
      ))}
    </nav>
  );
}

export function Kpi({ label, value, note, href, tone }: { label: string; value: string | number; note?: string; href?: string; tone?: "warn" }) {
  const body = (
    <div className={`h-full rounded-lg border bg-white p-4 shadow-sm ${tone === "warn" ? "border-amber-300" : "border-slate-200"} ${href ? "hover:border-indigo-300" : ""}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-700">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</p>
      {note && <p className="mt-1 text-xs text-slate-600">{note}</p>}
    </div>
  );
  return href ? <Link href={href} className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">{body}</Link> : body;
}

/** A horizontal bar list: the one chart style used (it states the number next to the bar, so the chart never needs a legend or tooltip). */
export function Bars({ rows, label }: { rows: Array<{ label: string; count: number; href?: string; note?: string }>; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul aria-label={label} className="space-y-2">
      {rows.map((r) => (
        <li key={r.label} className="text-sm">
          <div className="flex items-baseline justify-between gap-3">
            {r.href ? <Link href={r.href} className="text-indigo-800 hover:underline">{r.label}</Link> : <span className="text-slate-800">{r.label}</span>}
            <span className="tabular-nums text-slate-700">{r.count}{r.note ? ` · ${r.note}` : ""}</span>
          </div>
          <div className="mt-1 h-2 rounded bg-slate-100" aria-hidden><div className="h-2 rounded bg-indigo-500" style={{ width: `${Math.max(2, Math.round((r.count / max) * 100))}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-700">{children}</p>;
}

const CAT_TONE: Partial<Record<Category, BadgeTone>> = { COMPLETE: "success", AWAITING_CUSTOMER: "info", CUSTOMER_DECLINED: "danger", ACCEPTANCE_REJECTED: "danger", CHANGES_REQUESTED: "warning", ACCEPTANCE_VERIFICATION: "warning", PROJECT_HANDOVER: "success" };
export const StageBadge = ({ c, children }: { c: Category; children: React.ReactNode }) => <Status tone={CAT_TONE[c] ?? "neutral"}>{children}</Status>;

export function QuoteLink({ r }: { r: Pick<PipelineRow, "href" | "quoteRef" | "revision"> }) {
  return <><Link href={r.href} className="inline-flex min-h-11 items-center font-medium text-indigo-700 hover:underline">{r.quoteRef}</Link> <span className="text-xs text-slate-600">rev {r.revision}</span></>;
}

export function FilterForm({ action, values, children, exportHref }: { action: string; values: Record<string, string | undefined>; children?: React.ReactNode; exportHref: string }) {
  const f = (name: string, label: string, type = "text", extra: Record<string, string> = {}) => (
    <label className="flex flex-col gap-1 text-xs font-medium text-slate-700">{label}
      <input name={name} type={type} defaultValue={values[name] ?? ""} className="min-h-11 rounded-md border border-slate-300 bg-white px-2 text-sm font-normal text-slate-900" {...extra} />
    </label>
  );
  return (
    <form method="get" action={action} className="mt-4 flex flex-wrap items-end gap-3" aria-label="Report filters">
      {f("from", "Created from", "date")}{f("to", "Created to", "date")}{f("q", "Search", "search", { placeholder: "Quote, customer or site" })}
      {children}
      <button type="submit" className="min-h-11 rounded-md bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-500">Apply</button>
      <Link href={action} className="inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium text-slate-700 hover:bg-slate-100">Clear</Link>
      <a href={exportHref} className="ml-auto inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50" data-testid="export-xlsx">Export to Excel</a>
    </form>
  );
}

export function SelectField({ name, label, value, options }: { name: string; label: string; value?: string; options: Array<[string, string]> }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-slate-700">{label}
      <select name={name} defaultValue={value ?? ""} className="min-h-11 rounded-md border border-slate-300 bg-white px-2 text-sm font-normal text-slate-900">
        <option value="">All</option>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

export function Pager({ base, query, page, pages, total }: { base: string; query: URLSearchParams; page: number; pages: number; total: number }) {
  const href = (p: number) => { const q = new URLSearchParams(query); q.set("page", String(p)); return `${base}?${q.toString()}`; };
  return (
    <div className="mt-3 flex items-center justify-between gap-3 text-sm text-slate-700">
      <span>{total} result{total === 1 ? "" : "s"} · page {page} of {pages}</span>
      <span className="flex gap-2">
        {page > 1 && <Link href={href(page - 1)} className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-3 hover:bg-slate-50">Previous</Link>}
        {page < pages && <Link href={href(page + 1)} className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-3 hover:bg-slate-50">Next</Link>}
      </span>
    </div>
  );
}

export const queryOf = (raw: Record<string, string | string[] | undefined>): URLSearchParams => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) { const s = Array.isArray(v) ? v[0] : v; if (s && k !== "page") q.set(k, s); }
  return q;
};
export { Panel, PanelTitle, ageText, fmtDate };
