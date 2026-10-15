# Projects POC — Gate P0: Cin7 architecture finding

Status: **INCOMPLETE BY DESIGN — Cin7 invoice behaviour is NOT yet proven. No Cin7 write is authorised or implemented.**
Base: `origin/main` @ `866b4e8`. Branch `feature/newquip-projects-poc`.

## 1. What the repository PROVES today

| Fact | Evidence |
|---|---|
| A Cin7 Sale can be created in two non-idempotent steps (`POST /sale` then `POST /sale/quote`), by NAME references, with `ExternalID` as our reconciliation key; `TaxRule` is required on header and each line; Cin7 uses the `Tax` we send per line; `Total` is gross when tax-inclusive. | `src/cin7/sale-quote-write.ts` (confirmed live 2026-08-26, Spark Demo sandbox) |
| `AdditionalCharges[]` lines carry a free-text `Description` and **no SKU** (optional revenue `Account`). | `buildQuoteBody` |
| Ambiguous-create recovery by exact `ExternalID` match, claims that never age-reclaim when ambiguous. | `findSaleByExternalId`, `src/lib/quote-submit.ts`, CCT-ADR-0002/0007 |
| Sales read-side already models `Invoices[]` (plural), `CreditNotes[]`, `Fulfilments[]` as separate nested arrays of one Sale. | `src/cin7/sales.ts` (`Cin7SaleInvoice[]`), `docs/cin7-api-findings.md` §13f |
| Multi-invoice fulfilment links are already handled by the warehouse queue work. | migration `0097` |

## 2. What is NOT proven (and must not be assumed)

The repo contains **no Cin7 invoice-create contract**: no `POST /sale/invoice` wrapper, no probe, no recorded response. Public documentation could not be retrieved in a machine-readable form in this session (Apiary portal is JS-rendered; third-party mirrors list only Get/List/fulfilment actions). Therefore these P0 questions are **OPEN**:

1. Does `POST /sale/invoice` accept a **DRAFT** status, and what is the exact required body (`SaleID`, `Status`, `Lines[]`, `AdditionalCharges[]`, `InvoiceDate`, `BillingAddress` …)?
2. May a Sale carry **several** invoices when each is raised without matching fulfilment (Cin7 normally ties an invoice to the fulfilment/ship stage, and an Advanced Sale's invoice lines are normally constrained to ordered lines/quantities)?
3. Can an invoice use **free-text `AdditionalCharges`** (no SKU, no stock draw-down) as its only lines, i.e. "Manufacturing — progress claim to 65%"? Or must lines be Service SKUs?
4. Does the invoice total have to be ≤ the Sale's order total, and does Cin7 reject an invoice that exceeds un-invoiced order lines?
5. How does Cin7's Xero integration push *several* invoices off one Sale (reference/number uniqueness, `ExternalID` mapping)?
6. **Jobs**: no public API for Cin7 Jobs/milestones was found (a community request for Job Costing CRUD notes the absence). Treat as **no usable contract → Jobs is not a dependency** (as the brief instructs).

## 3. Recommendation (conditional)

**OPTION A — Toolbox Project → one Cin7 Advanced Sale → stage-based progress invoices — is the preferred target, CONDITIONAL on probes 1–5 passing.**

- *Advantages:* keeps Cin7 as system of record for the customer document and Xero flow; Toolbox owns baseline/stages/completion/claims (matches Source-of-Truth boundaries — Toolbox-local commercial state, Cin7 for transactions); fits the existing create/reconcile machinery (ExternalID, claims table pattern).
- *Limitations:* depends on Cin7 accepting free-text/charge-only invoices against a sale; the sale's own lines may need to represent the contract as **one service/charge line per stage** (value = stage value) so each progress invoice is a partial invoice of a stage line rather than a physical-quantity invoice.
- *Inventory:* physical stock lines should **not** live on the progress-billing Sale (or fulfilment would drive invoicing). Operational stock moves stay on separate Cin7 transactions; the Toolbox allocation table links them to stages for visibility only.
- *Xero:* unknown until probe 5; each Cin7 invoice would flow as its own Xero invoice. Claim number must be unique and carried in the invoice reference.
- *Reconciliation:* store claim↔`(cin7_sale_id, cin7_invoice_id, invoice_number)`; verify customer, reference, lines, subtotal, tax, total, status by re-reading the invoice; `RECONCILED` only with stored evidence.

**OPTION B (Cin7 Job + Sale): rejected for the POC** — no public Jobs API contract.
**OPTION C (fallback if probe 3 fails):** one Sale per claim (each claim = its own small Sale + invoice, linked by `ExternalID` = `PROJECT-REF/CLAIM-NO`). Always provable with the existing create contract, but fragments the project across many Cin7 sales and weakens "one anchor per project".

## 4. Required probe plan (needs Anton's approval; READ-ONLY first)

1. **Read-only**: `GET /sale?ID=` on existing sales in the NewQuip **trial** org with multiple `Invoices[]` — capture the live invoice shape, statuses and line model (no write).
2. Only after the P4 write-design report is approved: one create probe in the **NewQuip TRIAL org only**, against a throwaway customer, to answer questions 1–4. Record request/response in `docs/cin7-api-findings.md`. Classify the call in `docs/cin7-post-classification.json` as `nonIdempotentCreate` (a repository test fails the build otherwise).
3. Xero behaviour (question 5) can only be observed via a connected Xero org; if the trial org has none, document it as unverified.

## 5. STOP conditions

Do not build `POST /sale/invoice` code until probes 1–4 pass. If question 3 fails, fall back to Option C or re-scope; do not improvise undocumented endpoints.
