// The end-to-end journey, verified against src/newquip/quote/workflow.ts, stages.ts and the UAT quotation screen (four-step rail: Configure & Submit, Cost & Verify, Approve or Return, Customer & Handover).
export type JourneyStage = { slug: string; label: string; actor: string; detail: string };

export const JOURNEY: JourneyStage[] = [
  { slug: "rep-create-quote", label: "Create the quotation", actor: "Sales Rep", detail: "Pick the Cin7 customer and contact, capture the site, choose equipment. Automatic pricing may add indicative prices." },
  { slug: "rep-submit-to-estimator", label: "Confirm the amount and submit", actor: "Sales Rep", detail: "Record who at the customer confirmed the amount, then submit to the Estimator." },
  { slug: "estimator-workflow", label: "Cost the quotation", actor: "Estimator", detail: "Resolve mappings and missing costs, record FX and freight, and return to the Rep if something must change." },
  { slug: "rep-revisions", label: "Handle returns and revisions", actor: "Sales Rep", detail: "A return creates a new revision. The Rep corrects it and, if the total moved, reconfirms with the customer." },
  { slug: "cost-verification", label: "Verify costs independently", actor: "Manager", detail: "A Manager who did not enter a cost verifies it against evidence." },
  { slug: "estimator-signoff", label: "Estimator sign-off", actor: "Estimator", detail: "Sign off once costing is complete, or return the quotation." },
  { slug: "manager-approve", label: "Manager approval", actor: "Manager", detail: "Approve (freezing the baseline) or return it. Approval is internal only." },
  { slug: "rep-issue-and-send", label: "Issue the customer PDF", actor: "Rep or Manager", detail: "Needs real company details and a payment schedule." },
  { slug: "rep-issue-and-send", label: "Send to the customer", actor: "Sales Rep", detail: "Only a Rep sends. Production email is off in UAT." },
  { slug: "rep-acceptance", label: "Record customer acceptance", actor: "Rep or Manager", detail: "Evidence is required, and an emailed acceptance must be verified." },
  { slug: "project-creation", label: "Create the Project", actor: "Manager", detail: "Local only: nothing is written to Cin7 when a Project is created." },
  { slug: "cin7-sale", label: "Create the Cin7 Sales Order", actor: "Org owner or admin", detail: "An Advanced Sale, only where Cin7 writes are enabled." },
  { slug: "claims", label: "Prepare and approve progress claims", actor: "Project user, then Manager", detail: "Full or partial claims against billing stages." },
  { slug: "claim-posting", label: "Post the invoice to Cin7", actor: "Org owner or admin", detail: "One invoice per approved claim, only where Cin7 writes are enabled." },
];
