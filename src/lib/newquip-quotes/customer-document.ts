// Customer-facing quotation document MODEL (pure; no I/O). This is the ONLY thing the PDF renders, and it is built from an explicit allowlist: the sealed baseline's
// customer-safe commercial figures, the customer snapshot and the controlled company profile. Cost, margin, supplier, procurement, exchange-rate, estimator-note and
// approval-history data are never copied into it - and assertNoInternalLeak() re-checks the finished model against the baseline before anything is issued.
import { buildCustomerSummaryFromCommercial } from "@/newquip/grower/customer-summary";
import type { AcceptedBaseline } from "@/newquip/quote/baseline";
import { splitContractIntoStages } from "@/newquip/quote/to-project";
import type { ScheduleStageTemplate } from "@/newquip/quote/billing-schedule";
import { fieldValue, type CustomerSnapshot } from "./customer-snapshot";
import type { CompanyProfile } from "./company-profile";

export interface CustomerDocumentModel {
  schemaVersion: 1;
  company: Pick<CompanyProfile, "brandName" | "legalName" | "registrationNumber" | "vatNumber" | "addressLines" | "phone" | "email" | "website">;
  quote: { reference: string; revision: number; issuedOn: string; validUntil: string; validityDays: number; siteName: string };
  customer: { name: string; tradingName: string | null; vatNumber: string | null; billingAddress: string[]; contactName: string; contactEmail: string; contactPhone: string | null };
  currency: "ZAR";
  sections: { title: string; scope: string; amountExVat: number }[];
  totals: { subtotalExVat: number; vatRatePercent: number; vat: number; totalIncVat: number };
  paymentSchedule: { name: string; description: string; percent: number; amountExVat: number }[];
  paymentTerms: string;
  deliveryInstallationConditions: string;
  termsAndConditions: string;
  acceptanceInstructions: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const addDays = (isoDate: string, days: number): string => { const d = new Date(`${isoDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

export interface ModelInput {
  baseline: AcceptedBaseline; quoteRef: string; revision: number; snapshot: CustomerSnapshot; profile: CompanyProfile; schedule: readonly ScheduleStageTemplate[]; issuedOn: string; /** YYYY-MM-DD */
}

export function buildCustomerDocumentModel(i: ModelInput): CustomerDocumentModel {
  const b = i.baseline; const s = i.snapshot; const p = i.profile;
  if (!s.chosenContact) throw new Error("The quotation contact has not been chosen.");
  const name = fieldValue(s.name);
  if (!name) throw new Error("The customer has no name.");
  const a = s.billingAddress;
  const address = a ? [a.line1, a.line2, [a.city, a.state, a.postcode].map(fieldValue).filter(Boolean).join(" "), a.country].map((f) => (typeof f === "string" ? f : fieldValue(f))).filter((x): x is string => !!x) : [];
  const summary = buildCustomerSummaryFromCommercial(b.commercial);
  const stages = splitContractIntoStages(b.commercial.subtotalCents, i.schedule);
  return {
    schemaVersion: 1,
    company: { brandName: p.brandName, legalName: p.legalName, registrationNumber: p.registrationNumber, vatNumber: p.vatNumber, addressLines: p.addressLines, phone: p.phone, email: p.email, website: p.website },
    quote: { reference: i.quoteRef, revision: i.revision, issuedOn: i.issuedOn, validUntil: addDays(i.issuedOn, p.validityDays), validityDays: p.validityDays, siteName: b.quote.siteName },
    customer: { name, tradingName: fieldValue(s.tradingName), vatNumber: fieldValue(s.vatNumber), billingAddress: address, contactName: s.chosenContact.name, contactEmail: s.chosenContact.email, contactPhone: s.chosenContact.phone },
    currency: "ZAR",
    sections: summary.sections,
    totals: { subtotalExVat: summary.subtotalExVat, vatRatePercent: b.commercial.taxRateBps / 100, vat: summary.vat, totalIncVat: summary.totalIncVat },
    paymentSchedule: stages.map((st, n) => ({ name: st.name, description: i.schedule[n]?.description ?? "", percent: (i.schedule[n]?.bps ?? 0) / 100, amountExVat: round2(st.valueCents / 100) })),
    paymentTerms: p.paymentTerms, deliveryInstallationConditions: p.deliveryInstallationConditions, termsAndConditions: p.termsAndConditions, acceptanceInstructions: p.acceptanceInstructions,
  };
}

/** Words that mean internal commercial data; the system-generated parts of a customer document must never contain them. (Manager-authored terms are checked for identifiers, not wording.) */
const INTERNAL_WORDS = /\b(margins?|mark-?ups?|gross profit|gp%?|landed cost|cost price|supplier|suppliers|procurement|exchange rate|rate of exchange|estimator|latest cost|purchase price|sku)\b/i;

/** Everything that identifies INTERNAL data in the baseline: SKUs, supplier names, internal people, free-text notes and reasons. */
export function internalTokens(b: AcceptedBaseline): string[] {
  const t = new Set<string>();
  for (const l of b.commercial.lines) { if (l.sku) t.add(l.sku); for (const c of l.components ?? []) if (c.sku) t.add(c.sku); }
  for (const x of b.selectedProducts) if (x.sku) t.add(x.sku);
  for (const x of b.physicalScope ?? []) if (x.sku) t.add(x.sku);
  const est = b.physicalCostEstimate as unknown as { entries?: Record<string, { supplierName?: string | null; supplierId?: string | null }> } | undefined;
  for (const e of Object.values(est?.entries ?? {})) { if (e?.supplierName) t.add(e.supplierName); if (e?.supplierId) t.add(e.supplierId); }
  for (const e of [b.approvals.handoffBy, b.approvals.estimatorSignoffBy, b.approvals.managerApprovedBy, b.approvals.customerConfirmedBy]) if (e) t.add(e);
  if (b.assumptions && b.assumptions.trim().length >= 4) t.add(b.assumptions.trim());
  for (const x of b.exclusions) if (x.reason && x.reason.trim().length >= 4) t.add(x.reason.trim());
  for (const x of b.overrides) if (x.reason && x.reason.trim().length >= 4) t.add(x.reason.trim());
  for (const x of b.priceResolutions) if (x.reason && x.reason.trim().length >= 4) t.add(x.reason.trim());
  const m = b.internalMargin as unknown as { totals?: Record<string, unknown> } | undefined;
  for (const v of Object.values(m?.totals ?? {})) if (typeof v === "number" && Math.abs(v) >= 1000) t.add(String(v));
  return [...t].filter((x) => x.length >= 3);
}

/** Throws if the model carries anything internal. Called at issue time AND by the test suite. */
export function assertNoInternalLeak(model: CustomerDocumentModel, b: AcceptedBaseline): void {
  const text = JSON.stringify(model);
  for (const tok of internalTokens(b)) if (text.toLowerCase().includes(tok.toLowerCase())) throw new Error("The customer document would expose internal data and was not issued.");
  const generated = JSON.stringify({ sections: model.sections, paymentSchedule: model.paymentSchedule.map((x) => x.name), customer: model.customer.name });
  if (INTERNAL_WORDS.test(generated)) throw new Error("The customer document would expose internal data and was not issued.");
}
