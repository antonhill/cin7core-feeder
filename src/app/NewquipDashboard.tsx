import Link from "next/link";
import { pageContainerClass } from "@/app/PageContainer";
import { Alert } from "@/components/ui/Alert";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { formatCount } from "@/lib/format-count";
import type { NewquipDashboardData } from "@/app/newquip-dashboard-data";

// The NewQuip home for NewQuip users (everyone in the NewQuip organisation who is not a Spark super-admin). Counts and links only: the data it receives carries no cost,
// margin, supplier or money value, so no role (a Rep included) can see any here. Presentation only; each destination page authorises for itself.

function Stat({ label, value, href, hint }: { label: string; value: number | null; href: string; hint?: string }) {
  return (
    <Link href={href} className="block rounded-lg border border-slate-200 bg-white p-4 transition hover:border-slate-300 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-700">{label}</p>
      <p className="mt-2 text-3xl font-bold tabular-nums text-slate-900">{value == null ? <span className="text-base font-medium text-slate-600">Unavailable</span> : formatCount(value)}</p>
      {hint && <p className="mt-1 text-xs text-slate-600">{hint}</p>}
    </Link>
  );
}

const QUICK_LINKS: Array<[string, string]> = [["Quotations", "/newquip-grower"], ["Projects", "/projects"], ["Claims", "/claims"], ["Approvals", "/approvals"], ["Settings", "/newquip-grower/settings"]];

export function NewquipDashboard({ data, orgName, notice = null }: { data: NewquipDashboardData; orgName: string | null; notice?: string | null }) {
  const q = data.quotes;
  return (
    <main className={`${pageContainerClass("data")} space-y-6`} data-testid="newquip-dashboard">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Dashboard</h1>
        <p className="mt-1 text-sm text-slate-700">{orgName ? `${orgName} — ` : ""}quotations, approvals, projects and claims at a glance.</p>
      </div>

      {notice && <Alert tone="warning">{notice}</Alert>}

      {data.queue.length > 0 && (
        <Panel>
          <PanelTitle>Needs your action</PanelTitle>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {data.queue.map((i) => (
              <li key={i.label}>
                <Link href={i.href} className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">
                  <span className="text-slate-800">{i.label}</span>
                  <span className="text-lg font-bold tabular-nums text-indigo-800">{formatCount(i.count)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <section aria-labelledby="nq-dash-quotes">
        <h2 id="nq-dash-quotes" className="text-sm font-semibold text-slate-900">Quotations by stage</h2>
        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Rep draft" value={q ? q.repDraft : null} href="/newquip-grower" />
          <Stat label="Estimator review" value={q ? q.estimatorReview : null} href="/newquip-grower" />
          <Stat label="Manager decision" value={q ? q.managerDecision : null} href="/newquip-grower" />
          <Stat label="Approved" value={q ? q.approved : null} href="/newquip-grower" />
        </div>
      </section>

      <section aria-labelledby="nq-dash-work">
        <h2 id="nq-dash-work" className="text-sm font-semibold text-slate-900">Approvals, projects and claims</h2>
        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.approvalsEnabled && <Stat label="Approvals waiting" value={data.approvalsPending} href="/approvals" />}
          <Stat label="Active projects" value={data.activeProjects} href="/projects" />
          <Stat label="Draft claims" value={data.claims ? data.claims.draft : null} href="/claims" />
          <Stat label="Open claims" value={data.claims ? data.claims.open : null} href="/claims" hint="Awaiting approval or unresolved" />
          <Stat label="Approved claims" value={data.claims ? data.claims.approved : null} href="/claims" />
        </div>
      </section>

      <nav aria-label="Quick links" className="flex flex-wrap gap-2">
        {QUICK_LINKS.filter(([l]) => data.approvalsEnabled || l !== "Approvals").map(([label, href]) => (
          <Link key={href} href={href} className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50">{label}</Link>
        ))}
      </nav>
    </main>
  );
}
