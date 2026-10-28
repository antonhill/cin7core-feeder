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

## What is NOT done, and why (needs an owner check in Cin7)
Whether Cin7 Core's document-template editor can **suppress zero-priced product lines** on the printed/PDF *Sale Invoice* (and still print Additional Charges)
is **unverified**: I found no Cin7 documentation for it and cannot open Cin7's template editor from this environment. Please check Settings > Document and
Email templates > Sale Invoice (the template editor and its conditional/loop options) for the NewQuip POC instance:
1. **If a line filter exists** (e.g. print only lines with Price > 0 / hide lines flagged ...): create a "NewQuip Progress Invoice" template that hides R0 lines and prints the Additional Charges block plus the header fields above. No code needed.
2. **If it cannot filter lines**: the documented limitation that justifies a Toolbox-generated customer PDF from `buildCustomerInvoiceSummary` (a small server route that renders the summary and refuses to render unless `reconcileCustomerInvoice` is ok against the live Cin7 invoice). Not built until you confirm the limitation, as instructed ("no separate engine unless a documented limitation").
3. Either way the internal Cin7 invoice, its lines and fulfilment data stay untouched and available for operational and audit reporting.

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
