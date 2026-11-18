// SOLUTION BUILDER STAGE 6 READINESS (pure). The checklist above "Create Project from accepted quote" restates the handover's existing conditions from state the page already holds:
// the quote is approved, the customer's acceptance is recorded (when required), the billing schedule totals the contract (the same `resolveScheduleChoice(...).ok` the button's
// disabled reason uses) and the viewer is a Manager. It authorises nothing; the button, its disabled reasons and the server keep their own gates.

export interface HandoverItem { id: "approved" | "acceptance" | "schedule" | "manager"; label: string; met: boolean; detail: string; /** The stage that fixes an unmet row (linked from the row). */ fixStage?: 3 | 5 }

export function deriveHandoverReadiness(i: {
  approved: boolean;
  /** The customer's acceptance of the issued quotation is required (gate.requires). */
  acceptanceRequired: boolean;
  accepted: boolean;
  /** `resolveScheduleChoice(choice).ok`; unused when acceptance is required (the Project then uses the schedule printed on the accepted quotation). */
  scheduleOk: boolean;
  isManager: boolean;
}): HandoverItem[] {
  return [
    { id: "approved", label: "The quotation is Manager-approved", met: i.approved, detail: i.approved ? "Approved: the baseline is frozen." : "Needs the Manager's final approval (Stage 3).", fixStage: i.approved ? undefined : 3 },
    i.acceptanceRequired
      ? { id: "acceptance", label: "The customer's acceptance is recorded", met: i.accepted, detail: i.accepted ? "Recorded and verified." : "A Project for a new quotation is created only after the customer's acceptance of the issued quotation is recorded (with its evidence) or, if it came by email, verified. Nothing is created automatically.", fixStage: i.accepted ? undefined : 5 }
      : { id: "acceptance", label: "The customer's acceptance is recorded", met: true, detail: "Not required: approved before customer acceptance was introduced." },
    i.acceptanceRequired
      ? { id: "schedule", label: "The billing schedule totals the contract", met: true, detail: "The Project uses the schedule printed on the accepted quotation." }
      : { id: "schedule", label: "The billing schedule totals the contract", met: i.scheduleOk, detail: i.scheduleOk ? "The stages add up to the contract value." : "Fix the billing schedule below (the stages must add up to the contract value)." },
    { id: "manager", label: "You have the Manager role", met: i.isManager, detail: i.isManager ? "You can create the Project." : "Only a Manager creates the Project." },
  ];
}
