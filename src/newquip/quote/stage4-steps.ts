import type { RailStep } from "@/components/ui/step-rail-model";
import type { CommercialState } from "./stages";

// SOLUTION BUILDER STAGE 4 STEPS (pure). Two steps over the Customer Quotation panel: 1 Issue PDF, 2 Send to customer. A step is complete ONLY from the issued-document and
// sent records the page already reads (`hasDocument`, the commercial status derived from the append-only sends); nothing is complete because it was visited, and nothing here
// gates the Issue or Send buttons.

export type Stage4StepId = "issue" | "send";
export const STAGE4_STEP_IDS: readonly Stage4StepId[] = ["issue", "send"];
export const STAGE4_STEP_LABEL: Record<Stage4StepId, string> = { issue: "Issue PDF", send: "Send to customer" };

const SENT: ReadonlySet<string> = new Set<CommercialState>(["SENT_TO_CUSTOMER", "ACCEPTANCE_PENDING_VERIFICATION", "ACCEPTANCE_REJECTED", "CUSTOMER_ACCEPTED", "CUSTOMER_DECLINED", "CHANGES_REQUESTED"]);

export function deriveStage4Steps(i: { hasDocument: boolean; commercial: CommercialState | string | null }): Array<RailStep & { id: Stage4StepId }> {
  const sent = i.commercial != null && SENT.has(i.commercial);
  return [
    { id: "issue", label: STAGE4_STEP_LABEL.issue, status: i.hasDocument ? "complete" : "incomplete", note: i.hasDocument ? "A PDF is issued." : "Generate the customer quotation PDF." },
    { id: "send", label: STAGE4_STEP_LABEL.send, status: !i.hasDocument ? "unavailable" : sent ? "complete" : "incomplete", note: !i.hasDocument ? "Issue the PDF first. Sent by a Rep." : sent ? "Sent to the customer." : "Sent by a Rep." },
  ];
}
