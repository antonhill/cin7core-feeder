import Link from "next/link";
import { MODULES, ToolboxLogo, InstancesIcon, AdminIcon, ActivityIcon } from "@/app/module-nav";
import { getCurrentUserInfo } from "@/actions/auth";
import { createServiceRoleClient } from "@/supabase/server";
import MarketingHome from "@/app/marketing-home";
import OnboardingChecklist from "@/app/onboarding-checklist";

interface HomeStats {
  activeInstances: number;
  teamMembers: number;
  recentActivity: number;
}

/** Three cheap DB-only counts (no live Cin7 calls) for the dashboard's stat row — null orgId (not-yet-invited user) yields all zeros rather than querying. */
async function getHomeStats(orgId: string | null): Promise<HomeStats> {
  if (!orgId) return { activeInstances: 0, teamMembers: 0, recentActivity: 0 };

  const db = createServiceRoleClient();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [instances, members, activity] = await Promise.all([
    db.from("cin7_instances").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("active", true),
    db.from("org_members").select("user_id", { count: "exact", head: true }).eq("org_id", orgId),
    db.from("activity_log").select("id", { count: "exact", head: true }).eq("org_id", orgId).gte("created_at", sevenDaysAgo),
  ]);

  return {
    activeInstances: instances.count ?? 0,
    teamMembers: members.count ?? 0,
    recentActivity: activity.count ?? 0,
  };
}

function StatCard({
  label,
  value,
  gradient,
  Icon,
}: {
  label: string;
  value: number;
  gradient: string;
  Icon: (props: { className?: string }) => React.ReactElement;
}) {
  return (
    <div className="flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-sm ${gradient}`}>
        <Icon className="h-5 w-5" />
      </span>
      <div>
        <p className="text-2xl font-bold leading-none text-slate-900">{value.toLocaleString()}</p>
        <p className="mt-1 text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
      </div>
    </div>
  );
}

export default async function Home({ searchParams }: { searchParams: Promise<{ blocked?: string }> }) {
  const { email, orgId, disabledModules } = await getCurrentUserInfo();
  if (!email) return <MarketingHome />;

  const { blocked } = await searchParams;
  const visibleModules = MODULES.filter((m) => !disabledModules.includes(m.href));
  const blockedModule = blocked ? MODULES.find((m) => m.href === blocked) : undefined;
  const stats = await getHomeStats(orgId);

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <div className="flex items-center gap-4">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-md">
          <ToolboxLogo className="h-8 w-8" />
        </span>
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Cin7 Core Toolbox</h1>
          <p className="mt-1 max-w-2xl text-base text-slate-500">Do amazing things that you cannot do in Cin7 Core.</p>
        </div>
      </div>

      {blockedModule && (
        <p className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {blockedModule.label} isn&rsquo;t enabled for your organization — ask your admin if you need access.
        </p>
      )}

      {orgId && <OnboardingChecklist orgId={orgId} hasInstance={stats.activeInstances > 0} />}

      <div className="mt-10 grid gap-4 sm:grid-cols-3">
        <StatCard label="Active instances" value={stats.activeInstances} gradient="from-slate-500 to-slate-700" Icon={InstancesIcon} />
        <StatCard label="Team members" value={stats.teamMembers} gradient="from-fuchsia-500 to-fuchsia-700" Icon={AdminIcon} />
        <StatCard label="Activity, last 7 days" value={stats.recentActivity} gradient="from-teal-500 to-teal-700" Icon={ActivityIcon} />
      </div>

      <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {visibleModules.map((module) => {
          const Icon = module.Icon;
          return (
            <Link
              key={module.href}
              href={module.href}
              className="group rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-1 hover:border-slate-300 hover:shadow-lg"
            >
              <span
                className={`flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-sm transition-transform group-hover:scale-105 ${module.gradient}`}
              >
                <Icon className="h-5 w-5" />
              </span>
              <p className="mt-3.5 text-base font-semibold text-slate-900">{module.label}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-500">{module.blurb}</p>
            </Link>
          );
        })}
      </div>
    </main>
  );
}
