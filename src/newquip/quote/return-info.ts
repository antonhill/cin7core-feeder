// WHY IS THIS QUOTATION BACK WITH ME? One pure answer for the Rep / Estimator / Manager screens, derived from records that ALREADY exist (no migration):
//   * RECORD   - the append-only `activity_log` row `newquip.quote_return_recorded`, written by every transition that sends a quotation back (quote-store returnToRep,
//                returnToEstimator, applyCustomerChange), BEFORE the state change and bound to the revision it produces;
//   * AUDIT    - the S1b withdrawal row `newquip.quote_confirmation_invalidated` (amount / contact changed), which already carries previousCents -> newCents;
//   * APPROVAL - a RETURNED `approval_requests` row (decision_reason, decided_by_email, decided_at, return_destination): the fallback for returns made before this record existed.
// Pure: no I/O, no clock. The server loads the candidates (return-store.ts) and calls `latestReturnInfo`. Nothing here is cost or margin data.
import type { QuoteRole } from "./roles";

export const RETURN_RECORD_ACTION = "newquip.quote_return_recorded";
export const CONFIRMATION_WITHDRAWN_ACTION = "newquip.quote_confirmation_invalidated";

export type ReturnKind = "RETURN" | "AMOUNT_CHANGED" | "CUSTOMER_CHANGED" | "CONTACT_CHANGED";
export type ReturnDestination = "REP" | "ESTIMATOR";
export type ReturnSource = "RECORD" | "AUDIT" | "APPROVAL";

/** What the screens show. `byRole` is the capacity the actor acted in; `previousCents`/`newCents` are the commercial total ex VAT (AMOUNT_CHANGED only). */
export interface ReturnInfo {
  kind: ReturnKind;
  reason: string;
  byEmail: string | null;
  byRole: QuoteRole | null;
  /** ISO-8601 UTC. */
  at: string;
  destination: ReturnDestination;
  previousCents?: number;
  newCents?: number;
  source: ReturnSource;
}

/** A candidate before it is checked against the quotation's current state. `revision` is the quotation revision the return PRODUCED (absent for sources that do not store it). */
export interface ReturnCandidate extends ReturnInfo {
  revision?: number | null;
}

/** The slice of the quotation row the decision needs. */
export interface ReturnQuoteFacts { state: string; revision: number; estimator_signoff_hash: string | null }

export const NEUTRAL_REASON: Record<Exclude<ReturnKind, "RETURN">, string> = {
  AMOUNT_CHANGED: "The quotation total changed, so the customer's price confirmation was withdrawn.",
  CUSTOMER_CHANGED: "The customer on the quotation changed, so the customer's price confirmation and any sign-off were withdrawn.",
  CONTACT_CHANGED: "The confirmed customer contact changed, so the customer's price confirmation was withdrawn.",
};

const asRole = (v: unknown): QuoteRole | null => (v === "rep" || v === "estimator" || v === "manager" ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const cents = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The detail written by `recordReturn`; kept next to its parser so the two cannot drift. */
export interface ReturnRecordDetail {
  quoteId: string;
  kind: ReturnKind;
  reason: string;
  byEmail: string;
  byRole: QuoteRole;
  destination: ReturnDestination;
  fromState: string;
  fromRevision: number;
  /** The revision the quotation has once the return is applied (unchanged for a Manager -> Estimator return). */
  toRevision: number;
  previousCents?: number;
  newCents?: number;
}

export function returnRecordDetail(d: ReturnRecordDetail): Record<string, unknown> {
  return { ...d };
}

export interface ActivityRow { action: string; actor_email?: string | null; detail: Record<string, unknown> | null; created_at: string }

/** An activity_log row as a candidate; null when it is not a return/withdrawal row or is malformed. */
export function candidateFromActivity(row: ActivityRow): ReturnCandidate | null {
  const d = row.detail ?? {};
  if (row.action === RETURN_RECORD_ACTION) {
    const kind = d.kind;
    const dest = d.destination;
    const reason = str(d.reason);
    if ((kind !== "RETURN" && kind !== "AMOUNT_CHANGED" && kind !== "CUSTOMER_CHANGED" && kind !== "CONTACT_CHANGED") || (dest !== "REP" && dest !== "ESTIMATOR") || !reason) return null;
    return { kind, reason, byEmail: str(d.byEmail), byRole: asRole(d.byRole), at: row.created_at, destination: dest, previousCents: cents(d.previousCents), newCents: cents(d.newCents), source: "RECORD", revision: typeof d.toRevision === "number" ? d.toRevision : null };
  }
  if (row.action === CONFIRMATION_WITHDRAWN_ACTION) {
    // S1b's audit shape: { quoteId, reason: "AMOUNT_CHANGED" | "CONTACT_CHANGED", previousCents?, newCents?, confirmationCleared, signoffCleared, returnedToRep }. Under Demo Mode the real owner is the actor; the effective user is in the detail.
    const kind = d.reason === "AMOUNT_CHANGED" || d.reason === "CONTACT_CHANGED" ? d.reason : null;
    if (!kind || d.confirmationCleared === false) return null;
    return {
      kind, reason: NEUTRAL_REASON[kind], byEmail: str(d.effectiveUser) ?? str(row.actor_email), byRole: null, at: row.created_at, destination: "REP",
      previousCents: cents(d.previousCents), newCents: cents(d.newCents), source: "AUDIT", revision: null,
    };
  }
  return null;
}

export interface ApprovalReturnRow { status: string; decision_reason: string | null; decided_by_email: string | null; decided_at: string | null; return_destination?: string | null; stage?: string | null }

/** A RETURNED approval request as a candidate (returns made before the dedicated record existed). A staged request without a destination returned to the preparer. */
export function candidateFromApproval(row: ApprovalReturnRow): ReturnCandidate | null {
  const reason = str(row.decision_reason);
  if (row.status !== "RETURNED" || !reason || !row.decided_at) return null;
  return {
    kind: "RETURN", reason, byEmail: str(row.decided_by_email), byRole: row.stage === "ESTIMATOR" ? "estimator" : "manager", at: row.decided_at,
    destination: row.return_destination === "ESTIMATOR" ? "ESTIMATOR" : "REP", source: "APPROVAL", revision: null,
  };
}

/** Does this candidate still describe why the quotation is where it is NOW? */
function appliesTo(q: ReturnQuoteFacts, c: ReturnCandidate): boolean {
  if (c.destination === "REP") return q.state === "REP_DRAFT" && q.revision > 1 && (c.revision == null || c.revision === q.revision);
  return q.state === "ESTIMATOR_REVIEW" && q.estimator_signoff_hash == null && (c.revision == null || c.revision === q.revision);
}

const time = (iso: string): number => { const t = Date.parse(iso); return Number.isFinite(t) ? t : 0; };

/**
 * The reason the quotation is in its CURRENT place, or null when nothing sent it back (first draft, or it has moved on since). The latest applicable candidate wins;
 * an APPROVAL candidate is ignored when a RECORD already describes the same decision (same reason, same actor), so a return is never shown from two places.
 */
export function latestReturnInfo(q: ReturnQuoteFacts, history: readonly ReturnCandidate[]): ReturnInfo | null {
  const records = history.filter((c) => c.source === "RECORD");
  const fresh = history.filter((c) => !(c.source === "APPROVAL" && records.some((r) => r.reason === c.reason && (r.byEmail ?? "").toLowerCase() === (c.byEmail ?? "").toLowerCase())));
  let best: ReturnCandidate | null = null;
  for (const c of fresh) {
    if (!appliesTo(q, c)) continue;
    if (!best || time(c.at) >= time(best.at)) best = c;
  }
  if (!best) return null;
  const { revision: _revision, ...info } = best; void _revision;
  return stripUndefined(info);
}

function stripUndefined(i: ReturnInfo): ReturnInfo {
  const o = { ...i };
  if (o.previousCents === undefined) delete o.previousCents;
  if (o.newCents === undefined) delete o.newCents;
  return o;
}

/** The capacity a returning actor acted in. A stage-bound caller states it; otherwise a Manager outranks an Estimator. */
export function returnRoleOf(roles: ReadonlySet<QuoteRole>, stageRole?: QuoteRole | null): QuoteRole {
  if (stageRole) return stageRole;
  return roles.has("manager") ? "manager" : roles.has("estimator") ? "estimator" : "rep";
}
