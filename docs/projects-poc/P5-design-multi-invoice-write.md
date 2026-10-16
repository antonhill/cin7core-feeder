# Projects POC — P5 design: creating a second progress invoice on an existing Sale

**Status: DESIGN ONLY. P5 is NOT AUTHORISED. LIVE CIN7 WRITES: NONE. HOSTED MIGRATIONS: NONE. NOT MERGED.**
**P5 readiness: NOT READY** (see §14). Nothing here is code; no endpoint was called to produce it.

Legend as in P4: **PROVEN** = confirmed against a real Cin7 account and recorded in this repo; **OBSERVED** = seen in a real GET response (V1 probe); **UNVERIFIED** = anything else. A third-party listing or my own recollection of an API shape is UNVERIFIED, never OBSERVED.

## 0. Research limits (read first)
- Repo: no invoice-create code or contract exists. `docs/cin7-api-findings.md` only records the invoice READ model (`SaleInvoiceLineModel`, `Status` values `DRAFT/AUTHORISED/VOIDED/NOT AVAILABLE`). The repo has no Cin7 DELETE call site.
- Official docs: the Cin7 Core developer portal (`dearinventory.docs.apiary.io`) is JavaScript-rendered; fetches returned only the page title (one 502), the help-centre endpoint list returned 403. **I could not read the official `POST /sale/invoice` request model.** Nothing below is taken from it.
- The only external evidence for the endpoint is a third-party integration listing ("Create Sale Invoice via Cin7 Core API (POST /sale/invoice)", "Update Sale Invoice … (PUT /sale/invoice)", workato.com/integrations/cin7~workato_webhooks). That is **secondary, UNVERIFIED**.
- Owner-supplied V1 JSON (GET responses) is the only first-party evidence, and it describes the READ shape, not the write shape.

## 1. Endpoint
| | Class |
|---|---|
| `POST /sale/invoice` creates a sale invoice | **UNVERIFIED** (third-party listing only; no repo or first-party evidence) |
| `PUT /sale/invoice` updates one | **UNVERIFIED** (same) |
| Any DELETE/void endpoint for sale invoices | **UNVERIFIED / not known to exist** |

## 2. Request body (candidate; every field UNVERIFIED unless stated)
Observed READ keys on an invoice (OBSERVED, V1): `AdditionalCharges, BillingAddressLine1/2, CurrencyConversionRate, InvoiceDate, InvoiceDueDate, InvoiceNumber, Lines, LinkedFulfillmentNumber, Memo, Paid, Payments, Status, TaskID, Tax, Total, TotalBeforeTax`. A write model is not guaranteed to match the read model.

```jsonc
POST /sale/invoice                       // UNVERIFIED
{
  "TaskID": "<sale id>",                 // UNVERIFIED NAME: parent-sale reference. The earlier P4 draft said "SaleID"; the V1 read model has "TaskID".
                                         //   The Cin7 purchase-invoice model documents TaskID as the parent task id, so by analogy this is the sale id — NOT confirmed.
  "Status": "DRAFT",                     // UNVERIFIED allowed on create; AUTHORISED may be the only/forced value
  "InvoiceDate": "<YYYY-MM-DD>",         // UNVERIFIED required-ness
  "InvoiceDueDate": "<YYYY-MM-DD>",      // UNVERIFIED
  "Memo": "NEWQUIP-PROJECTS-POC-P5-<claim-id>", // UNVERIFIED writable and echoed back (empty on every observed invoice)
  "Lines": [],                           // UNVERIFIED whether an empty array is accepted for a charge-only invoice
  "AdditionalCharges": [                 // free-text lines: shape OBSERVED on READ; write-acceptance UNVERIFIED
    { "Description": "NEWQUIP PROJECTS POC — API MULTI-INVOICE TEST",
      "Quantity": 1, "Price": "<ex-VAT amount>", "Discount": 0,
      "Tax": "<VAT amount>", "TaxRule": "<resolved rule name>",
      "Total": "<line total>", "Account": "<revenue account code>" }
  ]
}
```
Field-by-field requirement status: **REQUIRED = none proven.** Every field above is UNVERIFIED for required/optional. Unknown and unresolved: `InvoiceNumber` (caller-supplied vs assigned), `LinkedFulfillmentNumber` (whether it is mandatory for a sale with fulfilment, optional otherwise), `CustomerReference`/`ExternalID` (not on the invoice read model at all — OBSERVED absent), currency (`CurrencyConversionRate`), billing address (copied from sale or required).

## 3. Second-invoice semantics (the central P5 proof) — UNVERIFIED
- OBSERVED: a Sale carried 2 invoices, but that fixture was made by hand in the Cin7 UI and both invoices carry a `LinkedFulfillmentNumber`. It proves the data model, not the API. It is also the only multi-invoice sale seen, and it is fulfilment-linked.
- UNVERIFIED: that the API creates a second invoice on an existing Sale; that it does so without a second fulfilment; that it does not require `Lines` matching ordered/fulfilled quantities; that an AdditionalCharge-only invoice is accepted; that the Sale total caps total invoiced.
- Real risk to name: Cin7 may tie invoice lines to fulfilled quantity or reject a charge that is not on the order. If so, Option A fails and **Option C** (one Sale per claim, proven create contract) is used.
- Must remain unchanged after a write (compare before/after): sale order quantities and order total; fulfilment count and status; pick, pack and ship quantities per line; stock on hand/available for any product on the Sale; sale `CombinedInvoiceStatus`/`FulFilmentStatus` only as an expected, recorded change; COGS (invoice-line `AverageCost`) where observable.

## 4. Invoice status — UNVERIFIED
| Question | Answer |
|---|---|
| Can an invoice be created as DRAFT? | UNVERIFIED (the read enum includes DRAFT; the quote create did accept `Status:"DRAFT"` — PROVEN for `/sale/quote` only) |
| Is authorisation separate? | UNVERIFIED (UI has a separate authorise step; API unknown) |
| Does a draft sync to Xero? | UNVERIFIED (commonly Xero sync happens on authorisation — not confirmed, and it depends on whether the org is connected) |
| Does a draft affect fulfilment/stock? | UNVERIFIED |
| Can a draft be deleted/voided? | UNVERIFIED |
If DRAFT is refused and AUTHORISED is forced, P5 becomes a stronger accounting action and needs fresh owner approval.

## 5. Commercial line model
| | A. AdditionalCharges | B. Service SKU line |
|---|---|---|
| Read shape | OBSERVED: one NewQuip invoice carried its entire value in one charge (100 ex VAT + 15 VAT); keys Account, Comment, Description, Discount, Price, Quantity, Tax, TaxRule, Total | not observed |
| Write support | UNVERIFIED on invoices (PROVEN only on `/sale/quote`) | UNVERIFIED |
| Free text | Description/Comment keys exist; writability UNVERIFIED | name comes from the product |
| SKU needed | no | yes — a Service product must exist; **do not create one** |
| Tax/account | per-charge `Tax`, `TaxRule`, `Account` present (OBSERVED); Cin7 uses supplied Tax on quotes (PROVEN, quotes) | from product defaults, UNVERIFIED |
| Xero | maps to an invoice line; account code matters | same |

**PREFERRED: AdditionalCharges — provisionally, on read evidence only.** If the write is refused, fall back to a Service SKU (owner-created) or to Option C. Choice is reversible; none of it is proven.

## 6. First P5 fixture (proposal — requires owner action)
I have no read access now (the probe is deleted and no further probing is authorised), so **I cannot name a real Sale ID.** Required fixture, to be created or chosen by Anton in the **NewQuip POC trial org only**:
- a **disposable Sale** with a throwaway customer, not the observed multi-invoice Sale (`594e10ba…`; it is fulfilment-linked and is the evidence base — do not mutate it);
- order status AUTHORISED, **no fulfilment, 0 invoices**, one simple order line or charge, order value ~R1,000.00 ex VAT;
- to record before the write: Sale ID, Sale number, status, invoice count (expect 0), fulfilment state (expect none), order value, ordered/packed/shipped qty, stock on hand for any product.
Reason for disposable: rollback is unproven (§10), so the Sale itself must be abandonable.
**Provisional test amount: R100.00 ex VAT (+R15.00 VAT at 15% = R115.00 inc)** — unmistakable, well under the ~R1,000 capacity, and it matches the 100 + 15 charge already OBSERVED. It is only provisional: whether invoices are capped by order value is UNVERIFIED, so the amount is not final until the owner confirms the rules.
Description: `NEWQUIP PROJECTS POC — API MULTI-INVOICE TEST`.

## 7. Idempotency
- Wanted token: `NEWQUIP-PROJECTS-POC-P5-<stable-claim-id>`.
- **No durable searchable field is PROVEN.** Candidate: invoice `Memo` (exists on the read model, empty on every invoice seen; writable and echoed-back unknown). `ExternalID`/`CustomerReference` exist on the Sale, not the invoice. `InvoiceNumber` caller-supplied: UNVERIFIED. Cin7 has no proven server-side invoice search; the workable check is to GET the specific Sale and scan `Invoices[]` (no search needed).
- Per the standing rule, a write without a durable reconciliation key must not be authorised. **Honest position:** for ONE trial write on a disposable Sale that starts with 0 invoices, a state-delta key is enough: `Invoices[]` count 0 → 1 plus exact amount + date + description (and the token in `Memo` if it echoes). That is sufficient for the trial only. It is **not** an idempotency mechanism for production: Option A needs a proven token field (else use Option C, where Sale `ExternalID` is a proven key).
- The local DB already enforces one claim ↔ one idempotency key ↔ one Cin7 link (migration 0101); order of operations as in P4 §6.

## 8. Ambiguous timeout (POST sent, outcome unknown)
Never retry blindly. Persist `CIN7_PENDING` before the call (P4 §6). On timeout/5xx/connection reset:
1. Do not retry. Mark `FAILED_UNCERTAIN` (value stays reserved).
2. `GET /sale?ID=<sale>`; scan `Invoices[]` for the token (Memo), expected amount, date, description.
3. Exactly one match → `CIN7_CREATED` (store `InvoiceNumber`, invoice id), then reconcile → `RECONCILED`.
4. Zero matches → **not automatically safe**: read again after a settling delay and again with the owner present; only then record `FAILED_CONFIRMED_NO_WRITE` with evidence (never age-based, per P4 §7); a retry is a new, separately-approved action. Read-after-write consistency is UNVERIFIED.
5. More than one match → **fail closed**; stop; owner resolves in Cin7. No automated action.
6. Definite 4xx validation response → `FAILED_CONFIRMED_NO_WRITE` after one confirming GET that shows the invoice count unchanged.

## 9. Reconciliation (read back after create)
Sale ID; invoice `TaskID` and `InvoiceNumber` (**note:** `TaskID` may be the parent-sale id rather than a unique invoice id — check the V1 JSON before relying on it; if so the invoice is identified by `InvoiceNumber`); status; `TotalBeforeTax`, `Tax`, `Total`; `InvoiceDate`; the AdditionalCharge amount/description; `Memo` token; fulfilment status before/after; packed and shipped qty before/after; stock on hand before/after.
**Pass = exactly one matching invoice AND exact amounts (integer-cent comparison) AND fulfilment/stock/ordered state unchanged.** Any mismatch → leave `CIN7_CREATED`, flag, stop.

## 10. Rollback / correction — UNPROVEN
- Delete a draft: UNVERIFIED. Void an authorised invoice: UNVERIFIED (read enum has VOIDED). Credit note: exists in the data model, UNVERIFIED for this flow. Effect on Xero: UNVERIFIED. No sale-invoice DELETE is known.
- Therefore the **disposable Sale is mandatory**; rollback means abandoning/voiding the Sale in the Cin7 UI, by the owner, not by code.
- The safest correction if the write is wrong is to stop, record the evidence, and let the owner void/credit in the UI. Do not script corrections.

## 11. Xero — UNKNOWN
Whether the NewQuip trial org is connected to Xero cannot be read from Toolbox data (it stores none) and I did not query Cin7 or Xero. The owner can check read-only in the Cin7 UI (Integrations). If connected and a draft will not provably stay local, state the accounting risk before approval. Not connecting Xero, no settings changed.

## 12. Stock / fulfilment safety (expected, UNVERIFIED)
Expected: no Pick/Pack/Ship, no stock movement, no change to stock on hand, no COGS posting from a charge-only draft invoice. OBSERVED in the UI-made data: invoices can precede packing and invoiced qty can exceed packed qty. Not observed: API behaviour. **P5 succeeds only if the invoice is created without forcing physical fulfilment.**

## 13. Runbook (DO NOT RUN)
**PRECHECK** — correct org (NewQuip POC); Sale ID/number match the fixture; invoice count 0; no fulfilment; ordered/packed/shipped/stock snapshot saved; token absent from `Invoices[]`; owner's written go-ahead on the exact payload.
**WRITE** — `POST /sale/invoice` (UNVERIFIED), the §2 payload with placeholders filled, once, through the gateway with `nonIdempotentCreate:true`, classified in `docs/cin7-post-classification.json`.
**EXPECTED RESPONSE** — HTTP 200 with an invoice identifier and/or number, echoing status, totals; exact fields UNVERIFIED.
**READBACK** — immediately `GET /sale?ID=`; invoice appears exactly once.
**RECONCILE** — §9 checks.
**FAILURE** — timeout → §8; 4xx → record body, no retry, confirming GET; 5xx → treat as ambiguous; duplicate → fail closed; unexpected status (e.g. AUTHORISED when DRAFT asked) → stop, record, owner decides; fulfilment/stock mutated → stop, record, owner corrects in UI.
**CLEANUP** — only a mechanism verified beforehand (§10); otherwise abandon the disposable Sale.

## 14. Stop conditions and readiness
Stop if: the official request model cannot be obtained; DRAFT is not accepted; the token field is not writable and echoed (then state-delta is the only key — owner must explicitly accept that for the trial); Xero connection is unknown or the invoice would sync; rollback unproven AND no disposable Sale; a fulfilment is required or created; any value other than the expected one is reported back.

**NOT READY.** What would make it ready: (1) the owner pastes the official `Sale Invoice` POST model (or a screenshot) so the body is no longer a guess; (2) the owner confirms in the Cin7 UI whether the trial org is Xero-connected and whether a draft invoice can be deleted or voided; (3) the owner creates the disposable Sale and supplies the §6 snapshot; (4) the owner approves the final exact payload, amount and idempotency approach in writing.
