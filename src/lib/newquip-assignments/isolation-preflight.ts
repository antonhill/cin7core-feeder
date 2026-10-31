import "server-only";
// READ-ONLY preflight for switching Rep customer isolation ON (Slice 1B). It writes nothing. It answers the questions the owner must see before enforcement: which customers have
// quotations but NO active Rep, which people would become assigned-scoped (and with how many customers), and how many quotations each of them would lose sight of.
import type { createServiceRoleClient } from "@/supabase/server";
import { listOrgUsers } from "@/lib/approvals/role-store";
import { assignmentsAvailable } from "./assignment-store";
import { ORG_WIDE_QUOTE_ROLES, currentCustomers, isolationEnabled } from "./access";
import { quoteIdsForCustomers } from "./visibility";

type Db = ReturnType<typeof createServiceRoleClient>;

export interface PreflightPerson { email: string; assignedCustomers: number; visibleQuotations: number; ownCustomerlessDrafts: number; usesTierDefaultRoles: boolean }
export interface IsolationPreflight {
  generatedAt: string;
  switchInstalled: boolean;
  enabled: boolean;
  assignmentsInstalled: boolean;
  quotations: number;
  quotationsWithoutCustomer: number;
  customersWithQuotations: number;
  customersWithAnActiveRep: number;
  /** Customers that have quotations but no active Rep: only owner/admin, Manager and Estimator users would see them once isolation is ON. */
  unassignedCustomers: Array<{ cin7CustomerId: string; quotations: number }>;
  /** People who become assigned-scoped (no org-wide role). `usesTierDefaultRoles` = they have no explicit role, so they relied on the implicit tier defaults. */
  assignedScopedPeople: PreflightPerson[];
  orgWidePeople: number;
  /** Blocking problems (isolation must not be enabled until these are resolved). */
  blockers: string[];
  /** Things the owner should read but that do not block. */
  warnings: string[];
}

const missing = (m: string | undefined) => /does not exist|schema cache|could not find the table/i.test(m ?? "");

export async function isolationPreflight(db: Db, orgId: string, now = new Date()): Promise<IsolationPreflight> {
  const blockers: string[] = []; const warnings: string[] = [];
  const probe = await db.from("newquip_access_settings").select("org_id").limit(1);
  const switchInstalled = !probe.error || !missing(probe.error.message);
  if (probe.error && missing(probe.error.message)) blockers.push("The isolation switch is not installed (migration 0119 is not applied).");
  const enabled = switchInstalled ? await isolationEnabled(db, orgId) : false;
  const assignmentsInstalled = await assignmentsAvailable(db);
  if (!assignmentsInstalled) blockers.push("Customer assignments are not installed (migration 0118 is not applied).");

  const q = await db.from("newquip_quotes").select("id, created_by_email").eq("org_id", orgId);
  if (q.error) throw new Error(q.error.message);
  const quotes = (q.data ?? []) as Array<{ id: string; created_by_email: string | null }>;
  const customers = await currentCustomers(db, orgId, quotes.map((x) => x.id));
  const byCustomer = new Map<string, number>();
  for (const id of customers.values()) if (id) byCustomer.set(id, (byCustomer.get(id) ?? 0) + 1);
  const quotationsWithoutCustomer = [...customers.values()].filter((c) => !c).length;

  const a = assignmentsInstalled ? await db.from("customer_rep_assignments").select("cin7_customer_id, rep_user_id").eq("org_id", orgId).is("ended_at", null) : { data: [], error: null };
  if (a.error) throw new Error(a.error.message);
  const active = (a.data ?? []) as Array<{ cin7_customer_id: string; rep_user_id: string }>;
  const covered = new Set(active.map((x) => x.cin7_customer_id));
  const unassignedCustomers = [...byCustomer.entries()].filter(([id]) => !covered.has(id)).map(([cin7CustomerId, quotations]) => ({ cin7CustomerId, quotations })).sort((x, y) => y.quotations - x.quotations);
  if (unassignedCustomers.length) warnings.push(`${unassignedCustomers.length} customer(s) with quotations have no active Rep: those quotations would be visible only to owner/admin, Manager and Estimator users.`);

  const users = await listOrgUsers(db, orgId);
  const people: PreflightPerson[] = []; let orgWide = 0;
  for (const u of users) {
    const wide = u.tier !== "member" || u.roles.some((r) => ORG_WIDE_QUOTE_ROLES.includes(r));
    if (wide) { orgWide += 1; continue; }
    const mine = new Set(active.filter((x) => x.rep_user_id === u.userId).map((x) => x.cin7_customer_id));
    const visible = assignmentsInstalled && mine.size ? (await quoteIdsForCustomers(db, orgId, mine)).length : 0;
    const own = quotes.filter((x) => (x.created_by_email ?? "").toLowerCase() === u.email && !customers.get(x.id)).length;
    people.push({ email: u.email, assignedCustomers: mine.size, visibleQuotations: visible, ownCustomerlessDrafts: own, usesTierDefaultRoles: u.roles.length === 0 });
  }
  if (people.some((p) => p.assignedCustomers === 0)) warnings.push(`${people.filter((p) => p.assignedCustomers === 0).length} assigned-scoped person/people have NO assigned customers and would see no quotations.`);
  if (people.some((p) => p.usesTierDefaultRoles)) warnings.push("Some people have no explicit functional role and rely on the implicit tier defaults. Those defaults do NOT give organisation-wide visibility; give an explicit Estimator or Manager role to anyone who must keep it.");
  if (!orgWide) blockers.push("Nobody would have organisation-wide access (no owner/admin, Manager or Estimator): enabling isolation would lock everyone out of unassigned quotations.");

  return {
    generatedAt: now.toISOString(), switchInstalled, enabled, assignmentsInstalled, quotations: quotes.length, quotationsWithoutCustomer,
    customersWithQuotations: byCustomer.size, customersWithAnActiveRep: [...byCustomer.keys()].filter((id) => covered.has(id)).length,
    unassignedCustomers, assignedScopedPeople: people.sort((x, y) => x.email.localeCompare(y.email)), orgWidePeople: orgWide, blockers, warnings,
  };
}
