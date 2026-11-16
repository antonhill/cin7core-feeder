// FOUR-PHASE UX · small pure rules for what the shared header and the phase cards SAY. No I/O, no money arithmetic, no workflow decision: it only words facts the page already holds.

export type PhaseStage = 1 | 2 | 3 | 4 | 5 | 6;
export interface PhaseFacts { state: string; revision: number; final: boolean; signedOffCurrent: boolean; repReady: boolean; viewerIsRep: boolean }

/** The ONE status badge in the shared header, about the phase being viewed (so the Phase 4 screen never says "Returned to the Rep"). */
export function phaseBadge(stage: PhaseStage, f: PhaseFacts): { text: string; tone: "neutral" | "warn" | "ok" } {
  const returned = f.state === "REP_DRAFT" && f.revision > 1;
  if (f.final) return { text: "APPROVED", tone: "ok" };
  if (stage >= 4) return { text: "NOT APPROVED YET", tone: "warn" };
  if (stage === 3) {
    if (f.state === "REP_DRAFT") return { text: returned ? "RETURNED TO THE REP" : "WITH THE REP", tone: "warn" };
    return f.signedOffCurrent ? { text: "READY FOR THE MANAGER'S DECISION", tone: "ok" } : { text: "AWAITING ESTIMATOR SIGN-OFF", tone: "warn" };
  }
  // Phase 1 (and Phase 2 for a viewer who is not the Estimator)
  if (f.state === "REP_DRAFT") return returned ? { text: "RETURNED TO THE REP", tone: "warn" } : f.viewerIsRep && f.repReady && stage === 1 ? { text: "READY TO SUBMIT", tone: "ok" } : { text: "WITH THE REP", tone: "warn" };
  return f.signedOffCurrent ? { text: "SIGNED OFF", tone: "ok" } : { text: "SUBMITTED TO THE ESTIMATOR", tone: "neutral" };
}

/** A plain statement of where Phase 1 stands. It is a STATE, never an instruction: the one next action lives in the Next action bar. */
export function phase1State(f: PhaseFacts): string {
  if (f.final) return "Approved by the Manager. The configuration is frozen.";
  if (f.state === "REP_DRAFT") return f.revision > 1 ? `Returned to the Rep (revision ${f.revision}).` : "Being prepared by the Rep. Not yet submitted.";
  return f.signedOffCurrent ? "Submitted by the Rep and signed off by the Estimator." : "Submitted by the Rep. With the Estimator for costing and review.";
}

/** The same for Phase 3 (the Manager's decision). */
export function phase3State(f: PhaseFacts): string {
  if (f.final) return "Approved.";
  if (f.state === "REP_DRAFT") return f.revision > 1 ? `With the Rep (revision ${f.revision}). Not ready for a decision.` : "With the Rep. Not yet submitted.";
  return f.signedOffCurrent ? "Signed off by the Estimator. Waiting for the Manager's decision." : "With the Estimator. Not yet signed off.";
}

/** The label of the amount in the header: never a contract value until the quotation is approved; labelled indicative while lines await the Estimator. */
export function totalCaption(i: { final: boolean; awaitingLines: number; incomplete: boolean; confirmed: boolean }): { label: string; note: string | null } {
  if (i.final) return { label: "Contract value (ex VAT)", note: null };
  if (i.awaitingLines > 0) return { label: `Indicative total (${i.awaitingLines} line${i.awaitingLines === 1 ? "" : "s"} await the Estimator)`, note: "Not a contract value." };
  if (i.incomplete) return { label: "Partial total (ex VAT)", note: "Indicative only. Not a contract value." };
  return { label: i.confirmed ? "Amount confirmed by the Rep" : "Calculated total, not yet confirmed", note: "Not a contract value." };
}

/** The heading of the Manager's collapsed supporting detail. A role that cannot see costs is never told that cost evidence exists. */
export const supportingDetailLabel = (canSeeCosts: boolean): string => (canSeeCosts
  ? "Supporting detail: Rep submission, pricing evidence, exceptions and overrides"
  : "Supporting detail: Rep submission and sign-off");

/** The Next action bar text: one state-correct action (headline) and, when the stage has one, its explanation. */
export function nextActionText(pr: { summary: string; next?: string | null } | null): { headline: string; detail: string | null } | null {
  if (!pr) return null;
  return pr.next ? { headline: pr.next, detail: pr.summary } : { headline: pr.summary, detail: null };
}
