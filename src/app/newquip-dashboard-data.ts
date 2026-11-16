import { isNewquipPocOrg } from "@/newquip/access";
import "server-only";
// Loads the NewQuip dashboard's counts through the EXISTING stores (quotations, approvals, projects). Read-only; no Cin7 call. Each section fails independently
// (null) so one unavailable store never blanks the page, and only counts and a role list leave this module (no record, cost, margin or supplier value).
import { createServiceRoleClient } from "@/supabase/server";
import { requireModuleAccess } from "@/lib/authorization";
import { PROJECTS_MODULE } from "@/app/module-nav";
import { authoriseActor } from "@/app/newquip-grower/actor";
import { listQuotes } from "@/lib/newquip-quotes/quote-store";
import { listRequests } from "@/lib/approvals/approval-store";
import { listProjectViews } from "@/lib/projects/project-store";
import { isCustomerFacingProject } from "@/lib/projects/project-view";
import { APPROVALS_DISABLED } from "@/lib/approvals/kill-switch";
import type { QuoteRole } from "@/newquip/quote/roles";
import { activeProjectCount, claimCounts, queueFor, quoteStageCounts, type ClaimCounts, type QueueItem, type QuoteStageCounts } from "@/newquip/dashboard";

export interface NewquipDashboardData {
  roles: QuoteRole[];
  quotes: QuoteStageCounts | null;
  queue: QueueItem[];
  approvalsPending: number | null;
  approvalsEnabled: boolean;
  activeProjects: number | null;
  claims: ClaimCounts | null;
}

export async function loadNewquipDashboard(orgId: string): Promise<NewquipDashboardData> {
  const db = createServiceRoleClient();
  const out: NewquipDashboardData = { roles: [], quotes: null, queue: [], approvalsPending: null, approvalsEnabled: !APPROVALS_DISABLED, activeProjects: null, claims: null };
  if (!isNewquipPocOrg(orgId)) return out; // defence in depth: only the NewQuip org is ever summarised here

  try {
    const actor = await authoriseActor(); // NewQuip org + Quotes module access + the viewer's effective process roles
    out.roles = [...actor.roles];
    const rows = await listQuotes(db, actor.orgId);
    out.quotes = quoteStageCounts(rows.map((q) => ({ state: q.state, signed_off: !!q.estimator_signoff_hash && q.estimator_signoff_hash === q.draft_hash })));
    out.queue = queueFor(actor.roles, out.quotes);
  } catch { /* quotations unavailable to this viewer: that card shows as unavailable */ }

  if (!APPROVALS_DISABLED) {
    try { out.approvalsPending = (await listRequests(db, orgId)).filter((r) => r.status === "PENDING").length; } catch { /* unavailable */ }
  }

  try {
    await requireModuleAccess(PROJECTS_MODULE.href);
    const views = (await listProjectViews(db, orgId)).filter(isCustomerFacingProject);
    out.activeProjects = activeProjectCount(views.map((v) => v.project));
    out.claims = claimCounts(views.flatMap((v) => v.claims.map((c) => c.status)));
  } catch { /* projects unavailable to this viewer */ }

  return out;
}
