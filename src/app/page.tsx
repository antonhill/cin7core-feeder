import Link from "next/link";
import { MODULES, ToolboxLogo, InstancesIcon, AdminIcon, ActivityIcon, ShipTodayIcon, StockLevelsIcon, SELF_COLORED_ICON_BADGE } from "@/app/module-nav";
import { getCurrentUserInfo } from "@/actions/auth";
import { createServiceRoleClient } from "@/supabase/server";
import { getOrderFulfillmentReport, getStockHealthReport, getProductAvailabilitySyncStatus } from "@/reports/query";
import { StaleBadge, hoursSince, SNAPSHOT_STALE_HOURS } from "@/app/reports/sync-staleness";
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

interface ShipTodayStats {
  readyToShip: number;
  overdue: number;
}

/** Reuses the existing Order Fulfillment report query (org-wide, pre-synced — no live Cin7 call) rather than computing anything new. */
async function getShipTodayCount(orgId: string | null): Promise<ShipTodayStats> {
  if (!orgId) return { readyToShip: 0, overdue: 0 };

  const db = createServiceRoleClient();
  const rows = await getOrderFulfillmentReport(db, orgId, {});
  return {
    readyToShip: rows.filter((r) => r.is_ship_today).length,
    overdue: rows.filter((r) => r.is_overdue).length,
  };
}

interface StockHealthSummary {
  healthy: number;
  stockoutRisk: number;
  excess: number;
  totalProducts: number;
  lastSyncedAt: string | null;
}

/** Matches the Stock Health report page's own default velocity window ("previous 3 months") — duplicated here rather than exported/refactored out of that page, since it's two one-line pure functions. */
function monthsAgoIso(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Reuses the existing Stock Health report query + sync-status lookup (org-wide, pre-synced — no live Cin7 call) rather than computing anything new. */
async function getStockHealthSummary(orgId: string | null): Promise<StockHealthSummary> {
  if (!orgId) return { healthy: 0, stockoutRisk: 0, excess: 0, totalProducts: 0, lastSyncedAt: null };

  const db = createServiceRoleClient();
  const [rows, syncStatus] = await Promise.all([
    getStockHealthReport(db, orgId, { velocityDateFrom: monthsAgoIso(3), velocityDateTo: todayIso() }),
    getProductAvailabilitySyncStatus(db, orgId),
  ]);
  return {
    healthy: rows.filter((r) => r.status === "Healthy").length,
    stockoutRisk: rows.filter((r) => r.status === "Stockout risk").length,
    excess: rows.filter((r) => r.status === "Excess").length,
    totalProducts: rows.length,
    lastSyncedAt: syncStatus.lastSyncedAt,
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

const CARD_CLASS = "block rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-lg";

/** Deliberately distinguishes "nothing urgent" from a bare 0 — an empty ready-to-ship count is the single most important state to get right here, since it should read as reassuring, not ambiguous. */
function ShipTodayCard({ readyToShip, overdue }: ShipTodayStats) {
  const allCaughtUp = readyToShip === 0 && overdue === 0;
  return (
    <Link href="/reports/order-fulfillment?tab=ship" className={`flex items-center gap-4 ${CARD_CLASS}`}>
      <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br shadow-sm ${SELF_COLORED_ICON_BADGE}`}>
        <ShipTodayIcon className="h-5 w-5" />
      </span>
      {allCaughtUp ? (
        <p className="text-base font-semibold leading-tight text-slate-900">All caught up — nothing to ship today</p>
      ) : (
        <div>
          <p className="flex items-center gap-2 text-2xl font-bold leading-none text-slate-900">
            {readyToShip.toLocaleString()}
            {overdue > 0 && <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">{overdue} overdue</span>}
          </p>
          <p className="mt-1 text-xs font-medium uppercase tracking-wide text-slate-400">Ready to ship today</p>
        </div>
      )}
    </Link>
  );
}

/** Instance-vs-never-synced are distinct empty states — a zero-instance org shouldn't imply stock is fine, and a connected-but-unsynced instance shouldn't imply zero instances. */
function StockHealthCard({ summary, activeInstances }: { summary: StockHealthSummary; activeInstances: number }) {
  const { healthy, stockoutRisk, excess, totalProducts, lastSyncedAt } = summary;

  if (activeInstances === 0) {
    return (
      <div className={`flex items-center gap-4 ${CARD_CLASS}`}>
        <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br shadow-sm ${SELF_COLORED_ICON_BADGE}`}>
          <StockLevelsIcon className="h-5 w-5" />
        </span>
        <p className="text-sm text-slate-500">Connect an instance to see stock health here.</p>
      </div>
    );
  }

  if (totalProducts === 0) {
    return (
      <Link href="/reports/stock-health" className={`flex items-center gap-4 ${CARD_CLASS}`}>
        <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br shadow-sm ${SELF_COLORED_ICON_BADGE}`}>
          <StockLevelsIcon className="h-5 w-5" />
        </span>
        <p className="text-sm text-slate-500">Stock levels haven&rsquo;t been synced yet — visit Stock Health to sync.</p>
      </Link>
    );
  }

  const isStale = lastSyncedAt ? hoursSince(lastSyncedAt) > SNAPSHOT_STALE_HOURS : false;

  return (
    <Link href="/reports/stock-health" className={CARD_CLASS}>
      <div className="flex items-center gap-4">
        <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br shadow-sm ${SELF_COLORED_ICON_BADGE}`}>
          <StockLevelsIcon className="h-5 w-5" />
        </span>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">Stock health</p>
      </div>
      <div className="mt-4 flex h-2.5 overflow-hidden rounded-full bg-slate-100">
        {healthy > 0 && <div className="bg-emerald-500" style={{ width: `${(healthy / totalProducts) * 100}%` }} />}
        {stockoutRisk > 0 && <div className="bg-rose-500" style={{ width: `${(stockoutRisk / totalProducts) * 100}%` }} />}
        {excess > 0 && <div className="bg-amber-500" style={{ width: `${(excess / totalProducts) * 100}%` }} />}
      </div>
      <p className="mt-2.5 text-sm text-slate-600">
        {stockoutRisk} stockout risk, {excess} excess, {healthy} healthy
      </p>
      <p className="mt-1.5 flex items-center gap-2 text-xs text-slate-400">
        {lastSyncedAt ? `As of ${new Date(lastSyncedAt).toLocaleString()}` : "Not yet synced"}
        {isStale && <StaleBadge label="Stale — sync recommended" />}
      </p>
    </Link>
  );
}

export default async function Home({ searchParams }: { searchParams: Promise<{ blocked?: string }> }) {
  const { email, orgId, disabledModules } = await getCurrentUserInfo();
  if (!email) return <MarketingHome />;

  const { blocked } = await searchParams;
  const visibleModules = MODULES.filter((m) => !disabledModules.includes(m.href));
  const blockedModule = blocked ? MODULES.find((m) => m.href === blocked) : undefined;
  const [stats, shipToday, stockHealth] = await Promise.all([getHomeStats(orgId), getShipTodayCount(orgId), getStockHealthSummary(orgId)]);

  return (
    <main className="mx-auto w-full max-w-7xl px-6 py-12">
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
        <StatCard label="Active instances" value={stats.activeInstances} gradient={SELF_COLORED_ICON_BADGE} Icon={InstancesIcon} />
        <StatCard label="Team members" value={stats.teamMembers} gradient={SELF_COLORED_ICON_BADGE} Icon={AdminIcon} />
        <StatCard label="Activity, last 7 days" value={stats.recentActivity} gradient={SELF_COLORED_ICON_BADGE} Icon={ActivityIcon} />
      </div>

      {orgId && (
        <div className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Today</h2>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <ShipTodayCard readyToShip={shipToday.readyToShip} overdue={shipToday.overdue} />
            <StockHealthCard summary={stockHealth} activeInstances={stats.activeInstances} />
          </div>
        </div>
      )}

      <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
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
