import type { CompanyProfile } from "./company-profile";

// DEMONSTRATION-ONLY quotation wording. The customer PDF takes its payment terms, delivery/installation conditions, terms and acceptance instructions from the shared
// company profile. For the two designated demonstration quotations (NQ-Q-0025 and NQ-Q-0026 in the NewQuip organisation) these four texts are replaced IN THE PDF ONLY; the stored
// company profile, every other quotation and every other organisation are untouched, and company details (name, address, VAT, contact) are kept.
const DEMO_ORG_ID = "e1aea782-d095-47ad-90fb-4fa65c9bf855";
const DEMO_QUOTE_REFS: readonly string[] = ["NQ-Q-0025", "NQ-Q-0026"]; // 0025 = fully configured reference, 0026 = the Rep-start demonstration quotation

export const DEMO_TERMS: Pick<CompanyProfile, "paymentTerms" | "deliveryInstallationConditions" | "termsAndConditions" | "acceptanceInstructions"> = {
  paymentTerms: "DEMONSTRATION ONLY. Payment milestones are illustrative and subject to final commercial agreement. No payment is due under this quotation.",
  deliveryInstallationConditions: "DEMONSTRATION ONLY. Delivery, installation, site access and commissioning arrangements are subject to site verification and written agreement.",
  termsAndConditions: "This quotation demonstrates the NewQuip system and is not a binding commercial offer. Prices, estimates and conditions are provided for demonstration purposes only.",
  acceptanceInstructions: "DEMONSTRATION ONLY. This document is not available for commercial acceptance.",
};

/** `marked`: the quotation was created in POC Presentation Mode (its assumptions carry the POC marker). Marked quotations in the NewQuip organisation get the demonstration wording, as do the two designated references. */
export function applyDemoTerms(profile: CompanyProfile, orgId: string, quoteRef: string, marked = false): CompanyProfile {
  return orgId === DEMO_ORG_ID && (marked || DEMO_QUOTE_REFS.includes(quoteRef)) ? { ...profile, ...DEMO_TERMS } : profile;
}
