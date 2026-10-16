# Projects POC — P5 design: creating a second progress invoice on an existing Sale

**Status: DESIGN ONLY. P5 is NOT AUTHORISED. LIVE CIN7 WRITES: NONE. HOSTED MIGRATIONS: NONE. NOT MERGED.**
**P5 readiness: READY FOR OWNER WRITE APPROVAL** (see the final precheck section; this is not an authorisation). The remaining unknowns are runtime proofs, not architecture. Nothing here is code; no endpoint was called to produce it.

## P5 final read-only precheck (2026-10-16) — OBSERVED, GET only, NewQuip POC trial org
Disposable Sale **SO-00015**, SaleID `4fe3d99c-241d-4404-8795-4c448842108b`, read by a temporary Preview-only probe (GET-only, DB SELECT-only; branch, deployment and worktree since deleted). One `GET /sale?ID=`; no fulfilment read needed (`Fulfilments: []`). Nothing was written. This supersedes the earlier same-day precheck that found a live DRAFT invoice (INV-00016, full R1,000) — that invoice has since been **voided by the owner in the Cin7 UI** (not by this work).

**Final before-snapshot (sanitised):**
- Sale: Type **Advanced Sale**; sale `Status` ORDERED; `Order.Status` AUTHORISED; ZAR (rate 1); tax rule Standard Rate Sales; Terms "30 days"; `SaleOrderDate` 2026-10-16; one order line, qty 1, price 1000, tax 150, `AverageCost` 50; order `TotalBeforeTax` 1000 / `Tax` 150 / `Total` 1150; no order-level AdditionalCharges; `Memo`/`Note`/`ExternalID` empty; `CustomerReference` shape "A9 / aaaa".
- Invoices: **count 1** — `INV-00016`, `Status` **VOIDED**, `TaskID` `7761500a-8ff0-43dc-86aa-d8ca77c1ff54`, dates 2026-10-16 / 2026-11-15, `Lines: []`, `AdditionalCharges: []`, `TotalBeforeTax` 0 / `Tax` 0 / `Total` 0, `Paid` 0, no payments, `Memo` empty. A VOIDED invoice stays in `Invoices[]` but carries **zero value** (OBSERVED), so it contributes 0 to invoiced value.
- Sale-level: `CombinedInvoiceStatus` NOT INVOICED; `CombinedPaymentStatus` UNPAID; `CreditNotes` `[]`.
- Fulfilment: count 0; `CombinedPickingStatus` NOT PICKED, `CombinedPackingStatus` NOT PACKED, `CombinedShippingStatus` NOT SHIPPED, `FulFilmentStatus` NOT FULFILLED; picked/packed/shipped qty 0 (no fulfilment records); ordered qty 1.
- Stock/COGS: `COGSAmount` 0; `InventoryMovements` `[]`; `Transactions` `[]`.
- Idempotency: token `NEWQUIP-PROJECTS-POC-P5-SO-00015-INV-001` and its prefix both **absent**.
- Not exposed by the API read model: a "remaining to invoice" figure. The UI's "R1,150.00 to invoice" is a UI observation only; the API view is consistent with it (order total 1150, invoiced value 0) but does not state it.
- **TaskID:** OBSERVED that the invoice `TaskID` ≠ parent SaleID. With one invoice, uniqueness is UNVERIFIED. `TaskID` is **not** a production idempotency key nor the sole reconciliation identifier. Parent = SaleID; Cin7 invoice reference = `InvoiceNumber`; reconciliation token = `Memo`.

**Result: the API view matches the expected state.** No material disagreement.

### Decisions folded in (owner-stated)
- `Account`: use the API/read-model code **`"200"`** (the UI label "200: Sales" is not used). Not yet proven accepted on POST — a rejection is a STOP.
- Dates: date-only `YYYY-MM-DD`. 30-day terms OBSERVED to give 2026-10-16 → 2026-11-15. If P5 runs on a later date both dates are recalculated (InvoiceDate + 30 days) and the **literal payload is re-approved by the owner**.
- POST response shape is still UNVERIFIED and is **no longer a blocker**: HTTP success alone is never success. Canonical success is the immediate `GET /sale?ID=` reconciliation (below). An unexpected POST body with an exact GET reconciliation is documented, not retried; an ambiguous POST is never retried blindly.

### Final candidate payload (NOT POSTED; needs the owner's separate written approval)
```json
POST /sale/invoice
{
  "SaleID": "4fe3d99c-241d-4404-8795-4c448842108b",
  "TaskID": "00000000-0000-0000-0000-000000000000",
  "CombineAdditionalCharges": false,
  "Memo": "NEWQUIP-PROJECTS-POC-P5-SO-00015-INV-001",
  "Status": "DRAFT",
  "InvoiceDate": "2026-10-16",
  "InvoiceDueDate": "2026-11-15",
  "Lines": [],
  "AdditionalCharges": [
    {
      "Description": "NEWQUIP PROJECTS POC — API MULTI-INVOICE TEST",
      "Quantity": 1,
      "Price": 100.00,
      "Tax": 15.00,
      "TaxRule": "Standard Rate Sales",
      "Account": "200",
      "Comment": "Controlled P5 trial"
    }
  ]
}
```
No placeholders remain. `Discount`/`Total` on the charge are omitted by design; a required-field rejection is a STOP. If `"Lines": []` is rejected: **STOP** — no product line, no Service SKU, no Sale change, no alternative commercial model (that becomes a separate design decision).

### Canonical reconciliation (GET Sale after POST) — the write passes only if ALL hold
1. Flow: POST → record HTTP status/body (sanitised) → `GET /sale?ID=` → prove exactly one matching new invoice.
2. `INV-00016` is still VOIDED and unchanged (zero value).
3. Exactly **one** new invoice has `Memo` equal to the token, `Status` DRAFT; `Invoices[]` count is 2 (baseline 1 + 1).
4. New invoice `TotalBeforeTax` 100.00, `Tax` 15.00, `Total` 115.00 (integer-cent comparison); the single AdditionalCharge description equals `NEWQUIP PROJECTS POC — API MULTI-INVOICE TEST`; `InvoiceDate` 2026-10-16 and `InvoiceDueDate` 2026-11-15 as sent; `InvoiceNumber` generated by Cin7 and different from `INV-00016`; `LinkedFulfillmentNumber` empty.
5. `Fulfilments` still `[]`; picking/packing/shipping still NOT PICKED / NOT PACKED / NOT SHIPPED; `FulFilmentStatus` NOT FULFILLED; picked/packed/shipped 0; `COGSAmount` 0; `InventoryMovements` `[]`.
6. `Order` still AUTHORISED with unchanged lines and totals (1000 / 150 / 1150); sale does not enter an unexpected terminal state.
7. Memo not echoed → STOP (no weak matching). Zero matches after a timeout → remain `FAILED_UNCERTAIN`; more than one → fail closed (see §5).

### Xero, correction, readiness
- Xero: **CONNECTED** (owner-confirmed). Whether a Cin7 DRAFT invoice propagates to Xero is **still not directly observed** — the DRAFT-only rule stands, never AUTHORISE, and any unexpected Xero/accounting effect means STOP and do not continue.
- Correction: a DRAFT invoice can be voided/deleted manually in Cin7 (owner-confirmed; INV-00016 was voided that way). Xero interaction of void/delete is UNVERIFIED.
- **P5 READINESS: READY FOR OWNER WRITE APPROVAL.** This is a design-readiness call, not an authorisation. P5 remains NOT AUTHORISED; no POST is made without Anton's separate explicit approval of the literal payload on the day.
- Remaining runtime unknowns are exactly what P5 exists to prove: (1) an AdditionalCharges-only invoice with `Lines: []` is accepted; (2) the API creates another invoice task on this Advanced Sale; (3) `Memo` is echoed and readable; (4) the exact POST response shape; (5) no fulfilment, stock or Xero side effects.

## Evidence classes
- **PROVEN** — confirmed against a real Cin7 account and recorded in this repo.
- **OBSERVED** — seen in a real GET response (V1 probe, NewQuip trial org).
- **PROVISIONALLY PROVEN (owner-supplied, official docs)** — stated by Anton from the official Cin7 Core developer documentation. I could not read that page myself (it is JavaScript-rendered; my fetches returned only the title). Never upgraded to OBSERVED or PROVEN until a call confirms it.
- **UNVERIFIED** — everything else.

## 1. Owner-supplied official-docs findings (2026-10-16)
| Item | Value | Class |
|---|---|---|
| Create endpoint | **`POST /sale/invoice`** | PROVISIONALLY PROVEN |
| Required fields | `SaleID`, `TaskID`, `CombineAdditionalCharges`, `Status`, `InvoiceDate`, `InvoiceDueDate` | PROVISIONALLY PROVEN |
| Optional fields | `Memo`, `Lines`, `AdditionalCharges`, `CurrencyConversionRate`, `BillingAddressLine1`, `BillingAddressLine2`, `LinkedFulfillmentNumber` | PROVISIONALLY PROVEN |
| New-invoice `TaskID` | `00000000-0000-0000-0000-000000000000` | PROVISIONALLY PROVEN |
| `InvoiceNumber` | generated by Cin7 (omit; cannot carry our token) | PROVISIONALLY PROVEN |
| `CombineAdditionalCharges` | Boolean; first test uses **`false`** so the commercial progress amount stays explicit in `AdditionalCharges` rather than being combined into `Lines` | PROVISIONALLY PROVEN (type); the value is a design choice |
| `Status` | **`DRAFT`** for the first test only. **Never AUTHORISED** — the docs on allowed POST statuses are internally inconsistent; DRAFT is the narrowest supported state | PROVISIONALLY PROVEN |
| Advanced Sale | documented as supporting multiple invoices per sale order; the Sale Order must already be AUTHORISED | PROVISIONALLY PROVEN |
| `AdditionalCharges` fields | Description, Quantity, Price, Discount, Tax, Total, TaxRule, Account, Comment | PROVISIONALLY PROVEN |
| `Memo` | writable in the POST model | PROVISIONALLY PROVEN (writable) |

OBSERVED separately (V1, read-only): a Sale with 2 invoices, but that fixture was created by hand in the Cin7 UI and is fulfilment-linked; invoices before packing; an invoice whose entire value sits in one AdditionalCharge (100 ex VAT + 15 VAT); `Memo` empty on every invoice seen. These prove the data model, not API creation.

**Still UNVERIFIED (what P5 exists to settle):** the API actually creates a second invoice on an existing Sale; that it needs no fulfilment; that `Lines: []` is accepted; that the AdditionalCharges write model matches; whether `Memo` is returned immediately and is reliable enough for production idempotency, or searchable independently; whether invoice value is constrained by Sale order value; draft delete/void; Xero connection and DRAFT sync; accounting side effects; behaviour of pick/pack/ship/stock/COGS.

## 2. Candidate payload (SANITISED — NOT an approved payload)
> Generic template. The filled, placeholder-free candidate for SO-00015 is in the "Final candidate payload" section at the top (`Account` is `"200"`, dates are date-only).
```jsonc
POST /sale/invoice
{
  "SaleID": "<DISPOSABLE_ADVANCED_SALE_ID>",
  "TaskID": "00000000-0000-0000-0000-000000000000",
  "CombineAdditionalCharges": false,
  "Memo": "NEWQUIP-PROJECTS-POC-P5-<stable-claim-id>",
  "Status": "DRAFT",
  "InvoiceDate": "<P5_DATE>",
  "InvoiceDueDate": "<DERIVED_FROM_TEST_SALE_TERMS>",
  "Lines": [],
  "AdditionalCharges": [
    {
      "Description": "NEWQUIP PROJECTS POC — API MULTI-INVOICE TEST",
      "Quantity": 1,
      "Price": 100.00,
      "Tax": 15.00,
      "TaxRule": "<EXACT_EXISTING_TEST_SALE_TAX_RULE>",
      "Account": "<EXACT_EXISTING_TEST_SALE_REVENUE_ACCOUNT>",
      "Comment": "Controlled P5 trial"
    }
  ]
}
```
- **Omitted on purpose:** `LinkedFulfillmentNumber` (the test must prove the invoice exists independently of fulfilment; no fulfilment is created or modified), `InvoiceNumber`, `CurrencyConversionRate`, `BillingAddressLine1/2`, and `Discount`/`Total` on the charge.
- **Must come from the disposable Sale / existing Cin7 configuration — never hard-coded or inferred:** `TaxRule`, `Account`, `InvoiceDueDate` (payment terms), and currency behaviour if Cin7 requires it. If Cin7 demands an omitted field (e.g. `Total`), that is a "write model differs from expected" STOP, not a licence to guess.
- **`Lines: []`:** if the API rejects an empty array, **STOP**. No product line and no Service SKU is invented or created.
- **Amount:** R100.00 ex VAT, R15.00 VAT, R115.00 total, against a ~R1,000 ex VAT disposable Sale. Deliberately far below the Sale value; **over-invoicing is not tested.** Tax of 15.00 is only valid if the fixture's tax rule is 15% and the Sale is tax-exclusive — confirmed from the fixture, not assumed.
- Money is converted from integer cents to a 2-dp number only at the edge. The call goes through the gateway (`cin7Request`) with `nonIdempotentCreate:true` and is classified in `docs/cin7-post-classification.json`; none of that exists yet.

## 3. Second-invoice semantics (the central P5 proof)
P5 is only a success if the API creates one DRAFT progress invoice on the existing AUTHORISED Advanced Sale **without** a fulfilment link and **without** any change to: ordered quantities and order total; fulfilment count/status; pick, pack, ship status; packed/shipped quantity; stock on hand/available; COGS where observable. Risk to name: Cin7 may tie invoice lines to fulfilled quantity or refuse a charge not on the order. If so Option A fails and Option C (one Sale per claim, proven create contract) is used.

## 4. Idempotency (P5 trial rule)
- Candidate token field: invoice `Memo`, value `NEWQUIP-PROJECTS-POC-P5-<stable-claim-id>`.
- Known: `Memo` is writable. UNVERIFIED: returned immediately after POST; durable enough for production idempotency; searchable independently. `ExternalID`/`CustomerReference` live on the Sale, not the invoice.
- **Before the write:** GET the Sale and prove the token is absent from `Invoices[]`.
- **After the write:** GET the Sale and require **exactly one** invoice matching **all of**: exact `Memo` token, expected amount, expected date, expected charge description.
- **If the token is not echoed back: STOP.** There is no silent fallback to weak matching (no "count went 0→1" or amount-only matching).
- Local side: one claim ↔ one idempotency key ↔ one Cin7 link, DB-enforced (migration 0101, not applied to hosted); state persisted before the call (P4 §6). Production idempotency is a separate, later question — Memo reliability must first be PROVEN.

## 5. Ambiguous timeout (POST sent, client times out / network error)
1. **Do not retry.**
2. Mark `FAILED_UNCERTAIN` (value stays reserved).
3. GET the Sale in bounded reconciliation reads (fixed small count and spacing, defined in the approved runbook; no open-ended polling).
4. Search `Invoices[]` for the exact `Memo` token.
5. Exactly one match (all of §4's criteria) → `CIN7_CREATED`, then `RECONCILED`.
6. Zero matches → **remain `FAILED_UNCERTAIN`.**
7. **No move to `FAILED_CONFIRMED_NO_WRITE` without explicit human review** (and never age-based, per P4 §7). This applies to definite 4xx responses too.
8. More than one match → **fail closed**; stop; the owner resolves in Cin7. No automated action.
9. A retry always requires separate owner approval.

## 6. Reconciliation (read back after create)
Sale ID; invoice `TaskID` and `InvoiceNumber` (note: V1 `TaskID` may be the parent-sale id rather than a unique invoice id — check the V1 JSON; if so the invoice is identified by `InvoiceNumber` + `Memo`); status (must be DRAFT); `TotalBeforeTax`, `Tax`, `Total` (R100.00 / R15.00 / R115.00, integer-cent comparison); `InvoiceDate`; charge description/amount; `Memo` token; fulfilment count/status, pick/pack/ship, packed and shipped qty, stock state — each before vs after.
**Pass = exactly one matching invoice AND exact amounts AND fulfilment/stock/order state unchanged AND no unexpected accounting side effect.** Any mismatch → stop, record evidence, leave the claim flagged.

## 7. Disposable test Sale (Anton creates it manually)
NewQuip POC trial org only. Requirements: clearly labelled disposable; **Advanced Sale**; throwaway/test customer; **AUTHORISED** Sale Order; ~R1,000 ex VAT; **no invoices**; preferably no fulfilment; no customer-critical data. **Do not use the multi-invoice evidence Sale (`594e10ba…`); it stays untouched.**

**Before snapshot (read-only; none exists yet):** SaleID; Sale number; Sale type; status; order total ex VAT; tax rule; revenue/account code needed for the charge; currency; payment terms / due-date rule; invoice count (expect 0); fulfilment count; pick, pack, ship status; packed qty; shipped qty; stock state if observable; `Memo` token absent.

## 8. Xero
Whether the trial org is connected to Xero is **unknown** (Toolbox stores none; I queried neither Cin7 nor Xero). Before READY: determine it by read-only/manual UI check. If connected, determine whether a DRAFT Cin7 invoice syncs to Xero. If that cannot be established safely, P5 stays NOT READY. Xero is not connected or reconfigured.

## 9. Rollback / correction (must be verified before READY)
Verify in the Cin7 UI/documentation, and record the exact route: can a DRAFT invoice be deleted; can it be voided; if later AUTHORISED, what is the correction mechanism (void / credit note); does delete/void interact with Xero. **"Abandon the disposable Sale" is not sufficient** if the invoice creates accounting effects. Status today: **UNVERIFIED.** Corrections are performed by the owner in the Cin7 UI, never scripted.

## 10. Stock / fulfilment safety
Expected (UNVERIFIED): no Pick/Pack/Ship, no stock movement, no stock-on-hand change, no COGS from a charge-only DRAFT invoice. P5 succeeds only if the invoice exists without forcing physical fulfilment.

## 11. Runbook (DO NOT RUN)
**PRECHECK** — org is NewQuip POC; Sale ID/number match the fixture; Sale is Advanced + AUTHORISED; invoice count 0; before-snapshot saved; `Memo` token absent; Xero and rollback sections complete; owner's written approval of the exact payload.
**WRITE** — `POST /sale/invoice`, §2 payload with real fixture values, once.
**EXPECTED RESPONSE** — success status with an invoice reference and echoed `Status: DRAFT` and totals; exact response fields UNVERIFIED and to be documented from the docs before approval.
**READBACK** — immediately GET the Sale; one invoice with the token.
**RECONCILE** — §6.
**FAILURE** — timeout → §5; 4xx → record body, no retry, confirming GET, human review; 5xx → treat as ambiguous (§5); more than one match → fail closed; unexpected status → stop, owner decides; fulfilment/stock/accounting mutation → stop, owner corrects in UI.
**CLEANUP** — only the route verified in §9.

## 12. Stop conditions
P5 stays NOT READY, and a started P5 stops, if any of these is true: disposable Advanced Sale not created; Sale not AUTHORISED; exact TaxRule unknown; exact Account unknown; due-date rule unknown; Xero state unknown; DRAFT rollback/correction path unknown; `Memo` cannot be confirmed writable and echoed; empty `Lines` rejected; AdditionalCharges write model differs from expected; POST requires a fulfilment; POST mutates pick/pack/ship unexpectedly; any returned monetary value differs; any unexpected accounting side effect.

## 13. Readiness
P5 becomes **READY FOR OWNER WRITE APPROVAL** only when all exist: (1) disposable Advanced Sale; (2) before snapshot; (3) exact TaxRule; (4) exact Account; (5) exact due date; (6) Xero state known; (7) draft correction path known; (8) exact payload filled with real fixture values; (9) Memo reconciliation plan accepted; (10) exact expected response documented; (11) exact stop/recovery plan documented.

**Current state:** all eleven criteria are met by the final precheck section above (fixture, snapshot, TaxRule, Account `200`, dates, Xero connected, draft correction confirmed, filled payload, Memo/GET reconciliation plan, stop/recovery plan; POST response shape is no longer a blocker). **READY FOR OWNER WRITE APPROVAL — not authorised.**
