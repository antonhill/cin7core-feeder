// Approval policy (pure). The database repeats the state, version, digest, reason and separation checks; this layer gives the early, readable error
// and decides who may act. Hidden buttons are never the control: every server action calls these again.
import type { ApprovalAction, ApprovalRequestRow } from "./types";
import type { FunctionalRole } from "./roles";

export interface Actor { email: string; isManager: boolean }
export type Verdict = { ok: true; override: boolean } | { ok: false; error: string };
const lc = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * Who may take which action. Approve / return / reject: a manager (org owner/admin) only. Withdraw: the preparer or a manager.
 * A manager who prepared the submission may approve it ONLY as an explicit override, with a written reason (permanently recorded).
 */
export function authoriseDecision(a: Actor, action: ApprovalAction, req: Pick<ApprovalRequestRow, "status" | "prepared_by_email">, input: { reason?: string; override?: boolean }): Verdict {
  if (req.status !== "PENDING") return { ok: false, error: `This submission is already ${req.status.toLowerCase()}.` };
  const reason = (input.reason ?? "").trim();
  if (action === "WITHDRAW") return a.isManager || lc(a.email) === lc(req.prepared_by_email) ? { ok: true, override: false } : { ok: false, error: "Only the preparer or a manager can withdraw a submission." };
  if (!a.isManager) return { ok: false, error: "Only a manager (organisation owner or admin) can approve, return or reject a submission." };
  if ((action === "RETURN" || action === "REJECT") && reason.length < 3) return { ok: false, error: action === "RETURN" ? "Explain what must change: a written reason is required to return a submission." : "A written reason is required to reject a submission." };
  if (action === "APPROVE" && lc(a.email) === lc(req.prepared_by_email)) {
    if (!input.override) return { ok: false, error: "You prepared this submission, so you cannot approve it normally. A manager may approve their own submission only as an explicit override with a written reason, on the Approvals page." };
    if (reason.length < 10) return { ok: false, error: "An override needs a written reason (at least a short sentence)." };
    return { ok: true, override: true };
  }
  return { ok: true, override: false };
}

// ── staged decisions (migration 0112) ───────────────────────────────────────

export interface StageActor { email: string; roles: ReadonlySet<FunctionalRole>; /** Organisation owner/admin or explicit Administrator: the only people who may act as an override. */ isAdmin: boolean }
export type StageRequest = Pick<ApprovalRequestRow, "status" | "prepared_by_email" | "doc_type" | "assigned_to_email"> & { stage?: "ESTIMATOR" | "MANAGER"; originator_email?: string | null };
export type StageVerdict = { ok: true; override: boolean; destination: "ESTIMATOR" | "PREPARER" | null } | { ok: false; error: string };

/**
 * Who may take which action at a STAGE of an approval. The server repeats these checks inside every action; hidden buttons are never the control.
 *  - The actor must hold the stage's role. An administrator who does not may APPROVE only as an explicit override (reason of at least 10 characters).
 *  - Nobody approves what they prepared or originated except as that same explicit, reasoned, permanently recorded override. An override covers ONE stage:
 *    it never stands in for another role's sign-off, because each stage is its own request with its own decision.
 *  - A request assigned to a named user can be decided only by that user; anyone else needs it reassigned first.
 *  - Return destination: a manager returns a quotation to the ESTIMATOR by default (or to the rep); an estimator returns to the rep; claims and variations go back to their preparer.
 */
export function authoriseStageDecision(a: StageActor, action: ApprovalAction, req: StageRequest, requiredRole: FunctionalRole, input: { reason?: string; override?: boolean; destination?: "ESTIMATOR" | "PREPARER" | null }): StageVerdict {
  if (req.status !== "PENDING") return { ok: false, error: `This submission is already ${req.status.toLowerCase()}.` };
  const me = lc(a.email);
  const reason = (input.reason ?? "").trim();
  const stage = req.stage ?? "MANAGER";
  const preparedOrOriginated = me === lc(req.prepared_by_email) || me === lc(req.originator_email);
  if (action === "WITHDRAW") return a.isAdmin || a.roles.has("MANAGER") || preparedOrOriginated ? { ok: true, override: false, destination: null } : { ok: false, error: "Only the preparer or a manager can withdraw a submission." };
  const assigned = lc(req.assigned_to_email);
  if (assigned && assigned !== me) return { ok: false, error: `This submission is assigned to ${assigned}. Ask for it to be reassigned before deciding it.` };
  const hasRole = a.roles.has(requiredRole);
  if ((action === "RETURN" || action === "REJECT") && !hasRole) return { ok: false, error: `Only the ${requiredRole.toLowerCase().replace("_", " ")} role can ${action === "RETURN" ? "return" : "reject"} a submission at this stage.` };
  if ((action === "RETURN" || action === "REJECT") && reason.length < 3) return { ok: false, error: action === "RETURN" ? "Explain what must change: a written reason is required to return a submission." : "A written reason is required to reject a submission." };
  let override = false;
  if (action === "APPROVE") {
    if (!hasRole || preparedOrOriginated) {
      if (!a.isAdmin) return { ok: false, error: hasRole ? "You prepared or originated this submission, so you cannot approve it." : `Approval at this stage needs the ${requiredRole.toLowerCase().replace("_", " ")} role.` };
      if (!input.override) return { ok: false, error: hasRole ? "You prepared or originated this submission, so you cannot approve it normally. An administrator may approve it only as an explicit override with a written reason." : `You do not hold the ${requiredRole.toLowerCase().replace("_", " ")} role. An administrator may approve at this stage only as an explicit override with a written reason.` };
      if (reason.length < 10) return { ok: false, error: "An override needs a written reason (at least a short sentence)." };
      override = true;
    } else if (input.override) return { ok: false, error: "No override is needed: you may approve this normally." };
  }
  let destination: "ESTIMATOR" | "PREPARER" | null = null;
  if (action === "RETURN") {
    const managerStageQuote = req.doc_type === "QUOTE" && stage === "MANAGER";
    destination = input.destination ?? (managerStageQuote ? "ESTIMATOR" : "PREPARER");
    if (destination === "ESTIMATOR" && !managerStageQuote) return { ok: false, error: "Only a quotation in manager review can be returned to the estimator." };
  }
  return { ok: true, override, destination };
}
