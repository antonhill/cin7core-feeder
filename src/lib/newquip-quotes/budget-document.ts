// BUDGET QUOTATION document model (customer UAT feedback). PURE; no I/O. An early, PROVISIONAL, Rep-prepared document built from the SAVED DRAFT. It is deliberately a different document from the
// final customer quotation: it is titled BUDGET QUOTATION, carries the provisional-pricing disclaimer, shows what is and is not priced, and NEVER presents a partial subtotal as the quotation total.
//
// It is built only from the cost-withheld evaluation of the draft (selling prices, labels, quantities, entered charges). No SKU, cost, margin, supplier, rate or internal note can reach it, and
// buildBudgetDocumentModel() fails closed if any unpriced line would otherwise be hidden. It records nothing, approves nothing and creates no issued document, acceptance, Project or Cin7 record.
import type { BudgetQuote } from "@/newquip/grower/quote-bridge";
import { incompleteEstimateOf, type UnpricedLine } from "@/newquip/grower/incomplete-estimate";
import { INSTALL_COMMISSION_TITLE } from "@/newquip/grower/customer-summary";
import type { CompanyProfile } from "./company-profile";

/** The exact wording the customer reads on the PDF and in the email (customer UAT feedback, section 4). Fixed text: never edited by a Rep. */
export const BUDGET_DISCLAIMER = "BUDGET QUOTATION – INDICATIVE PRICING ONLY. Subject to final equipment confirmation, supplier costing, Estimator review and management approval. This is not a final commercial quotation.";
export const BUDGET_TITLE = "BUDGET QUOTATION";
export const BUDGET_UNPRICED_WORDING = "Price to be confirmed";

export interface BudgetEquipmentLine { label: string; quantity: number | null; status: "priced" | "unpriced"; unitPriceExVat: number | null; amountExVat: number | null; note: string }
export interface BudgetChargeLine { label: string; status: "priced" | "unpriced"; amountExVat: number | null; note: string }

export interface BudgetDocumentModel {
  schemaVersion: 1;
  kind: "BUDGET_QUOTATION";
  /** UAT / restricted environment: watermarked, never a commercial document. */
  testOnly: boolean;
  title: typeof BUDGET_TITLE;
  disclaimer: string;
  company: Pick<CompanyProfile, "brandName" | "legalName" | "registrationNumber" | "vatNumber" | "addressLines" | "phone" | "email" | "website">;
  quote: { reference: string; revision: number; preparedOn: string; siteName: string; /** First characters of the saved-draft hash: ties the PDF to the exact saved draft it was built from. */ draftRef: string };
  customer: { name: string; contactName: string | null; contactEmail: string | null };
  /** Plain facts of the configuration the equipment lines were built from. */
  configuration: { label: string; value: string }[];
  currency: "ZAR";
  equipment: BudgetEquipmentLine[];
  charges: BudgetChargeLine[];
  /** False while ANY selected equipment or required charge has no confirmed price. */
  complete: boolean;
  unpriced: { count: number; items: string[] };
  totals: {
    /** The sum of what IS priced (equipment + entered charges), ex VAT. While `complete` is false this is NOT the quotation total and is labelled so. */
    knownSubtotalExVat: number;
    vatRatePercent: number;
    /** Only while complete: VAT on the subtotal and the total including VAT. Null otherwise: no total is presented for an incomplete budget. */
    vatExVatBasis: number | null;
    totalIncVat: number | null;
  };
  vatNote: string;
  assumptions: string[];
  outstanding: string[];
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface BudgetInput {
  budget: BudgetQuote;
  quoteRef: string; revision: number; draftHash: string; preparedOn: string;
  siteName: string; customerName: string; contact: { name: string; email: string } | null;
  profile: Pick<CompanyProfile, "brandName" | "legalName" | "registrationNumber" | "vatNumber" | "addressLines" | "phone" | "email" | "website">;
  config: { rooms?: number; lengthM?: number; widthM?: number; pigsPerRoom?: number; totalPens?: number };
  testOnly: boolean;
}

const fixed2 = (n: number) => n.toFixed(2);

export function buildBudgetDocumentModel(i: BudgetInput): BudgetDocumentModel {
  const b = i.budget;
  const equipment: BudgetEquipmentLine[] = b.lines.filter((l) => l.status !== "not_selected").map((l) => {
    const priced = l.status === "priced" && l.revenueExTax != null;
    return { label: l.label, quantity: l.quantity, status: priced ? "priced" : "unpriced", unitPriceExVat: priced ? l.unitPrice : null, amountExVat: priced ? round2(l.revenueExTax as number) : null, note: priced ? "" : BUDGET_UNPRICED_WORDING };
  });

  const amountOf = (key: string): number | null => { const c = b.charges.find((x) => x.key === key); return c && c.amountExTax != null ? c.amountExTax : null; };
  const delivery = amountOf("delivery"), install = amountOf("installation"), commissioning = amountOf("commissioning"), slat = amountOf("concrete_slat_delivery");
  const slatApplies = b.charges.some((c) => c.key === "concrete_slat_delivery");
  const charges: BudgetChargeLine[] = [];
  charges.push(delivery == null ? { label: "Delivery", status: "unpriced", amountExVat: null, note: BUDGET_UNPRICED_WORDING } : { label: "Delivery", status: "priced", amountExVat: round2(delivery), note: "" });
  // Installation and Commissioning are ONE customer line, calculated ONCE from the two entered amounts: the combined figure is the only place either is counted.
  if (install == null && commissioning == null) charges.push({ label: INSTALL_COMMISSION_TITLE, status: "unpriced", amountExVat: null, note: BUDGET_UNPRICED_WORDING });
  else if (install == null) charges.push({ label: INSTALL_COMMISSION_TITLE, status: "unpriced", amountExVat: null, note: `${BUDGET_UNPRICED_WORDING} (installation amount not yet entered)` });
  else charges.push({ label: commissioning != null && commissioning > 0 ? INSTALL_COMMISSION_TITLE : "Installation", status: "priced", amountExVat: round2(install + (commissioning ?? 0)), note: "" });
  if (slatApplies) charges.push(slat == null ? { label: "Concrete slat delivery", status: "unpriced", amountExVat: null, note: BUDGET_UNPRICED_WORDING } : { label: "Concrete slat delivery", status: "priced", amountExVat: round2(slat), note: "" });

  const estimate = incompleteEstimateOf(b);
  const unpricedLines: UnpricedLine[] = estimate?.lines ?? [];
  const unpricedCharges = charges.filter((c) => c.status === "unpriced");
  const unpricedItems = [...unpricedLines.map((l) => `${l.label}${l.quantity != null ? ` × ${l.quantity}` : ""}`), ...unpricedCharges.map((c) => c.label)];
  const complete = unpricedItems.length === 0 && b.state === "complete";
  // Incomplete for another reason (e.g. a required explanation is missing on a priced line): never a total, and the document says pricing is still under review rather than "0 items".
  if (!complete && unpricedItems.length === 0) unpricedItems.push("Pricing still under review");

  const known = round2(equipment.reduce((a, l) => a + (l.amountExVat ?? 0), 0) + charges.reduce((a, c) => a + (c.amountExVat ?? 0), 0));
  // The model's figure must equal the engine's own subtotal for the same priced items: the document never invents or re-derives a different total (a mismatch means the budget was not built from this draft).
  if (complete && Math.abs(known - round2(b.totals.subtotalExTax)) > 0.01) throw new Error("The budget quotation figures do not match the calculated quotation; it was not produced.");
  const ratePct = b.totals.taxTotal > 0 && b.totals.subtotalExTax > 0 ? round2((b.totals.taxTotal / b.totals.subtotalExTax) * 100) : 15;
  const vat = complete ? round2(known * (ratePct / 100)) : null;

  const outstanding = [
    ...(unpricedItems.length > 0 ? [`${unpricedItems.length} item${unpricedItems.length === 1 ? "" : "s"} still need a confirmed price: ${unpricedItems.join("; ")}.`] : []),
    "Equipment selection and quantities are to be confirmed against the final scope.",
    "Supplier pricing is to be verified before a final quotation is issued.",
  ];
  const cfg: { label: string; value: string }[] = [];
  if (i.config.rooms) cfg.push({ label: "Rooms", value: String(i.config.rooms) });
  if (i.config.lengthM && i.config.widthM) cfg.push({ label: "Room size", value: `${i.config.lengthM} m × ${i.config.widthM} m` });
  if (i.config.pigsPerRoom) cfg.push({ label: "Pigs per room", value: String(i.config.pigsPerRoom) });
  if (i.config.totalPens) cfg.push({ label: "Pens per room", value: String(i.config.totalPens) });

  return {
    schemaVersion: 1, kind: "BUDGET_QUOTATION", testOnly: i.testOnly, title: BUDGET_TITLE, disclaimer: BUDGET_DISCLAIMER,
    company: { brandName: i.profile.brandName, legalName: i.profile.legalName, registrationNumber: i.profile.registrationNumber, vatNumber: i.profile.vatNumber, addressLines: i.profile.addressLines, phone: i.profile.phone, email: i.profile.email, website: i.profile.website },
    quote: { reference: i.quoteRef, revision: i.revision, preparedOn: i.preparedOn, siteName: i.siteName, draftRef: i.draftHash.slice(0, 12) },
    customer: { name: i.customerName, contactName: i.contact?.name ?? null, contactEmail: i.contact?.email ?? null },
    configuration: cfg, currency: "ZAR", equipment, charges, complete,
    unpriced: { count: unpricedItems.length, items: unpricedItems },
    totals: { knownSubtotalExVat: known, vatRatePercent: ratePct, vatExVatBasis: vat, totalIncVat: vat == null ? null : round2(known + vat) },
    vatNote: complete
      ? `All amounts are in South African Rand and exclude VAT unless stated. VAT at ${fixed2(ratePct)}% is shown on the budget total.`
      : `All amounts are in South African Rand and exclude VAT. VAT at ${fixed2(ratePct)}% will be added once every item is priced. No total including VAT is shown because pricing is incomplete.`,
    assumptions: [
      "Prices are provisional and based on the equipment and quantities in the draft prepared by your representative.",
      "Delivery, installation and commissioning amounts are estimates, subject to site verification.",
      "Items marked “" + BUDGET_UNPRICED_WORDING + "” are not included in any figure on this document.",
      "This document does not reserve stock, fix a price or commit either party to a contract.",
    ],
    outstanding,
  };
}

/** True when a document model carries any figure that could be read as a complete quotation total while pricing is incomplete. Used by tests and as a final guard. */
export function presentsPartialAsTotal(m: BudgetDocumentModel): boolean { return !m.complete && (m.totals.totalIncVat != null || m.totals.vatExVatBasis != null); }
