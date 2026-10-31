import "server-only";
// The ONE server-side authorisation boundary for customer-level Rep isolation (Slice 1B). Every action or route that returns quotation, document, evidence, response, approval,
// notification, Project or customer data for a signed-in USER goes through the functions below, so the rule is written once:
//
//   * Isolation is an explicit per-organisation switch stored in the database (newquip_access_settings, migration 0119). OFF (the default, and when the migration is not applied) = today's
//     behaviour, exactly. The same switch drives the database read policies, so the application and a direct database request can never disagree.
//   * ON: an actor has ORGANISATION-WIDE access when they are an organisation owner/admin, or hold an EXPLICIT ESTIMATOR or MANAGER functional role assignment. The tier-default roles of a
//     user with no explicit assignment (REP + ESTIMATOR while strict roles are off) deliberately do NOT count - otherwise every plain member would be an "Estimator" and nothing would be
//     isolated. Every other actor (a Rep, a plain member, an explicit Administrator/Procurement/Project-Manager-only user) is ASSIGNED-scoped for quotations.
//   * An ASSIGNED-scoped actor sees a quotation only when its CURRENT customer is one of their ACTIVE assignments (history follows the customer), or - so that a Rep can start work - when
//     it is their OWN quotation that has no customer yet. Creation/selection of a customer is limited to their assigned customers.
//   * Fail closed: if the switch cannot be read, or isolation is ON and customer assignments are unavailable, an assigned-scoped actor gets nothing; org-wide actors are unaffected.
//   * One generic denial ("Quote not found.") for "does not exist" and "exists but you may not see it", so a Rep cannot probe for other customers' quotations.
//   * Authorisation runs BEFORE any protected data is read, and every query here is scoped by organisation. Nothing here grants authority to edit, approve, issue or accept.
import type { createServiceRoleClient } from "@/supabase/server";
import { listAssignments } from "@/lib/approvals/role-store";
import { assignmentsAvailable } from "./assignment-store";
import { NotVisibleError, assignedCustomerIds, currentCustomerIdOfQuote, quoteIdsForCustomers } from "./visibility";
import { CLEARED_CUSTOMER_ID } from "@/lib/newquip-quotes/customer-store";

type Db = ReturnType<typeof createServiceRoleClient>;
const missing = (m: string | undefined) => /does not exist|schema cache|could not find the table/i.test(m ?? "");

/** Keep identical to newquip_quote_scope_ok / newquip_project_scope_ok in migration 0119. */
export const ORG_WIDE_QUOTE_ROLES: readonly string[] = ["ESTIMATOR", "MANAGER"];
export const ORG_WIDE_PROJECT_ROLES: readonly string[] = ["ESTIMATOR", "MANAGER", "PROJECT_MANAGER", "PROCUREMENT"];

/** The minimum an authorisation decision needs about the signed-in (effective) user. `tier` is "admin" for an organisation owner/admin. */
export interface AccessActor { orgId: string; userId: string; email: string; tier: string }

export type QuoteScope = { kind: "ORG_WIDE" } | { kind: "ASSIGNED"; orgId: string; userId: string; email: string };

/** Is Rep customer isolation switched ON for this organisation? Absent table/row = OFF. Any other read failure throws (fail closed, never "off"). */
export async function isolationEnabled(db: Db, orgId: string): Promise<boolean> {
  const r = await db.from("newquip_access_settings").select("rep_isolation_enabled").eq("org_id", orgId).maybeSingle();
  if (r.error) { if (missing(r.error.message)) return false; throw new Error("Access settings are unavailable."); }
  return (r.data as { rep_isolation_enabled: boolean } | null)?.rep_isolation_enabled === true;
}

/** EXPLICIT functional-role assignments of one user (never the tier defaults). */
async function explicitRoles(db: Db, orgId: string, userId: string): Promise<Set<string>> {
  const all = await listAssignments(db, orgId); // null = roles table not applied: nobody has an explicit role
  return new Set((all ?? []).filter((a) => a.user_id === userId).map((a) => a.role as string));
}

/** How far this actor's quotation access reaches. Cheap when isolation is OFF (one settings read). */
export async function quoteScope(db: Db, a: AccessActor): Promise<QuoteScope> {
  if (!(await isolationEnabled(db, a.orgId))) return { kind: "ORG_WIDE" };
  if (a.tier === "admin") return { kind: "ORG_WIDE" };
  const roles = await explicitRoles(db, a.orgId, a.userId);
  if (ORG_WIDE_QUOTE_ROLES.some((r) => roles.has(r))) return { kind: "ORG_WIDE" };
  if (!(await assignmentsAvailable(db))) throw new Error("Customer assignments are not available yet."); // isolation is ON but its data is not: fail closed
  return { kind: "ASSIGNED", orgId: a.orgId, userId: a.userId, email: a.email.toLowerCase() };
}

/** Project data: org-wide actors plus explicit Project Manager / Procurement staff. A Rep-scoped actor is not a Projects user while isolation is ON. */
export async function projectsAllowed(db: Db, a: AccessActor): Promise<boolean> {
  if (!(await isolationEnabled(db, a.orgId))) return true;
  if (a.tier === "admin") return true;
  const roles = await explicitRoles(db, a.orgId, a.userId);
  return ORG_WIDE_PROJECT_ROLES.some((r) => roles.has(r));
}

/** Throws the generic denial unless Projects data is open to this actor. */
export async function assertProjectsAccess(db: Db, a: AccessActor): Promise<void> {
  if (!(await projectsAllowed(db, a))) throw new NotAvailableError();
}

type SnapRow = { quote_id: string; seq: number; cin7_customer_id: string };
const chunks = <T,>(xs: T[], n: number): T[][] => { const o: T[][] = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o; };

/** The CURRENT customer of each given quotation (latest snapshot; a "(cleared)" marker or no snapshot = null). */
export async function currentCustomers(db: Db, orgId: string, quoteIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>(quoteIds.map((id) => [id, null]));
  const latest = new Map<string, SnapRow>();
  for (const part of chunks(quoteIds, 100)) {
    for (let from = 0; ; from += 1000) {
      const r = await db.from("newquip_quote_customers").select("quote_id, seq, cin7_customer_id").eq("org_id", orgId).in("quote_id", part).order("quote_id").order("seq").range(from, from + 999);
      if (r.error) { if (missing(r.error.message)) return out; throw new Error(r.error.message); }
      const rows = (r.data ?? []) as SnapRow[];
      for (const x of rows) { const cur = latest.get(x.quote_id); if (!cur || x.seq > cur.seq) latest.set(x.quote_id, x); }
      if (rows.length < 1000) break;
    }
  }
  for (const [id, row] of latest) out.set(id, row.cin7_customer_id === CLEARED_CUSTOMER_ID ? null : row.cin7_customer_id);
  return out;
}

/** The creator of a quotation (lower-cased), or null when it does not exist in this organisation. */
async function creatorOf(db: Db, orgId: string, quoteId: string): Promise<string | null | undefined> {
  const r = await db.from("newquip_quotes").select("created_by_email").eq("org_id", orgId).eq("id", quoteId).maybeSingle();
  if (r.error) throw new Error(r.error.message);
  const row = r.data as { created_by_email: string | null } | null;
  return row ? (row.created_by_email ?? "").toLowerCase() : undefined;
}

/** May this actor see this quotation (and therefore its documents, evidence, responses, approvals and notifications)? */
export async function canSeeQuote(db: Db, scope: QuoteScope, quoteId: string): Promise<boolean> {
  if (scope.kind === "ORG_WIDE") return true; // existing org-scoped loads still reject a foreign or unknown id
  const customer = await currentCustomerIdOfQuote(db, scope.orgId, quoteId);
  if (customer) return (await assignedCustomerIds(db, scope.orgId, scope.userId)).has(customer);
  const creator = await creatorOf(db, scope.orgId, quoteId);  // no customer yet: the creator's own enquiry/draft
  return creator !== undefined && creator !== "" && creator === scope.email;
}

/** Throws the generic denial unless the actor may see the quotation. Call this FIRST, before loading any quotation data. */
export async function guardQuote(db: Db, a: AccessActor, quoteId: string): Promise<QuoteScope> {
  const scope = await quoteScope(db, a);
  if (!(await canSeeQuote(db, scope, String(quoteId ?? "")))) throw new NotVisibleError();
  return scope;
}

/** For lists: the ids the actor may see among `rows`, or null when the actor sees everything. */
export async function visibleQuoteIds(db: Db, scope: QuoteScope, rows: Array<{ id: string; created_by_email?: string | null }>): Promise<Set<string> | null> {
  if (scope.kind === "ORG_WIDE") return null;
  const assigned = new Set(await quoteIdsForCustomers(db, scope.orgId, await assignedCustomerIds(db, scope.orgId, scope.userId)));
  const own = rows.filter((r) => !assigned.has(r.id) && (r.created_by_email ?? "").toLowerCase() === scope.email).map((r) => r.id);
  const customers = own.length ? await currentCustomers(db, scope.orgId, own) : new Map<string, string | null>();
  const out = new Set(assigned);
  for (const id of own) if (!customers.get(id)) out.add(id);
  return out;
}

/** Which of these quotation ids may the actor see? (Batch form of canSeeQuote, for queues and notification lists.) */
export async function visibleAmong(db: Db, scope: QuoteScope, quoteIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(quoteIds.filter(Boolean))];
  if (scope.kind === "ORG_WIDE") return new Set(ids);
  const assigned = new Set(await quoteIdsForCustomers(db, scope.orgId, await assignedCustomerIds(db, scope.orgId, scope.userId)));
  const out = new Set(ids.filter((id) => assigned.has(id)));
  const rest = ids.filter((id) => !out.has(id));
  const mine: string[] = [];
  for (const part of chunks(rest, 100)) {
    const r = await db.from("newquip_quotes").select("id, created_by_email").eq("org_id", scope.orgId).in("id", part);
    if (r.error) throw new Error(r.error.message);
    for (const q of (r.data ?? []) as Array<{ id: string; created_by_email: string | null }>) if ((q.created_by_email ?? "").toLowerCase() === scope.email) mine.push(q.id);
  }
  const customers = mine.length ? await currentCustomers(db, scope.orgId, mine) : new Map<string, string | null>();
  for (const id of mine) if (!customers.get(id)) out.add(id); // own quotation with no customer yet
  return out;
}

/** Throws unless the actor may pick this Cin7 customer for a quotation (org-wide actors: any; assigned-scoped: only their assigned customers). */
export async function assertCustomerSelectable(db: Db, scope: QuoteScope, cin7CustomerId: string): Promise<void> {
  if (scope.kind === "ORG_WIDE") return;
  if (!(await assignedCustomerIds(db, scope.orgId, scope.userId)).has(String(cin7CustomerId ?? "").trim())) throw new Error("Choose one of the customers assigned to you.");
}

/** Restrict customer search results to the assigned customers for an assigned-scoped actor. */
export async function filterCustomerHits<T extends { id: string }>(db: Db, scope: QuoteScope, hits: T[]): Promise<T[]> {
  if (scope.kind === "ORG_WIDE") return hits;
  const assigned = await assignedCustomerIds(db, scope.orgId, scope.userId);
  return hits.filter((h) => assigned.has(h.id));
}

/** An approval request is visible to an assigned-scoped actor only when it is for a quotation they may see; claim / variation approvals are Project matters and are not. */
export async function canSeeApprovalRequest(db: Db, scope: QuoteScope, req: { doc_type: string; doc_id: string }): Promise<boolean> {
  if (scope.kind === "ORG_WIDE") return true;
  return req.doc_type === "QUOTE" && canSeeQuote(db, scope, req.doc_id);
}

/** Approval requests an assigned-scoped actor may see (quotation requests of visible quotations only). */
export async function filterApprovalRequests<T extends { doc_type: string; doc_id: string }>(db: Db, scope: QuoteScope, rows: T[]): Promise<T[]> {
  if (scope.kind === "ORG_WIDE") return rows;
  const vis = await visibleAmong(db, scope, rows.filter((r) => r.doc_type === "QUOTE").map((r) => r.doc_id));
  return rows.filter((r) => r.doc_type === "QUOTE" && vis.has(r.doc_id));
}

/** Notifications an assigned-scoped actor may see: those that belong to a visible quotation (directly, or through their approval request). Anything unattributable is withheld (fail closed). */
export async function filterNotifications<T extends { request_id: string | null; quote_id?: string | null }>(
  db: Db, scope: QuoteScope, notes: T[], requests: Array<{ id: string; doc_type: string; doc_id: string }>,
): Promise<T[]> {
  if (scope.kind === "ORG_WIDE") return notes;
  const byReq = new Map(requests.map((r) => [r.id, r]));
  const quoteOf = (n: T): string | null => n.quote_id ?? (n.request_id && byReq.get(n.request_id)?.doc_type === "QUOTE" ? byReq.get(n.request_id)!.doc_id : null);
  const vis = await visibleAmong(db, scope, notes.map(quoteOf).filter((x): x is string => !!x));
  return notes.filter((n) => { const q = quoteOf(n); return !!q && vis.has(q); });
}

/** Activity rows of the NewQuip / approvals / projects namespaces follow the quotation scope (the database policy applies the same rule to direct reads). */
export const SCOPED_ACTIVITY_PREFIX = /^(newquip|approvals|projects)\./;
export const activityVisible = (scope: QuoteScope, action: string): boolean => scope.kind === "ORG_WIDE" || !SCOPED_ACTIVITY_PREFIX.test(action);

/** The generic denial for non-quotation areas (Projects). */
export class NotAvailableError extends Error { constructor() { super("Not found."); this.name = "NotAvailableError"; } }

export { NotVisibleError };
