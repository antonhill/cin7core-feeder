// Customer-facing quotation document MODEL (pure; no I/O). This is the ONLY thing the PDF renders, and it is built from an explicit allowlist: the sealed baseline's
// customer-safe commercial figures, the customer snapshot and the controlled company profile. Cost, margin, supplier, procurement, exchange-rate, estimator-note and
// approval-history data are never copied into it - and assertNoInternalLeak() re-checks the finished model against the baseline before anything is issued.
import { buildCustomerSummaryFromCommercial } from "@/newquip/grower/customer-summary";
import type { AcceptedBaseline } from "@/newquip/quote/baseline";
import { splitContractIntoStages } from "@/newquip/quote/to-project";
import type { ScheduleStageTemplate } from "@/newquip/quote/billing-schedule";
import type { ScheduleSource } from "@/newquip/quote/project-template";
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
  paymentSchedule: { name: string; description: string; trigger: string; percent: number; amountExVat: number }[];
  /** Where the schedule came from (standard / template version / custom), kept so project creation can record the same provenance. Not printed. */
  scheduleSource: ScheduleSource | null;
  paymentTerms: string;
  deliveryInstallationConditions: string;
  termsAndConditions: string;
  acceptanceInstructions: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const addDays = (isoDate: string, days: number): string => { const d = new Date(`${isoDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

export interface ModelInput {
  baseline: AcceptedBaseline; quoteRef: string; revision: number; snapshot: CustomerSnapshot; profile: CompanyProfile; schedule: readonly ScheduleStageTemplate[]; scheduleSource?: ScheduleSource; issuedOn: string; /** YYYY-MM-DD */
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
    paymentSchedule: stages.map((st, n) => ({ name: st.name, description: i.schedule[n]?.description ?? "", trigger: i.schedule[n]?.trigger ?? "", percent: (i.schedule[n]?.bps ?? 0) / 100, amountExVat: round2(st.valueCents / 100) })),
    scheduleSource: i.scheduleSource ?? null,
    paymentTerms: p.paymentTerms, deliveryInstallationConditions: p.deliveryInstallationConditions, termsAndConditions: p.termsAndConditions, acceptanceInstructions: p.acceptanceInstructions,
  };
}

/** Words that mean internal commercial data; the system-generated parts of a customer document must never contain them. (Manager-authored terms are checked for identifiers, not wording.) */
const INTERNAL_WORDS = /\b(margins?|mark-?ups?|gross profit|gp%?|landed cost|cost price|supplier|suppliers|procurement|exchange rate|rate of exchange|estimator|latest cost|purchase price|sku)\b/i;

/**
 * What identifies INTERNAL data in the sealed baseline, by kind:
 *   ids     - SKUs, supplier names and ids (they must not appear in anything the customer reads);
 *   figures - internal COST and gross-profit amounts, as rand numbers (selling prices are customer-facing and are NOT here);
 *   people  - internal staff identities (handoff / estimator / manager);
 *   notes   - free-text internal notes and reasons (assumptions, exclusion / override / price-resolution reasons).
 * The customer's OWN contact (who confirmed the amount) is not internal and is not here.
 */
export interface InternalTokenSet { ids: string[]; figures: string[]; people: string[]; notes: string[] }

const randOf = (cents: unknown): string | null => (typeof cents === "number" && Number.isFinite(cents) && Math.abs(cents) >= 1000 ? String(Math.round(cents) / 100) : null);

export function internalTokenSet(b: AcceptedBaseline): InternalTokenSet {
  const ids = new Set<string>(); const figures = new Set<string>(); const people = new Set<string>(); const notes = new Set<string>();
  for (const l of b.commercial.lines) { if (l.sku) ids.add(l.sku); for (const c of l.components ?? []) if (c.sku) ids.add(c.sku); }
  for (const x of b.selectedProducts) if (x.sku) ids.add(x.sku);
  for (const x of b.physicalScope ?? []) if (x.sku) ids.add(x.sku);
  const est = b.physicalCostEstimate as unknown as { totalCostCents?: number; lines?: Array<{ unitCostCents?: number | null; totalCostCents?: number | null }>; entries?: Record<string, { supplierName?: string | null; supplierId?: string | null }> } | undefined;
  for (const e of Object.values(est?.entries ?? {})) { if (e?.supplierName) ids.add(e.supplierName); if (e?.supplierId) ids.add(e.supplierId); }
  for (const c of [est?.totalCostCents, ...(est?.lines ?? []).flatMap((l) => [l.unitCostCents, l.totalCostCents])]) { const r = randOf(c); if (r) figures.add(r); }
  for (const e of [b.approvals.handoffBy, b.approvals.estimatorSignoffBy, b.approvals.managerApprovedBy]) if (e) people.add(e); // not customerConfirmedBy: that is the CUSTOMER's own contact
  if (b.assumptions && b.assumptions.trim().length >= 4) notes.add(b.assumptions.trim());
  for (const x of [...b.exclusions, ...b.overrides, ...b.priceResolutions]) if (x.reason && x.reason.trim().length >= 4) notes.add(x.reason.trim());
  // The frozen internal margin sheet: COST and GROSS PROFIT amounts only (project, section, line and component level). Selling values are the customer's own prices.
  const m = b.internalMargin as unknown as { project?: Record<string, unknown>; sections?: Array<Record<string, unknown>>; lines?: Array<Record<string, unknown> & { components?: Array<Record<string, unknown>> }> } | undefined;
  const fig = (o: Record<string, unknown> | undefined) => { for (const k of ["costCents", "gpCents"]) { const r = randOf(o?.[k]); if (r) figures.add(r); } };
  fig(m?.project); for (const x of m?.sections ?? []) fig(x); for (const l of m?.lines ?? []) { fig(l); for (const c of l.components ?? []) fig(c); }
  return { ids: [...ids].filter((x) => x.length >= 3), figures: [...figures], people: [...people].filter((x) => x.length >= 3), notes: [...notes] };
}

/** Flat list (all kinds). Kept for callers that only need "is there anything internal to look for". */
export const internalTokens = (b: AcceptedBaseline): string[] => { const t = internalTokenSet(b); return [...t.ids, ...t.figures, ...t.people, ...t.notes].filter((x) => x.length >= 3); };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole-word / whole-number match, case-insensitive: "test" is not found in "latest" or "testing", and 4000000 is not found in 40000000 or 4000000.5. */
export function tokenAppears(text: string, token: string): boolean {
  const t = token.trim(); if (!t) return false;
  const re = /^-?\d+(\.\d+)?$/.test(t) ? new RegExp(`(?<![\\d.,])${esc(t)}(?![\\d]|\\.\\d)`) : new RegExp(`(?<![\\p{L}\\p{N}_])${esc(t)}(?![\\p{L}\\p{N}_])`, "iu");
  return re.test(text);
}

/** A free-text note this long is distinctive enough to be looked for in organisation-configured text as well (shorter ones only in the text built from the baseline). */
const DISTINCTIVE_NOTE = 12;

/** Which kinds of internal data appear in `text`, for the regions that matter. Returns the KINDS only, never the values. */
function leakKinds(text: string, set: InternalTokenSet, region: "baseline" | "org" | "message"): string[] {
  const hit = (list: string[]) => list.some((t) => tokenAppears(text, t));
  const kinds: string[] = [];
  if (hit(set.ids)) kinds.push("a SKU or supplier");
  if (hit(set.figures)) kinds.push("an internal cost or margin figure");
  if (region !== "org" && hit(set.people)) kinds.push("an internal person");
  if (hit(set.notes.filter((n) => region === "baseline" || n.length >= (region === "message" ? 8 : DISTINCTIVE_NOTE)))) kinds.push("an internal note");
  return kinds;
}

/**
 * Throws if the model carries anything internal. Called at issue time AND by the test suite. The customer's OWN details (name, address, contact, site name) come from the
 * customer snapshot / the Rep and are never scanned: a customer or contact that happens to share a name or address with internal data is not a leak. Everything derived from
 * the baseline (scope, section titles, totals, schedule) is scanned for every kind; organisation-configured text (company details, terms, schedule wording) is scanned for
 * SKUs / suppliers / cost figures and for distinctive notes. The error names the KIND of data and the area - never the value.
 */
export function assertNoInternalLeak(model: CustomerDocumentModel, b: AcceptedBaseline): void {
  const set = internalTokenSet(b);
  const baselineText = JSON.stringify({ reference: model.quote.reference, sections: model.sections, totals: model.totals, schedule: model.paymentSchedule.map((x) => ({ percent: x.percent, amountExVat: x.amountExVat })) });
  const orgText = JSON.stringify({ company: model.company, paymentTerms: model.paymentTerms, delivery: model.deliveryInstallationConditions, terms: model.termsAndConditions, acceptance: model.acceptanceInstructions, schedule: model.paymentSchedule.map((x) => [x.name, x.description, x.trigger]) });
  const found: string[] = [];
  for (const k of leakKinds(baselineText, set, "baseline")) found.push(`${k} in the scope or totals`);
  for (const k of leakKinds(orgText, set, "org")) found.push(`${k} in the company details or terms`);
  const generated = JSON.stringify({ sections: model.sections, paymentSchedule: model.paymentSchedule.map((x) => x.name) });
  if (INTERNAL_WORDS.test(generated)) found.push("an internal term (margin, cost, supplier, SKU...) in the scope or schedule wording");
  if (found.length) throw new Error(`The customer document would expose internal data and was not issued. (${found.join("; ")})`);
}

/** The same test for free text a Rep writes in the cover email: internal tokens (whole words only) and internal terms. */
export function messageLeaksInternal(message: string, b: AcceptedBaseline): boolean {
  return /\b(margins?|mark-?ups?|gross profit|cost price|landed cost|supplier price)\b/i.test(message) || leakKinds(message, internalTokenSet(b), "message").length > 0;
}
