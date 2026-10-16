# Projects POC — Gate P0: Cin7 architecture finding

Status: **V1 = PASS (read-only architecture discovery). Option A is PROVISIONALLY VIABLE; the Cin7 invoice WRITE contract is still UNVERIFIED. P5 is NOT AUTHORISED. No Cin7 write has ever been made and none is implemented.**
Updated after owner decisions (read-only probe approved and completed; Xero unassumed; migration 0101 reserved).
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

The repo contains **no Cin7 invoice-create contract**: no `POST /sale/invoice` wrapper, no probe, no recorded response. Public documentation could not be retrieved in a machine-readable form in this session (Apiary portal is JS-rendered; third-party mirrors list only Get/List/fulfilment actions). The V1 read-only probe (§9) OBSERVED what existing invoices look like, but a GET response cannot prove a create contract. These questions therefore remain **OPEN / UNVERIFIED** and are the P5 questions:

1. Does `POST /sale/invoice` exist, what is its exact request body, and does it accept a **DRAFT / non-authorised** status (`SaleID`, `Status`, `Lines[]`, `AdditionalCharges[]`, `InvoiceDate`, `BillingAddress` …)?
2. Can the **API** create a **second** invoice on an existing Sale? (V1 OBSERVED that Cin7 *holds* several invoices on one Sale — but that example was created by hand in the Cin7 UI, not through the API.)
3. Can an invoice be created with **free-text `AdditionalCharges`** (no SKU, no stock draw-down) as its lines, i.e. "Manufacturing — progress claim to 65%"? Or must lines be Service SKUs? (V1 OBSERVED an existing invoice whose whole value sits in an `AdditionalCharges` entry; whether the API will WRITE one is unproven.)
4. Does the invoice total have to be ≤ the Sale's order total, and does Cin7 reject an invoice that exceeds un-invoiced order lines? (Not constrained in the data seen, which is not proof of the rule.)
5. Is there a **writable and searchable idempotency/reference field** on an invoice? (V1 saw none populated: see §9.)
6. How does Cin7's Xero integration push *several* invoices off one Sale (reference/number uniqueness, `ExternalID` mapping)? **Xero behaviour is UNVERIFIED / DEFERRED.**
7. **Jobs**: no public API for Cin7 Jobs/milestones was found (a community request for Job Costing CRUD notes the absence). Treat as **no usable contract → Jobs is not a dependency** (as the brief instructs).

## 3. Recommendation

**OPTION A — Toolbox Project → one Cin7 Advanced Sale → multiple stage-based progress invoices — is PROVISIONALLY VIABLE after V1, and remains CONDITIONAL on the P5 write proof (§2 questions 1–5).**

- *Why provisionally viable (OBSERVED, §9):* Cin7 can hold several invoices on one Sale; invoices can exist before packing and without a fulfilment link; invoiced quantity can exceed packed quantity (so invoicing is not forced to follow physical fulfilment); invoice value can be carried through `AdditionalCharges`; invoices expose `TaskID` and `InvoiceNumber`.
- *Advantages:* keeps Cin7 as system of record for the customer document and Xero flow; Toolbox owns baseline/stages/completion/claims (matches Source-of-Truth boundaries — Toolbox-local commercial state, Cin7 for transactions); fits the existing create/reconcile machinery (ExternalID, claims table pattern).
- *Limitations:* depends on Cin7's API accepting a second, free-text/charge-only invoice against a sale; the sale's own lines may need to represent the contract as **one service/charge line per stage** (value = stage value) so each progress invoice is a partial invoice of a stage line rather than a physical-quantity invoice. The only multi-invoice sale seen was fulfilment-linked (see §9), so "several invoices on one sale with no fulfilment at all" has not been observed.
- *Inventory:* physical stock lines should **not** live on the progress-billing Sale (or fulfilment would drive invoicing). Operational stock moves stay on separate Cin7 transactions; the Toolbox allocation table links them to stages for visibility only.
- *Xero:* unknown; each Cin7 invoice would flow as its own Xero invoice. Claim number must be unique and carried in the invoice reference.
- *Reconciliation:* store claim↔`(cin7_sale_id, cin7_invoice_id, invoice_number)`; verify customer, reference, lines, subtotal, tax, total, status by re-reading the invoice; `RECONCILED` only with stored evidence. V1 shows the invoice id field is **`TaskID`** (no `InvoiceID` key) — P5 must record which field the create response returns.

**OPTION B (Cin7 Job + Sale): rejected for the POC** — no public Jobs API contract.
**OPTION C (retained fallback):** one Sale per claim (each claim = its own small Sale + invoice, linked by `ExternalID` = `PROJECT-REF/CLAIM-NO`). Always provable with the existing create contract, but fragments the project across many Cin7 sales and weakens "one anchor per project". Use it if the P5 proof shows the API cannot create a second invoice on an existing Sale, or cannot create a charge-only invoice.

## 4. Probe plan

1. **Read-only — DONE (V1, §9).** Existing sales in the NewQuip trial org inspected via GET only; live invoice shape, statuses and line model captured. No write.
2. **P5 — NOT AUTHORISED.** Only after the P4 write-design report is approved AND Anton separately and explicitly approves: one create probe in the **NewQuip TRIAL org only**, against a throwaway customer, to answer §2 questions 1–5. Record request/response in `docs/cin7-api-findings.md`. Classify the call in `docs/cin7-post-classification.json` as `nonIdempotentCreate` (a repository test fails the build otherwise).
3. Xero behaviour (question 6) can only be observed via a connected Xero org; if the trial org has none, document it as unverified.

## 5. STOP conditions

Do not build `POST /sale/invoice` code until P5 has proven questions 1–4. If the API cannot create a second invoice on an existing Sale, or cannot create a charge-only invoice, fall back to Option C or re-scope; do not improvise undocumented endpoints.

> Evidence legend: **PROVEN** = confirmed on a real Cin7 account and recorded here; **OBSERVED** = seen in a real read-only GET response; **UNVERIFIED** = anything else. §1 items are PROVEN; §9 items are OBSERVED (NewQuip trial org, read-only); §2 items are UNVERIFIED. OBSERVED is never upgraded to PROVEN.

## 6. Read-only probe — status

**DONE (see §9).** The probe that actually ran was a temporary, Preview-only server-side route (GET-only against Cin7, SELECT-only against the Toolbox database, super-admin + MFA gated behind Vercel SSO, hard-coded to the NewQuip POC trial organisation). It ran from the owner's browser so that no Toolbox production credential was copied to a workstation, and it was deleted afterwards together with its branch (`ops/newquip-v1-probe`, never merged). `scripts/probe-sale-invoices-readonly.mjs` remains in this branch as a prepared, **unused** alternative; it was not what produced the V1 evidence.

## 7. Xero connection finding

**XERO BEHAVIOUR = UNVERIFIED / DEFERRED.** The Toolbox stores no Xero connection metadata (`grep` of `src/` and migrations finds Xero mentioned only in comments about Cin7's own Xero/QuickBooks sync). Whether NewQuip's Cin7 account has Xero connected cannot be proven from Toolbox data, and no Xero read, write or configuration change was made. This does not block the POC.

## 8. Gate V3 evidence (migration chain, not Cin7)
Full-chain replay of migrations 0001→0101 (102 files, no duplicate numbers) in PGlite on generic Supabase-platform stubs only (`auth`, roles, `storage`): all applied in order; 77 tables, all with RLS enabled (matches `scripts/migration-audit.mjs`); 0101 needs no app-table stubs. 24/26 repo SQL tests pass on that chain; the 2 failures (0058/0059, lock-expiry timing) fail identically **without** 0101. This was the local replay; the repository's normal mechanism (`supabase start` + `db reset`) later ran in CI with 26/26 SQL tests passing (V3 PASS, with an owner waiver for the pre-existing dependency-audit failure only).

## 9. Gate V1 — read-only invoice probe: PASS (architecture discovery)

**Result: V1 = PASS.** Run on the **NewQuip POC trial organisation** (subscription `trialing`), 2026-10-16, in three passes (the early-stop rules were relaxed twice by owner decision because the first two stopped on weak triggers). Every Cin7 request was a GET; every database access was a SELECT. **No Cin7 write of any kind was made. P5 is NOT AUTHORISED.**

### What was OBSERVED (NewQuip trial, read-only)
- **One Sale can contain multiple invoices.** 1 of 6 invoiced sales carried 2 AUTHORISED invoices (two halves of a 20,000 ex-VAT order, 10,000 + 10,000 plus 15% VAT, one line each).
- **Invoices can exist before packing.** 3 of 6 invoiced sales had invoiced quantity with nothing packed (e.g. ordered 2005 / packed 0 / invoiced 2005; pick still DRAFT).
- **Invoiced quantity can exceed packed quantity** (3 sales), and an **invoice can exist without any fulfilment** (a direct invoice on a sale with no order and no fulfilment).
- **Invoice value can be carried through `AdditionalCharges`:** one invoice's entire value (100 ex VAT + 15 VAT) is a single `AdditionalCharges` entry (keys: `Account, Comment, Description, Discount, Price, Quantity, Tax, TaxRule, Total`); two other invoices carry a single zero-value charge.
- **Invoice identifiers:** the id field is **`TaskID`** (no `InvoiceID` key); **`InvoiceNumber`** is present; `Memo` exists as a key but was empty on all 7 invoices; no `ExternalID` on any inspected sale; sale-level `CustomerReference` is present on 4 of 6. No invoice-level searchable/unique reference was seen.
- Invoice keys seen: `AdditionalCharges, BillingAddressLine1, BillingAddressLine2, CurrencyConversionRate, InvoiceDate, InvoiceDueDate, InvoiceNumber, Lines, LinkedFulfillmentNumber, Memo, Paid, Payments, Status, TaskID, Tax, Total, TotalBeforeTax`. All 7 invoices were `AUTHORISED` (no DRAFT or VOIDED seen).

### Fixture provenance (important)
**The multi-invoice Sale was created manually in the Cin7 UI by Anton as a trial fixture.** It was NOT created through the Toolbox or the Cin7 API (its invoices are dated the day of the probe, and the account's sale count rose from 12 to 13 between passes). Therefore:
- **OBSERVED:** Cin7 Core supports multiple invoices on one Sale.
- **UNVERIFIED:** the **API** can create a second invoice on an existing Sale.

### Per invoiced sale (6 of 13 sales; all invoiced sales in the account were inspected)
| Sale status | Invoices (all AUTHORISED) | Pick / pack / ship | Ordered / packed / invoiced qty |
|---|---|---|---|
| INVOICED | 1 | picked, packed, shipped | 400 / 400 / 400 |
| BACKORDERED | 1 | pick DRAFT, not packed | 2005 / 0 / 2005 |
| ORDERED | 1 (value in an `AdditionalCharges` entry) | pick DRAFT, not packed | 210 / 0 / 210 |
| PACKED | 1 | picked, packed, not shipped | 38 / 38 / 38 |
| INVOICED (no order) | 1 | no fulfilment | 0 / 0 / 5 |
| ORDERED | **2** (manual UI fixture) | picked, packed, shipped | 100 / 100 / 100 |

Fulfilment links: only the two invoices of the multi-invoice sale carry `LinkedFulfillmentNumber`; no other invoice is linked in either direction. For that sale the fulfilment's `LinkedInvoiceNumber` is present but equals neither invoice number exactly (masked output; not further resolved). Two "invoice total above order total" flags are artefacts of comparing a tax-inclusive invoice total with an ex-tax order total (15% VAT).

### Caveats that keep Option A *provisional*
- The only multi-invoice example is **fulfilment-linked** and was **created by hand**; "several invoices on one sale with no fulfilment at all" was not observed on one sale (the before-packing / unlinked invoices are on single-invoice sales).
- Small trial account (13 sales). A GET response cannot prove any create contract.

### Already recorded in this repository — a DIFFERENT account (LBL), historical, NOT NewQuip
Classification: **OBSERVED on the LBL account, as recorded in repo comments** — not re-verified, not NewQuip, never to be upgraded to PROVEN.
- `Invoices[]` is an array; a Sale "can be invoiced more than once over its life (e.g. partial shipments)" (`src/cin7/sales.ts`).
- Invoice `Status` values AUTHORISED, DRAFT, PAID seen live 2026-08-15; no VOIDED example seen (`src/cin7/sales.ts`).
- Invoices and fulfilments carry a two-way cross-reference — `Fulfilments[].LinkedInvoiceNumber` ↔ invoice `LinkedFulfillmentNumber` — confirmed live 2026-08-18; LBL's own flow is **one invoice per fulfilment** on multi-fulfilment sales (`supabase/migrations/0081_fulfilment_grain_invoicing.sql`).
- PROVEN from the documented API spec: credit-note lines reuse `SaleInvoiceLineModel` (`docs/cin7-api-findings.md` §13f).

The earlier hypothesis that Cin7 invoicing is fulfilment-coupled (which would have put Option A at risk) is **not borne out on NewQuip**: invoices exist before packing and with no fulfilment.

### Decision rules (set BEFORE seeing data) and outcome
| NewQuip observation | Recommendation |
|---|---|
| ≥1 sale with >1 invoice **and** ≥1 invoice not linked to a fulfilment / invoiced before any pack | **OPTION A — PROVISIONALLY VIABLE** (still needs the P5 create proof) |
| >1 invoice per sale exist but every invoice is linked to a fulfilment and none precedes packing | OPTION C — fallback more likely |
| no sale with >1 invoice in the sample | INSUFFICIENT EVIDENCE |

Outcome: a multi-invoice sale exists, and unlinked / before-packing invoices exist → **OPTION A — PROVISIONALLY VIABLE**, with the caveats above. **Option C is retained as the fallback.**

### Still UNVERIFIED (the P5 questions)
| Item | Status |
|---|---|
| `POST /sale/invoice` endpoint | **UNVERIFIED** |
| Exact request body | **UNVERIFIED** |
| API creation of a second invoice on an existing Sale | **UNVERIFIED** (UI-created fixture only) |
| Draft / non-authorised invoice status on create | **UNVERIFIED** (only AUTHORISED invoices were seen) |
| Writable and searchable idempotency / reference field | **UNVERIFIED** (`Memo` empty everywhere; `TaskID` is system-assigned) |
| Writable free-text `AdditionalCharges` on an invoice | **UNVERIFIED** (existing charge lines observed only) |
| Invoice-total constraints vs the Sale | **UNVERIFIED** |
| Xero behaviour | **UNVERIFIED / DEFERRED** |

**P5: NOT AUTHORISED. LIVE CIN7 WRITES: NONE.**
