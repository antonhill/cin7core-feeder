// NewQuip Reports: the PURE operational model. No database, no server-only import, no cost, margin or supplier value anywhere in this file: it is handed the
// NON-COMMERCIAL quotation columns the loader selects and returns stage, responsibility, age and selling-value rows. That is what makes it safe for a Sales Rep.
// Stage and status come from the application's own workflow (QuoteState + the customer-response standing), never from a category invented here.
import { countsAsAcceptance, standingOf, type StoredResponse, type StoredReview } from "@/lib/newquip-portal/core";

export type QuoteState = "REP_DRAFT" | "ESTIMATOR_REVIEW" | "MANAGER_APPROVED_FINAL";

/** The quotation columns reporting may read. Deliberately has no `draft`, `accepted_baseline` or any cost-bearing column. */
export interface ReportQuote {
  id: string; quote_ref: string; revision: number; customer_name: string; site_name: string; state: QuoteState;
  draft_hash: string; estimator_signoff_hash: string | null; estimator_signoff_by_email: string | null; estimator_signoff_at: string | null;
  customer_confirmed_cents: number | null; customer_confirmed_at: string | null; handoff_by_email: string | null;
  approved_by_email: string | null; approved_at: string | null; contract_cents: number | null; project_id: string | null;
  requires_customer_acceptance: boolean | null; created_by_email: string | null; created_at: string;
}
export interface ReportApproval { doc_id: string; revision: number; status: string; assigned_to_email: string | null; submitted_at: string; decided_at: string | null; decided_by_email: string | null }
export interface ReportDocument { id: string; quote_id: string; revision: number; version: number; created_at: string; issued_by_email: string }
export interface ReportSend { id: string; quote_id: string; document_id: string; status: string; sent_by_email: string; created_at: string; attempted_at: string | null }
export type ReportResponse = Pick<StoredResponse, "id" | "quote_id" | "document_id" | "response" | "recorded_by_email" | "created_at" | "origin" | "contact_source">;
export type ReportReview = Pick<StoredReview, "id" | "quote_id" | "response_id" | "decision" | "reviewed_by_email" | "created_at">;
export interface ReportProject { id: string; project_reference: string; name: string; customer_name: string; status: string; original_contract_cents: number; created_at: string; parent_project_id: string | null; billing_scope: string | null }

export interface ReportData {
  quotes: ReportQuote[]; approvals: ReportApproval[]; documents: ReportDocument[]; sends: ReportSend[];
  responses: ReportResponse[]; reviews: ReportReview[]; evidence: ReadonlyMap<string, number>; projects: ReportProject[];
}

export type Category =
  | "REP_DRAFT" | "REP_CORRECTION" | "ESTIMATOR_REVIEW" | "MANAGER_APPROVAL" | "DOC_NOT_ISSUED" | "NOT_SENT" | "AWAITING_CUSTOMER"
  | "ACCEPTANCE_VERIFICATION" | "PROJECT_HANDOVER" | "CUSTOMER_DECLINED" | "CHANGES_REQUESTED" | "ACCEPTANCE_REJECTED" | "COMPLETE";
export type RoleName = "Rep" | "Estimator" | "Manager" | "Rep or Manager" | "Customer" | "None";

export const CATEGORY_LABEL: Record<Category, string> = {
  REP_DRAFT: "Rep draft: awaiting submission", REP_CORRECTION: "Rep: correction required", ESTIMATOR_REVIEW: "Estimator review and sign-off", MANAGER_APPROVAL: "Manager approval",
  DOC_NOT_ISSUED: "Approved: customer quotation not issued", NOT_SENT: "Customer quotation issued, not yet sent", AWAITING_CUSTOMER: "Customer response outstanding",
  ACCEPTANCE_VERIFICATION: "Customer acceptance awaiting internal verification", PROJECT_HANDOVER: "Accepted: Project handover", CUSTOMER_DECLINED: "Declined by customer",
  CHANGES_REQUESTED: "Customer requested changes", ACCEPTANCE_REJECTED: "Customer acceptance rejected on verification", COMPLETE: "Converted to a Project",
};
export const OUTSTANDING_CATEGORIES = (Object.keys(CATEGORY_LABEL) as Category[]).filter((c) => c !== "COMPLETE");

export interface StageInfo {
  category: Category; stage: string; status: string; nextAction: string; waitingOn: RoleName;
  /** A named person ONLY where the application recorded one (a Manager approval request's assignee). Otherwise null: shown as "Unassigned" / "Any eligible ...". */
  assignedTo: string | null; waitingOnLabel: string;
  since: string | null; sinceSource: string; lastActionBy: string | null; lastActionAt: string | null;
  customerResponse: string;
}

const t = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);
export const signedOff = (q: Pick<ReportQuote, "estimator_signoff_hash" | "draft_hash">): boolean => !!q.estimator_signoff_hash && q.estimator_signoff_hash === q.draft_hash;

/** Whole days between two instants (floor). Null when the start is unknown: an age is NEVER back-filled from the creation date. */
export function daysBetween(sinceIso: string | null, now: Date): number | null {
  const s = t(sinceIso);
  if (!Number.isFinite(s)) return null;
  return Math.max(0, Math.floor((now.getTime() - s) / 86_400_000));
}

const latest = <T,>(rows: readonly T[], at: (r: T) => string | null | undefined): T | null => {
  let best: T | null = null; let bt = -Infinity;
  for (const r of rows) { const v = t(at(r)); if (Number.isFinite(v) && v > bt) { bt = v; best = r; } }
  return best;
};

/** The value shown for a quotation: the approved contract once there is one, otherwise the amount the Rep's customer confirmed (INDICATIVE). Never a computed or cost-derived figure. */
export function sellingValue(q: Pick<ReportQuote, "contract_cents" | "customer_confirmed_cents" | "state">): { cents: number | null; basis: "CONTRACT" | "CONFIRMED" | "NONE" } {
  if (q.state === "MANAGER_APPROVED_FINAL" && q.contract_cents != null) return { cents: q.contract_cents, basis: "CONTRACT" };
  if (q.customer_confirmed_cents != null) return { cents: q.customer_confirmed_cents, basis: "CONFIRMED" };
  return { cents: null, basis: "NONE" };
}

/** Indexes the child rows by quotation once, so classification is O(rows) rather than a query or a scan per quotation. */
export function indexData(d: ReportData) {
  const by = <T extends { quote_id: string }>(rows: readonly T[]) => { const m = new Map<string, T[]>(); for (const r of rows) { const a = m.get(r.quote_id); if (a) a.push(r); else m.set(r.quote_id, [r]); } return m; };
  const pending = new Map<string, ReportApproval>();
  const decided = new Map<string, ReportApproval[]>();
  for (const a of d.approvals) {
    if (a.status === "PENDING") pending.set(a.doc_id, a);
    else { const x = decided.get(a.doc_id); if (x) x.push(a); else decided.set(a.doc_id, [a]); }
  }
  return { docs: by(d.documents), sends: by(d.sends), responses: by(d.responses), reviews: by(d.reviews), pending, decided };
}
export type Index = ReturnType<typeof indexData>;

/** The workflow position of ONE quotation. Uses the application's own states and the customer-response standing; nothing is guessed or back-dated. */
export function classify(q: ReportQuote, ix: Index, d: Pick<ReportData, "evidence">): StageInfo {
  const docs = (ix.docs.get(q.id) ?? []).slice().sort((a, b) => b.version - a.version);
  const sends = ix.sends.get(q.id) ?? []; const responses = (ix.responses.get(q.id) ?? []).slice().sort((a, b) => t(b.created_at) - t(a.created_at));
  const reviews = ix.reviews.get(q.id) ?? [];
  const lastEvent = lastAction(q, ix);
  const base = { lastActionBy: lastEvent?.by ?? null, lastActionAt: lastEvent?.at ?? null, assignedTo: null as string | null, customerResponse: "Not applicable" };
  const make = (category: Category, i: Omit<StageInfo, "category" | "lastActionBy" | "lastActionAt" | "assignedTo" | "customerResponse"> & Partial<Pick<StageInfo, "assignedTo" | "customerResponse">>): StageInfo => ({ ...base, ...i, category });

  if (q.state === "REP_DRAFT") {
    if (q.revision > 1) return make("REP_CORRECTION", { stage: "Rep draft", status: `Returned (revision ${q.revision})`, nextAction: "Make the corrections and resubmit", waitingOn: "Rep", waitingOnLabel: "Rep", since: null, sinceSource: "Not recorded: a return to the Rep is not time-stamped" });
    return make("REP_DRAFT", { stage: "Rep draft", status: "Preparing", nextAction: "Complete the draft and submit to the Estimator", waitingOn: "Rep", waitingOnLabel: "Rep", since: q.created_at, sinceSource: "Quotation created" });
  }
  if (q.state === "ESTIMATOR_REVIEW" && !signedOff(q)) {
    return make("ESTIMATOR_REVIEW", { stage: "Estimator review", status: "With the Estimator", nextAction: "Cost, review and sign off", waitingOn: "Estimator", waitingOnLabel: "Any eligible Estimator", since: q.customer_confirmed_at, sinceSource: q.customer_confirmed_at ? "Handed to the Estimator" : "Not recorded" });
  }
  if (q.state === "ESTIMATOR_REVIEW") {
    const p = ix.pending.get(q.id);
    const since = p?.submitted_at ?? q.estimator_signoff_at;
    return make("MANAGER_APPROVAL", { stage: "Manager approval", status: p ? "Approval requested" : "Signed off by the Estimator", nextAction: "Verify costs and approve or return", waitingOn: "Manager", assignedTo: p?.assigned_to_email ?? null, waitingOnLabel: p?.assigned_to_email ?? "Any eligible Manager", since, sinceSource: p ? "Approval requested" : q.estimator_signoff_at ? "Estimator sign-off" : "Not recorded" });
  }
  // MANAGER_APPROVED_FINAL: the customer stage, using the same standing rules as the quotation page.
  if (q.project_id) return make("COMPLETE", { stage: "Project", status: "Converted to a Project", nextAction: "None", waitingOn: "None", waitingOnLabel: "None", since: null, sinceSource: "Not applicable", customerResponse: customerResponseOf(q, docs[0] ?? null, sends, responses, reviews, d.evidence) });
  const doc = docs[0] ?? null;
  const resp = customerResponseOf(q, doc, sends, responses, reviews, d.evidence);
  const approvedAt = q.approved_at;
  if (!doc) {
    if (q.requires_customer_acceptance !== true) return make("PROJECT_HANDOVER", { stage: "Approved", status: "Approved (customer acceptance not required)", nextAction: "Create the Project", waitingOn: "Manager", waitingOnLabel: "Manager", since: approvedAt, sinceSource: "Manager approval", customerResponse: resp });
    return make("DOC_NOT_ISSUED", { stage: "Customer quotation", status: "Approved, not issued", nextAction: "Issue the customer quotation", waitingOn: "Rep", waitingOnLabel: "Rep", since: approvedAt, sinceSource: "Manager approval", customerResponse: resp });
  }
  const mine = responses.filter((r) => r.document_id === doc.id);
  const stored = (r: ReportResponse) => r as unknown as StoredResponse; const rv = reviews as unknown as StoredReview[];
  const accepted = mine.find((r) => countsAsAcceptance(stored(r), rv, d.evidence));
  if (accepted) return make("PROJECT_HANDOVER", { stage: "Customer accepted", status: "Customer accepted", nextAction: "Create the Project", waitingOn: "Manager", waitingOnLabel: "Manager", since: accepted.created_at, sinceSource: "Customer acceptance recorded", customerResponse: resp });
  const lastResp = mine[0];
  if (lastResp) {
    const st = standingOf(stored(lastResp), rv, d.evidence);
    if (lastResp.response === "ACCEPTED" && (st === "PENDING_VERIFICATION" || st === "EVIDENCE_MISSING")) return make("ACCEPTANCE_VERIFICATION", { stage: "Customer response", status: "Accepted by customer, not yet verified", nextAction: "Verify the customer's identity and authority", waitingOn: "Rep or Manager", waitingOnLabel: "Rep or Manager", since: lastResp.created_at, sinceSource: "Customer acceptance received", customerResponse: resp });
    if (lastResp.response === "ACCEPTED" && st === "REJECTED") return make("ACCEPTANCE_REJECTED", { stage: "Customer response", status: "Acceptance rejected on verification", nextAction: "Follow up with the customer", waitingOn: "Rep", waitingOnLabel: "Rep", since: lastResp.created_at, sinceSource: "Customer response received", customerResponse: resp });
    if (lastResp.response === "DECLINED") return make("CUSTOMER_DECLINED", { stage: "Customer response", status: "Declined by customer", nextAction: "Follow up or close", waitingOn: "Rep", waitingOnLabel: "Rep", since: lastResp.created_at, sinceSource: "Customer response received", customerResponse: resp });
    if (lastResp.response === "CHANGES_REQUESTED") return make("CHANGES_REQUESTED", { stage: "Customer response", status: "Customer requested changes", nextAction: "Review the requested changes", waitingOn: "Rep", waitingOnLabel: "Rep", since: lastResp.created_at, sinceSource: "Customer response received", customerResponse: resp });
  }
  const accSends = sends.filter((s) => s.document_id === doc.id && s.status === "ACCEPTED");
  const lastSend = latest(accSends, (s) => s.attempted_at ?? s.created_at);
  if (lastSend) return make("AWAITING_CUSTOMER", { stage: "Customer response", status: "Sent to customer", nextAction: "Await the customer's decision", waitingOn: "Customer", waitingOnLabel: "Customer", since: lastSend.attempted_at ?? lastSend.created_at, sinceSource: "Sent to customer", customerResponse: resp });
  return make("NOT_SENT", { stage: "Customer quotation", status: "Issued, not sent", nextAction: "Send the quotation to the customer", waitingOn: "Rep", waitingOnLabel: "Rep", since: doc.created_at, sinceSource: "Customer quotation issued", customerResponse: resp });
}

function customerResponseOf(q: ReportQuote, doc: ReportDocument | null, sends: readonly ReportSend[], responses: readonly ReportResponse[], reviews: readonly ReportReview[], evidence: ReadonlyMap<string, number>): string {
  if (q.state !== "MANAGER_APPROVED_FINAL") return "Not applicable";
  if (!doc) return "Not issued";
  const stored = (r: ReportResponse) => r as unknown as StoredResponse; const rv = reviews as unknown as StoredReview[];
  const mine = responses.filter((r) => r.document_id === doc.id);
  if (mine.some((r) => countsAsAcceptance(stored(r), rv, evidence))) return "Accepted";
  const l = mine[0];
  if (l) {
    const st = standingOf(stored(l), rv, evidence);
    if (l.response === "ACCEPTED" && (st === "PENDING_VERIFICATION" || st === "EVIDENCE_MISSING")) return "Accepted, verification pending";
    if (l.response === "ACCEPTED") return "Acceptance rejected";
    return l.response === "DECLINED" ? "Declined" : "Changes requested";
  }
  return sends.some((s) => s.document_id === doc.id && s.status === "ACCEPTED") ? "Awaiting response" : "Not sent";
}

/** The latest audited workflow action recorded ON the quotation rows (creation, hand-off, sign-off, approval, issue, send, customer response, verification). Null when none is recorded. */
function lastAction(q: ReportQuote, ix: Index): { by: string | null; at: string } | null {
  const ev: Array<{ by: string | null; at: string }> = [{ by: q.created_by_email, at: q.created_at }];
  if (q.customer_confirmed_at) ev.push({ by: q.handoff_by_email, at: q.customer_confirmed_at });
  if (q.estimator_signoff_at) ev.push({ by: q.estimator_signoff_by_email, at: q.estimator_signoff_at });
  if (q.approved_at) ev.push({ by: q.approved_by_email, at: q.approved_at });
  for (const d of ix.docs.get(q.id) ?? []) ev.push({ by: d.issued_by_email, at: d.created_at });
  for (const s of ix.sends.get(q.id) ?? []) ev.push({ by: s.sent_by_email, at: s.attempted_at ?? s.created_at });
  for (const r of ix.responses.get(q.id) ?? []) ev.push({ by: r.origin === "CUSTOMER_LINK" ? "Customer (link)" : r.recorded_by_email, at: r.created_at });
  for (const r of ix.reviews.get(q.id) ?? []) ev.push({ by: r.reviewed_by_email, at: r.created_at });
  for (const a of ix.decided.get(q.id) ?? []) if (a.decided_at) ev.push({ by: a.decided_by_email, at: a.decided_at });
  return latest(ev, (e) => e.at);
}

// ── rows ────────────────────────────────────────────────────────────────────

export interface PipelineRow {
  id: string; quoteRef: string; revision: number; customer: string; site: string; createdAt: string; createdBy: string | null;
  category: Category; stage: string; status: string; nextAction: string; waitingOn: RoleName; waitingOnLabel: string; assignedTo: string | null;
  lastActionBy: string | null; lastActionAt: string | null; ageDays: number | null; since: string | null; sinceSource: string;
  valueCents: number | null; valueBasis: "CONTRACT" | "CONFIRMED" | "NONE"; customerResponse: string;
  projectId: string | null; projectRef: string | null; outstanding: boolean; href: string;
}

export function pipelineRows(d: ReportData, now: Date): PipelineRow[] {
  const ix = indexData(d);
  const proj = new Map(d.projects.map((p) => [p.id, p]));
  return d.quotes.map((q) => {
    const s = classify(q, ix, d); const v = sellingValue(q);
    return {
      id: q.id, quoteRef: q.quote_ref, revision: q.revision, customer: q.customer_name, site: q.site_name, createdAt: q.created_at, createdBy: q.created_by_email,
      category: s.category, stage: s.stage, status: s.status, nextAction: s.nextAction, waitingOn: s.waitingOn, waitingOnLabel: s.waitingOnLabel, assignedTo: s.assignedTo,
      lastActionBy: s.lastActionBy, lastActionAt: s.lastActionAt, ageDays: s.category === "COMPLETE" ? null : daysBetween(s.since, now), since: s.since, sinceSource: s.sinceSource,
      valueCents: v.cents, valueBasis: v.basis, customerResponse: s.customerResponse,
      projectId: q.project_id, projectRef: q.project_id ? proj.get(q.project_id)?.project_reference ?? null : null, outstanding: s.category !== "COMPLETE", href: `/newquip-grower/${q.id}`,
    };
  });
}

export interface Filters {
  from?: string; to?: string; creator?: string; assignee?: string; stage?: string; status?: string; customer?: string; action?: string; q?: string;
  view?: "mine" | "all" | "over3" | "over7"; sort?: "value" | "created" | "age" | "urgent"; dir?: "asc" | "desc"; page?: number; pageSize?: number;
}
const lc = (s: string | null | undefined) => (s ?? "").toLowerCase();
const dayStart = (s: string) => Date.parse(`${s}T00:00:00.000Z`); const dayEnd = (s: string) => Date.parse(`${s}T23:59:59.999Z`);

/** Date range on the quotation's CREATION date (the one date every quotation has). */
export function inRange(createdAt: string, from?: string, to?: string): boolean {
  const c = Date.parse(createdAt);
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from) && c < dayStart(from)) return false;
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to) && c > dayEnd(to)) return false;
  return true;
}

export interface Viewer { email: string; roles: ReadonlySet<"rep" | "estimator" | "manager"> }

/** "My actions": what is waiting on a role the viewer holds. A Rep's items are those they CREATED (the creator is the only Rep association the application records). */
export function isMine(r: PipelineRow, v: Viewer): boolean {
  if (!r.outstanding) return false;
  const me = lc(v.email);
  if (v.roles.has("rep") && (r.waitingOn === "Rep" || r.waitingOn === "Rep or Manager") && lc(r.createdBy) === me) return true;
  if (v.roles.has("estimator") && r.waitingOn === "Estimator") return true;
  if (v.roles.has("manager") && (r.waitingOn === "Manager" || r.waitingOn === "Rep or Manager") && (!r.assignedTo || lc(r.assignedTo) === me)) return true;
  return false;
}

export function applyFilters(rows: PipelineRow[], f: Filters, v: Viewer): PipelineRow[] {
  const q = lc(f.q).trim(); const cust = lc(f.customer).trim();
  return rows.filter((r) => {
    if (!inRange(r.createdAt, f.from, f.to)) return false;
    if (f.creator && lc(r.createdBy) !== lc(f.creator)) return false;
    if (f.assignee && !(lc(r.assignedTo) === lc(f.assignee) || (f.assignee === "unassigned" && !r.assignedTo))) return false;
    if (f.stage && r.stage !== f.stage) return false;
    if (f.status && r.status !== f.status) return false;
    if (f.action && r.category !== f.action) return false;
    if (cust && !lc(r.customer).includes(cust)) return false;
    if (q && !(lc(r.quoteRef).includes(q) || lc(r.customer).includes(q) || lc(r.site).includes(q))) return false;
    if (f.view === "mine" && !isMine(r, v)) return false;
    if (f.view === "over3" && !(r.outstanding && r.ageDays != null && r.ageDays > 3)) return false;
    if (f.view === "over7" && !(r.outstanding && r.ageDays != null && r.ageDays > 7)) return false;
    return true;
  });
}

/** Deterministic: the chosen key, then quotation reference, then id (so equal values never reorder between requests or pages). */
export function sortRows(rows: PipelineRow[], sort: Filters["sort"] = "urgent", dir: Filters["dir"] = "desc"): PipelineRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const num = (n: number | null) => (n == null ? null : n);
  const key = (r: PipelineRow): number | null => sort === "value" ? num(r.valueCents) : sort === "created" ? Date.parse(r.createdAt) : num(r.ageDays);
  return rows.slice().sort((a, b) => {
    // Rows with no value / unknown age always sort LAST, whichever direction.
    const ka = key(a); const kb = key(b);
    if (ka !== kb) { if (ka == null) return 1; if (kb == null) return -1; return (ka - kb) * sign; }
    if (a.outstanding !== b.outstanding) return a.outstanding ? -1 : 1;
    return a.quoteRef < b.quoteRef ? -1 : a.quoteRef > b.quoteRef ? 1 : a.id < b.id ? -1 : 1;
  });
}

export function paginate<T>(rows: readonly T[], page = 1, pageSize = 25): { rows: T[]; page: number; pageSize: number; total: number; pages: number } {
  const size = Math.min(Math.max(Math.floor(pageSize) || 25, 1), 200); const total = rows.length; const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(Math.floor(page) || 1, 1), pages);
  return { rows: rows.slice((p - 1) * size, p * size), page: p, pageSize: size, total, pages };
}

// ── Management overview ─────────────────────────────────────────────────────

export interface Overview {
  generatedAt: string; open: number; indicativePipelineCents: number; withoutValue: number;
  awaitingRep: number; awaitingEstimator: number; awaitingManager: number; awaitingCustomer: number; awaitingVerification: number; handover: number;
  accepted: number; declinedOrReturned: number; total: number;
  byCategory: Array<{ category: Category; label: string; count: number; valueCents: number }>;
  projects: { active: number; byStatus: Array<{ status: string; count: number; valueCents: number }>; convertedQuotes: number; awaitingNextMilestone: "UNAVAILABLE" };
  attention: PipelineRow[];
}

export function overviewOf(rows: readonly PipelineRow[], projects: readonly ReportProject[], now: Date, attention = 10): Overview {
  const open = rows.filter((r) => r.outstanding);
  const cnt = (...c: Category[]) => rows.filter((r) => c.includes(r.category)).length;
  // Each quotation appears ONCE (one row per quotation), so approval/response history can never double-count it.
  const pipeline = open.filter((r) => r.category !== "CUSTOMER_DECLINED" && r.category !== "ACCEPTANCE_REJECTED");
  const byCat = new Map<Category, { count: number; valueCents: number }>();
  for (const r of rows) { const c = byCat.get(r.category) ?? { count: 0, valueCents: 0 }; c.count++; c.valueCents += r.valueCents ?? 0; byCat.set(r.category, c); }
  const cust = projects.filter((p) => !p.parent_project_id && p.billing_scope !== "VARIATION");
  const byStatus = new Map<string, { count: number; valueCents: number }>();
  for (const p of cust) { const c = byStatus.get(p.status) ?? { count: 0, valueCents: 0 }; c.count++; c.valueCents += p.original_contract_cents; byStatus.set(p.status, c); }
  const urgent = sortRows(open.filter((r) => r.ageDays != null), "age", "desc").concat(open.filter((r) => r.ageDays == null));
  return {
    generatedAt: now.toISOString(), open: pipeline.length, indicativePipelineCents: pipeline.reduce((n, r) => n + (r.valueCents ?? 0), 0), withoutValue: pipeline.filter((r) => r.valueCents == null).length,
    awaitingRep: cnt("REP_DRAFT", "REP_CORRECTION", "DOC_NOT_ISSUED", "NOT_SENT"), awaitingEstimator: cnt("ESTIMATOR_REVIEW"), awaitingManager: cnt("MANAGER_APPROVAL"),
    awaitingCustomer: cnt("AWAITING_CUSTOMER"), awaitingVerification: cnt("ACCEPTANCE_VERIFICATION"), handover: cnt("PROJECT_HANDOVER"),
    accepted: rows.filter((r) => r.customerResponse === "Accepted").length, declinedOrReturned: cnt("CUSTOMER_DECLINED", "CHANGES_REQUESTED", "ACCEPTANCE_REJECTED", "REP_CORRECTION"), total: rows.length,
    byCategory: [...byCat.entries()].map(([category, v]) => ({ category, label: CATEGORY_LABEL[category], ...v })).sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : 1)),
    projects: { active: cust.filter((p) => p.status === "ACTIVE").length, byStatus: [...byStatus.entries()].map(([status, v]) => ({ status, ...v })).sort((a, b) => (a.status < b.status ? -1 : 1)), convertedQuotes: rows.filter((r) => !!r.projectId).length, awaitingNextMilestone: "UNAVAILABLE" },
    attention: urgent.slice(0, attention),
  };
}

// ── formatting shared by the pages and the export ──────────────────────────

/** South African date: 2026/11/18 (year/month/day, the SA convention used across NewQuip). */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return "—";
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}
export const ageText = (days: number | null): string => (days == null ? "Not recorded" : days === 0 ? "Today" : `${days} day${days === 1 ? "" : "s"}`);
