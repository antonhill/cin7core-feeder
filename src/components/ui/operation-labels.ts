// UX-007: ONE vocabulary for "what is the app doing right now". Every pending state in the NewQuip workflow names its operation from here, so the same
// action reads the same wherever it is started, and a generic "Working…" / "Loading…" never reaches the presenter. Plain strings only: no behaviour, no data.
// Wording rule: present participle + the thing, ending in an ellipsis. Never a percentage, never a milestone the app cannot actually observe.

export const OP = {
  saveQuotation: "Saving quotation…",
  saveCustomer: "Saving the customer…",
  searchCustomers: "Searching Cin7 customers…",
  fetchCin7Product: "Fetching Cin7 product information…",
  fetchCin7Costs: "Fetching Cin7 cost information…",
  saveCostChange: "Saving the cost change…",
  recalculateCosts: "Recalculating costs…",
  saveSupplier: "Saving the supplier selection…",
  saveMapping: "Saving the package mapping…",
  loadScope: "Loading the physical scope…",
  loadCosts: "Loading the cost estimate…",
  checkCin7Customer: "Checking Cin7 for changes…",
  submitToEstimator: "Submitting to Estimator…",
  signOff: "Recording Estimator sign-off…",
  returnToRep: "Returning to the Rep…",
  returnToEstimator: "Returning to the Estimator…",
  approveQuotation: "Approving quotation…",
  generatePdf: "Generating customer PDF…",
  sendCustomerEmail: "Sending customer email…",
  retryCustomerEmail: "Retrying customer email…",
  revokeLinks: "Revoking customer response links…",
  loadCustomerResponse: "Loading customer response…",
  recordCustomerResponse: "Recording customer response…",
  verifyCustomerResponse: "Verifying customer response…",
  attachEvidence: "Uploading acceptance evidence…",
  createProject: "Creating project…",
  createQuotation: "Creating quotation…",
  createSalesOrder: "Creating Cin7 Sales Order…",
  postClaim: "Posting progress claim…",
  createInvoice: "Creating Cin7 invoice…",
  readBackCin7: "Reading back from Cin7…",
  loadPage: "Loading…",
} as const;

export type OperationLabel = (typeof OP)[keyof typeof OP];

/** Role switches name the role being switched to ("Switching to Estimator…"). */
export function switchingTo(roleLabel: string): string {
  return `Switching to ${roleLabel}…`;
}

/** Seconds after which a still-pending operation gets the persistent "still waiting" status. ~2s per the UX-007 brief. */
export const SLOW_AFTER_MS = 2000;

/** The honest sentence for an operation that has been pending past the threshold: it states only what is observed (time waited, nothing confirmed yet). */
export function stillWaitingText(elapsedSeconds: number): string {
  return `Still waiting for the server (${elapsedSeconds}s). Nothing is confirmed yet, so please do not click again.`;
}
