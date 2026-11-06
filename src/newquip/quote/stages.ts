import type { QuoteState } from "./workflow";

// SOLUTION BUILDER STAGES (pure). Six presentation stages derived from EXISTING state and immutable evidence - there is no stored "stage": the quotation's workflow state
// (REP_DRAFT / ESTIMATOR_REVIEW / MANAGER_APPROVED_FINAL), the estimator sign-off, the approval baseline, the issued documents, sends and customer responses, and the project
// link are the source of truth. Nothing here authorises anything: every action is still checked by the server.
//
//   1 Configuration -> 2 Costing & Estimator Review -> 3 Manager Approval -> 4 Customer Quotation -> 5 Customer Acceptance -> 6 Project Handover

export type StageId = 1 | 2 | 3 | 4 | 5 | 6;
export type StageStatus = "LOADING" | "COMPLETE" | "IN_PROGRESS" | "AWAITING_ACTION" | "RETURNED" | "NOT_STARTED" | "NOT_AVAILABLE" | "NOT_REQUIRED";
export type CommercialState = "NOT_APPROVED" | "APPROVED_INTERNALLY" | "SENT_TO_CUSTOMER" | "ACCEPTANCE_PENDING_VERIFICATION" | "ACCEPTANCE_REJECTED" | "CUSTOMER_ACCEPTED" | "CUSTOMER_DECLINED" | "CHANGES_REQUESTED";

export interface StageInput {
  state: QuoteState;
  revision: number;
  /** The quote is READY (complete) and has a customer. */
  ready: boolean;
  customerSelected: boolean;
  /** newquip_quotes.customer_confirmed_cents is recorded (the PRE-APPROVAL confirmation). */
  confirmed: boolean;
  /** The estimator signed off the CURRENT content. */
  signedOff: boolean;
  /** Derived from the append-only document / send / response records; null while they are still loading (or before migration 0115). */
  commercial: CommercialState | null;
  hasDocument: boolean;
  /** The state of the customer's emailed response link for the current document (migration 0117); optional. */
  linkState?: "NONE" | "ACTIVE" | "EXPIRED" | "REVOKED";
  requiresAcceptance: boolean;
  projectLinked: boolean;
  /** The commercial status (documents / sends / responses) has NOT been read yet. Stages 4-5 (and 6 until a Project link proves it) then show "Loading" instead of a guess derived from empty defaults. */
  loading?: boolean;
}

export interface StageView { id: StageId; label: string; status: StageStatus; statusLabel: string; summary: string; next: string | null }

export const STAGE_LABEL: Record<StageId, string> = { 1: "Configuration", 2: "Costing & Estimator Review", 3: "Manager Approval", 4: "Customer Quotation", 5: "Customer Acceptance", 6: "Project Handover" };
export const STATUS_LABEL: Record<StageStatus, string> = {
  LOADING: "Loading…", COMPLETE: "Complete", IN_PROGRESS: "In progress", AWAITING_ACTION: "Awaiting action", RETURNED: "Returned", NOT_STARTED: "Not started", NOT_AVAILABLE: "Not yet available", NOT_REQUIRED: "Not required",
};

const v = (id: StageId, status: StageStatus, summary: string, next: string | null = null): StageView => ({ id, label: STAGE_LABEL[id], status, statusLabel: STATUS_LABEL[status], summary, next });

export function computeStages(i: StageInput): StageView[] {
  const final = i.state === "MANAGER_APPROVED_FINAL";
  const inReview = i.state === "ESTIMATOR_REVIEW";
  const returned = i.state === "REP_DRAFT" && i.revision > 1;
  const grandfathered = final && !i.requiresAcceptance;
  const c = i.commercial;

  // 1 Configuration
  const s1 = inReview || final ? v(1, "COMPLETE", "Configured and handed to review.")
    : returned ? v(1, "RETURNED", "Returned to the Rep (new revision).", "Rep: make any requested changes, then reconfirm the amount in Stage 2.")
    : i.ready && i.customerSelected ? v(1, "COMPLETE", "Complete: the quote is READY.")
    : v(1, "IN_PROGRESS", i.customerSelected ? "Complete the configuration until the quote is READY." : "Select the customer and complete the configuration.", i.customerSelected ? "Rep: resolve the readiness items." : "Rep: select the Cin7 customer.");

  // 2 Costing & Estimator Review
  const s2 = final ? v(2, "COMPLETE", "Signed off by the Estimator.")
    : inReview ? (i.signedOff ? v(2, "COMPLETE", "Signed off by the Estimator.") : v(2, "AWAITING_ACTION", "With the Estimator for review.", "Estimator: review the costing and sign off, or return to the Rep."))
    : returned && i.ready && i.customerSelected ? v(2, "AWAITING_ACTION", "Returned: reconfirm the amount with the customer.", "Rep: record the pre-approval price confirmation and send to the Estimator.")
    : i.ready && i.customerSelected ? v(2, "AWAITING_ACTION", "Ready to send to the Estimator.", "Rep: record the pre-approval price confirmation and send to the Estimator.")
    : v(2, "NOT_STARTED", "Starts once the quote is READY.");

  // 3 Manager Approval
  const s3 = final ? v(3, "COMPLETE", "Approved by the Manager.")
    : inReview && i.signedOff ? v(3, "AWAITING_ACTION", "With the Manager for the final decision.", "Manager: approve, return to the Estimator, or return to the Rep.")
    : v(3, "NOT_STARTED", inReview ? "Waiting for the Estimator's sign-off." : "Starts after Estimator sign-off.");

  // 4 Customer Quotation
  const sent = c === "SENT_TO_CUSTOMER" || c === "ACCEPTANCE_PENDING_VERIFICATION" || c === "ACCEPTANCE_REJECTED" || c === "CUSTOMER_ACCEPTED" || c === "CUSTOMER_DECLINED" || c === "CHANGES_REQUESTED";
  const s4 = !final ? v(4, "NOT_AVAILABLE", "Available once the Manager has approved.")
    : sent ? v(4, "COMPLETE", "Issued and sent to the customer.")
    : grandfathered ? v(4, "NOT_REQUIRED", "Approved before customer acceptance was introduced: issuing is optional.", i.hasDocument ? "Rep: send it to the customer if you want to." : null)
    : i.hasDocument ? v(4, "AWAITING_ACTION", "PDF issued: confirm the recipient and send it.", "Rep: review the PDF and send it to the customer.")
    : v(4, "AWAITING_ACTION", "Approved: ready to issue the customer PDF.", "Rep: choose the payment schedule and generate the customer quotation PDF.");

  // 5 Customer Acceptance
  const s5 = !final ? v(5, "NOT_AVAILABLE", "Available once the quotation has been issued.")
    : grandfathered ? v(5, "NOT_REQUIRED", "Approved before customer acceptance was introduced.")
    : c === "CUSTOMER_ACCEPTED" ? v(5, "COMPLETE", "The customer's acceptance of the issued quotation is verified.")
    : c === "ACCEPTANCE_PENDING_VERIFICATION" ? v(5, "AWAITING_ACTION", "The customer accepted: verification pending.", "Rep or Manager: check who responded and verify or reject the acceptance.")
    : c === "ACCEPTANCE_REJECTED" ? v(5, "RETURNED", "The customer's emailed acceptance was rejected during verification.", "Contact the customer; record their response manually with evidence, or send the quotation again for a fresh link.")
    : c === "CUSTOMER_DECLINED" ? v(5, "RETURNED", "The customer declined the issued quotation.", "Prepare a revised quotation (it goes through Estimator and Manager again).")
    : c === "CHANGES_REQUESTED" ? v(5, "RETURNED", "The customer asked for changes.", "Prepare a revised quotation (it goes through Estimator and Manager again).")
    : c === "SENT_TO_CUSTOMER" && (i.linkState === "EXPIRED" || i.linkState === "REVOKED") ? v(5, "AWAITING_ACTION", `Waiting for the customer's response; the emailed link ${i.linkState === "EXPIRED" ? "has expired" : "was withdrawn"}.`, "Record the response with its evidence, or send the quotation again for a fresh link.")
    : c === "SENT_TO_CUSTOMER" ? v(5, "AWAITING_ACTION", "Waiting for the customer's response.", "Record the customer's response with its evidence, or wait for them to use the emailed link.")
    : v(5, "NOT_STARTED", i.hasDocument ? "Awaiting the quotation to be sent." : "Awaiting quotation issue.");

  // 6 Project Handover
  const s6 = !final ? v(6, "NOT_AVAILABLE", "Available once the quotation is accepted.")
    : i.projectLinked ? v(6, "COMPLETE", "Project created from the accepted quotation.")
    : i.requiresAcceptance && c === "ACCEPTANCE_PENDING_VERIFICATION" ? v(6, "NOT_AVAILABLE", "Waiting for the customer's emailed acceptance to be verified (Stage 5).")
    : i.requiresAcceptance && c !== "CUSTOMER_ACCEPTED" ? v(6, "NOT_AVAILABLE", "Needs the customer's verified acceptance of the issued quotation (Stage 5).")
    : v(6, "AWAITING_ACTION", "Eligible: create the Project from the accepted baseline.", "Create the Project.");

  // The persisted commercial records are read in a second step. Until they arrive, never present an earlier-looking stage (a guess from empty defaults): say it is loading.
  if (final && i.loading) {
    const wait = (id: StageId) => v(id, "LOADING", "Loading the current status of this quotation…");
    return [s1, s2, s3, wait(4), wait(5), i.projectLinked ? s6 : wait(6)];
  }
  return [s1, s2, s3, s4, s5, s6];
}

/** The stage the user should land on: the first stage that needs attention, else the last completed one. */
export function currentStage(stages: readonly StageView[]): StageId {
  const wait = stages.find((s) => s.status === "LOADING");
  if (wait && stages.find((x) => x.id === 6)?.status !== "COMPLETE") return wait.id; // a Project link already proves the end of the journey: land there, as the loaded state will
  const act = stages.find((s) => s.status === "AWAITING_ACTION" || s.status === "RETURNED" || s.status === "IN_PROGRESS");
  if (act) return act.id;
  const done = [...stages].reverse().find((s) => s.status === "COMPLETE" || s.status === "NOT_REQUIRED");
  return done?.id ?? 1;
}

export const parseStage = (raw: string | null | undefined): StageId | null => { const n = Number(raw); return Number.isInteger(n) && n >= 1 && n <= 6 ? (n as StageId) : null; };
