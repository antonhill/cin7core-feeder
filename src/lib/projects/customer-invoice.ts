// Projects - the CUSTOMER-FACING view of a progress invoice (pure, generic). The Cin7 invoice keeps everything (R0 physical SKU lines + the
// commercial milestone charges) because Cin7 is the system of record for fulfilment and stock. The customer should only see the commercial
// picture: who/what/when, the milestone being billed, the ex-VAT amount, VAT and total. This module derives that from the SAME approved claim and
// posting figures that went to Cin7, never from a second calculation, and proves the two reconcile to the cent. It generates no document and
// changes nothing: it is the single source of truth for whatever template (Cin7's, or a PDF) presents the invoice.
//
// Nothing here can leak internal data: it takes no cost, margin, SKU or quantity input at all.

export interface CustomerInvoiceInput {
  companyName: string;
  customerName: string;
  projectReference: string;
  projectName: string;
  /** Customer purchase-order / contract reference, when known. */
  customerReference?: string | null;
  invoiceNumber: string | null;
  invoiceDate: string;
  /** The billing scope: the original contract or a named variation. */
  scope: { kind: "BASE" | "VARIATION"; variationCode?: string | null; variationTitle?: string | null };
  /** One line per milestone charge on the approved claim, ex VAT. */
  charges: Array<{ stageName: string; amountCents: number; taxCents: number }>;
  contractValueCents: number;
  previouslyInvoicedCents: number;
}

export interface CustomerInvoiceLine { description: string; amountCents: number }
export interface CustomerInvoiceSummary {
  header: { company: string; customer: string; project: string; reference: string | null; invoiceNumber: string | null; invoiceDate: string };
  title: string;
  lines: CustomerInvoiceLine[];
  subtotalCents: number; vatCents: number; totalCents: number;
  /** Contract position after this invoice: informational for the customer. */
  position: { contractValueCents: number; invoicedToDateCents: number; remainingCents: number };
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

export function buildCustomerInvoiceSummary(i: CustomerInvoiceInput): CustomerInvoiceSummary {
  const scopeLabel = i.scope.kind === "VARIATION" ? `Variation ${i.scope.variationCode ?? ""}${i.scope.variationTitle ? ` - ${clean(i.scope.variationTitle)}` : ""}`.trim() : "Contract";
  const lines = i.charges.map((c) => ({ description: `${scopeLabel}: ${clean(c.stageName)}`, amountCents: c.amountCents }));
  const subtotalCents = i.charges.reduce((n, c) => n + c.amountCents, 0);
  const vatCents = i.charges.reduce((n, c) => n + c.taxCents, 0);
  const invoicedToDateCents = i.previouslyInvoicedCents + subtotalCents;
  return {
    header: { company: i.companyName, customer: i.customerName, project: `${i.projectReference} - ${i.projectName}`, reference: i.customerReference?.trim() || null, invoiceNumber: i.invoiceNumber, invoiceDate: i.invoiceDate },
    title: i.charges.length === 1 ? `${scopeLabel} - ${clean(i.charges[0].stageName)}` : `${scopeLabel} - progress claim`,
    lines, subtotalCents, vatCents, totalCents: subtotalCents + vatCents,
    position: { contractValueCents: i.contractValueCents, invoicedToDateCents, remainingCents: Math.max(0, i.contractValueCents - invoicedToDateCents) },
  };
}

export interface Cin7InvoiceTotals { subtotalCents: number; taxCents: number; totalCents: number }
export interface Reconciliation { ok: boolean; differences: string[] }

/** The customer document must equal the Cin7 invoice exactly (ex VAT, VAT and gross). Any difference is reported; nothing is "close enough". */
export function reconcileCustomerInvoice(summary: CustomerInvoiceSummary, cin7: Cin7InvoiceTotals): Reconciliation {
  const d: string[] = [];
  const chk = (label: string, a: number, b: number) => { if (a !== b) d.push(`${label}: customer document ${(a / 100).toFixed(2)} vs Cin7 ${(b / 100).toFixed(2)}`); };
  chk("Ex VAT", summary.subtotalCents, cin7.subtotalCents);
  chk("VAT", summary.vatCents, cin7.taxCents);
  chk("Total", summary.totalCents, cin7.totalCents);
  return { ok: d.length === 0, differences: d };
}

/** Fields that must never appear on a customer document. Used by tests and reviews of any template. */
export const CUSTOMER_DOCUMENT_FORBIDDEN_FIELDS = ["sku", "productCode", "quantity", "unitCost", "averageCost", "margin", "cogs", "stock", "zeroPriceLine"] as const;
