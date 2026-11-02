import { describe, expect, it } from "vitest";
import { CUSTOMER_DOCUMENT_FORBIDDEN_FIELDS, buildCustomerInvoiceSummary, reconcileCustomerInvoice, type CustomerInvoiceInput } from "../customer-invoice";

const base = (over: Partial<CustomerInvoiceInput> = {}): CustomerInvoiceInput => ({
  companyName: "NewQuip", customerName: "Cust (Pty) Ltd", projectReference: "PRJ-1", projectName: "Site A", customerReference: "PO-77", invoiceNumber: "INV-1", invoiceDate: "2026-10-28",
  scope: { kind: "BASE" }, charges: [{ stageName: "Deposit", amountCents: 4_000_000, taxCents: 600_000 }], contractValueCents: 10_000_000, previouslyInvoicedCents: 0, ...over,
});

describe("customer-facing invoice summary", () => {
  it("deposit: one commercial line, ex VAT / VAT / total, contract position - and no physical or internal data", () => {
    const s = buildCustomerInvoiceSummary(base());
    expect(s).toMatchObject({ title: "Contract - Deposit", subtotalCents: 4_000_000, vatCents: 600_000, totalCents: 4_600_000 });
    expect(s.lines).toEqual([{ description: "Contract: Deposit", amountCents: 4_000_000 }]);
    expect(s.position).toEqual({ contractValueCents: 10_000_000, invoicedToDateCents: 4_000_000, remainingCents: 6_000_000 });
    expect(s.header).toMatchObject({ invoiceNumber: "INV-1", reference: "PO-77" });
    const json = JSON.stringify(s).toLowerCase();
    for (const f of CUSTOMER_DOCUMENT_FORBIDDEN_FIELDS) expect(json).not.toContain(f.toLowerCase());
  });
  it("delivery and installation claims, and a multi-stage claim, add up exactly", () => {
    const delivery = buildCustomerInvoiceSummary(base({ charges: [{ stageName: "Delivery", amountCents: 5_500_000, taxCents: 825_000 }], previouslyInvoicedCents: 4_000_000 }));
    expect(delivery).toMatchObject({ totalCents: 6_325_000, position: { invoicedToDateCents: 9_500_000, remainingCents: 500_000 } });
    const install = buildCustomerInvoiceSummary(base({ charges: [{ stageName: "Installation", amountCents: 500_000, taxCents: 75_000 }], previouslyInvoicedCents: 9_500_000 }));
    expect(install.position.remainingCents).toBe(0);
    const two = buildCustomerInvoiceSummary(base({ charges: [{ stageName: "Deposit", amountCents: 1_000_001, taxCents: 150_000 }, { stageName: "Manufacturing", amountCents: 2_700_000, taxCents: 405_000 }] }));
    expect(two.title).toBe("Contract - progress claim");
    expect(two.subtotalCents).toBe(3_700_001); expect(two.vatCents).toBe(555_000); expect(two.totalCents).toBe(4_255_001);
  });
  it("variation invoices are labelled by variation and use the variation's own contract", () => {
    const v = buildCustomerInvoiceSummary(base({ scope: { kind: "VARIATION", variationCode: "V001", variationTitle: "  Additional   ventilation " }, charges: [{ stageName: "Variation", amountCents: 500_000, taxCents: 75_000 }], contractValueCents: 500_000 }));
    expect(v.title).toBe("Variation V001 - Additional ventilation - Variation");
    expect(v.position).toEqual({ contractValueCents: 500_000, invoicedToDateCents: 500_000, remainingCents: 0 });
  });
  it("reconciles exactly with the Cin7 invoice and reports any cent of difference", () => {
    const s = buildCustomerInvoiceSummary(base());
    expect(reconcileCustomerInvoice(s, { subtotalCents: 4_000_000, taxCents: 600_000, totalCents: 4_600_000 })).toEqual({ ok: true, differences: [] });
    const bad = reconcileCustomerInvoice(s, { subtotalCents: 4_000_000, taxCents: 600_001, totalCents: 4_600_001 });
    expect(bad.ok).toBe(false); expect(bad.differences).toHaveLength(2); expect(bad.differences.join()).toMatch(/VAT: customer document 6000.00 vs Cin7 6000.01/);
  });
});
