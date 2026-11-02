# Customer-facing invoice presentation (Phase F)

**Decision (NewQuip, confirmed):** customers do not receive long invoices listing every physical component. The Cin7 transaction keeps the R0 physical
lines (Cin7 is authoritative for stock, fulfilment and invoicing) plus the milestone charges; the customer document shows only the commercial picture.

## What is built (Toolbox side, pure, tested)
`src/lib/projects/customer-invoice.ts`
- `buildCustomerInvoiceSummary` - header (company, customer, project, customer PO/contract reference, invoice number/date), a title and one line per
  milestone charge ("Contract: Deposit", "Variation V001 - ...: Variation"), ex VAT, VAT, total, and the contract position (invoiced to date / remaining).
  Derived from the SAME approved claim and posting figures that were sent to Cin7 - never a second calculation. It accepts no SKU, quantity, cost or margin
  input, so none can leak (asserted by tests).
- `reconcileCustomerInvoice` - proves the customer document equals the Cin7 invoice to the cent (ex VAT, VAT, gross); any difference is reported.
- Tests cover deposit, delivery, installation, a multi-stage claim and a variation.
- It generates **no** document and adds **no** invoice engine. It is the single source of truth for whatever presents the invoice.

## Cin7 template capability - what could and could not be established (2026-10-28)
Public Cin7 Core help (Settings > Document and Email Templates; "Edit fields and tables in document templates"; "Sale MailMerge fields") describes templates as
**Word mail-merge documents** whose line tables are *child tables* delimited by `TableStart:<Name>` / `TableEnd:<Name>` (for example invoice lines), with
Additional Charges available as their own child table. I found **no documented conditional / filter / hide-row option** (for example "hide a row when Price = 0"),
and I could not open the help articles from this environment (HTTP 403) nor Cin7's template editor. So: **row-level suppression of zero-priced lines is NOT confirmed.**

## Smallest viable approach (no new engine)
Because every physical line on a NewQuip progress invoice is **R0** and all commercial value is carried by Additional Charges, the product-lines table adds no
monetary information. A dedicated **"NewQuip Progress Invoice" template that simply omits the invoice-lines child table** (keeping the header, the
Additional-Charges child table and the invoice totals) shows exactly the commercial picture and loses no value:
- the Cin7 invoice, its lines, fulfilment and stock records are untouched (only the printed/PDF *document* differs);
- subtotal, VAT and total come from the invoice's own totals, so they match Cin7 by construction;
- it needs only a Word template edit and assigning that template to the NewQuip Sale Invoice document type, no Toolbox code.

Owner check (about 15 minutes in Cin7, nothing to deploy):
1. In **Document and Email Templates**, open the *Sale Invoice* template, download the Word file and review its field list for the **Additional Charges child table that applies to the INVOICE** (the public page names `OrderAdditionalCharges` / `QuoteAdditionalCharges`; confirm the invoice equivalent exists). *If it does not exist on the invoice, the charges cannot be printed from the invoice template - report that and the fallback below applies.*
2. Save a copy named "NewQuip Progress Invoice" with the invoice-lines table removed and the charges table kept; upload and assign it.
3. Print/PDF these existing test documents and confirm the checklist below: INV-00027 (deposit, R10,000 ex VAT), INV-00028 (progress claim, R27,000), INV-00029 (variation, R5,000). Do **not** alter these invoices; printing is read-only.

Acceptance checklist for the printed document: no product/SKU/quantity/zero-price rows; one line per milestone charge with its description; ex VAT, VAT and total equal the Cin7 invoice (and equal `reconcileCustomerInvoice` of the Toolbox summary); invoice number/date, customer, project/PO reference present.

## Fallback only if the template cannot do this (documented limitation)
If the invoice template cannot print the charges without the lines table, report that. Only then consider a small Toolbox-rendered customer PDF built from
`buildCustomerInvoiceSummary`, refusing to render unless `reconcileCustomerInvoice` matches the live Cin7 invoice. It is deliberately **not built**: it would be a second
document engine, which the instruction reserves for a proven limitation.

## Template field map (for configuring option 1)
| Show | Source |
|---|---|
| NewQuip / project details | Sale: Project reference in memo / ExternalID, customer, site |
| Invoice number and date | Invoice header |
| Commercial stage / claim description | Additional Charge description (one per stage) |
| Approved claim amount | Additional Charge amount (ex VAT) |
| VAT, total | Invoice tax and total |
| Contract / PO reference | Sale customer reference |
| **Hide** | every product line (all are R0), SKU, quantity, stock, cost |
