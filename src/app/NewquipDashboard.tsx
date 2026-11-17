import Link from "next/link";
import { pageContainerClass } from "@/app/PageContainer";
import { Alert } from "@/components/ui/Alert";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { formatCount } from "@/lib/format-count";
import { NqIcon, type NqIconName } from "@/app/newquip-icons";
import type { NewquipDashboardData } from "@/app/newquip-dashboard-data";

// The NewQuip home for NewQuip users (everyone in the NewQuip organisation who is not a Spark super-admin). Counts and links only: the data it receives carries no cost,
// margin, supplier or money value, so no role (a Rep included) can see any here. Presentation only; each destination page authorises for itself.

const TONES = {
  slate: "bg-slate-100 text-slate-700",
  indigo: "bg-indigo-50 text-indigo-700",
  amber: "bg-amber-50 text-amber-700",
  emerald: "bg-emerald-50 text-emerald-700",
  sky: "bg-sky-50 text-sky-700",
} as const;

function Stat({ label, value, href, hint, icon, tone = "slate" }: { label: string; value: number | null; href: string; hint?: string; icon: NqIconName; tone?: keyof typeof TONES }) {
  return (
    <Link href={href} className="group flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-indigo-300 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${TONES[tone]}`}><NqIcon name={icon} /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold uppercase tracking-wide text-slate-700">{label}</span>
        <span className="mt-1 block text-3xl font-bold tabular-nums text-slate-900">{value == null ? <span className="text-base font-medium text-slate-600">Unavailable</span> : formatCount(value)}</span>
        {hint && <span className="mt-1 block text-xs text-slate-600">{hint}</span>}
      </span>
    </Link>
  );
}

const QUICK_LINKS: Array<[string, string, NqIconName]> = [["New quotation", "/newquip-grower", "plus"], ["Projects", "/projects", "projects"], ["Claims", "/claims", "claims"], ["Approvals", "/approvals", "approvals"], ["Settings", "/newquip-grower/settings", "settings"]];

export function NewquipDashboard({ data, orgName, notice = null }: { data: NewquipDashboardData; orgName: string | null; notice?: string | null }) {
  const q = data.quotes;
  return (
    <main className={`${pageContainerClass("data")} space-y-6`} data-testid="newquip-dashboard">
      <header>
        {orgName && <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700">{orgName}</p>}
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Dashboard</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-700">Where your quotations, approvals, projects and claims stand right now. Select any card to open it.</p>
      </header>

      <nav aria-label="Quick links" className="flex flex-wrap gap-2">
        {QUICK_LINKS.filter(([l]) => data.approvalsEnabled || l !== "Approvals").map(([label, href, icon], i) => (
          <Link key={href} href={href} className={`inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600 ${i === 0 ? "border-indigo-700 bg-indigo-700 text-white hover:bg-indigo-800" : "border-slate-300 bg-white text-slate-700 hover:border-indigo-300 hover:bg-slate-50"}`}>
            <NqIcon name={icon} className={`h-4 w-4 ${i === 0 ? "" : "text-slate-500"}`} />{label}
          </Link>
        ))}
      </nav>

      {notice && <Alert tone="warning">{notice}</Alert>}

      {data.queue.length > 0 ? (
        <Panel>
          <PanelTitle>Needs your action</PanelTitle>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {data.queue.map((i) => (
              <li key={i.label}>
                <Link href={i.href} className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600">
                  <span className="text-slate-800">{i.label}</span>
                  <span className="text-lg font-bold tabular-nums text-indigo-800">{formatCount(i.count)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      ) : (
        <p className="flex items-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white px-4 py-3 text-sm text-slate-700"><NqIcon name="approved" className="h-4 w-4 text-emerald-700" />Nothing is waiting on you right now.</p>
      )}

      <section aria-labelledby="nq-dash-quotes">
        <h2 id="nq-dash-quotes" className="text-sm font-semibold text-slate-900">Quotations by stage</h2>
        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Rep draft" value={q ? q.repDraft : null} href="/newquip-grower" icon="draft" tone="slate" hint="Draft quotations" />
          <Stat label="Estimator review" value={q ? q.estimatorReview : null} href="/newquip-grower" icon="estimator" tone="amber" hint="Estimator queue" />
          <Stat label="Manager decision" value={q ? q.managerDecision : null} href="/newquip-grower" icon="manager" tone="indigo" hint="Manager queue" />
          <Stat label="Approved" value={q ? q.approved : null} href="/newquip-grower" icon="approved" tone="emerald" hint="Approved quotations" />
        </div>
        {q && q.total === 0 && <p className="mt-2 text-sm text-slate-700">No quotations yet. Start one with New quotation above.</p>}
      </section>

      <section aria-labelledby="nq-dash-work">
        <h2 id="nq-dash-work" className="text-sm font-semibold text-slate-900">Approvals, projects and claims</h2>
        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.approvalsEnabled && <Stat label="Approvals waiting" value={data.approvalsPending} href="/approvals" icon="approvals" tone="indigo" />}
          <Stat label="Active projects" value={data.activeProjects} href="/projects" icon="projects" tone="sky" />
          <Stat label="Draft claims" value={data.claims ? data.claims.draft : null} href="/claims" icon="claims" tone="slate" />
          <Stat label="Open claims" value={data.claims ? data.claims.open : null} href="/claims" icon="claims" tone="amber" hint="Awaiting approval or unresolved" />
          <Stat label="Approved claims" value={data.claims ? data.claims.approved : null} href="/claims" icon="claims" tone="emerald" />
        </div>
      </section>
    </main>
  );
}
