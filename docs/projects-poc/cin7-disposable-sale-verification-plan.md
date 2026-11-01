# Cin7 disposable-Sale verification plan (UAT-019/020, UAT-010 T7)

Status: PROPOSED. NOT AUTHORISED. No Sale, invoice, fulfilment or account is to be created in Cin7 until the owner gives a separate, explicit GO per step ("GO T1", ...).
Nothing in the Toolbox performs these steps automatically; every Cin7 write is made by the Toolbox's existing, flag-gated writer (T1, T3, T8) or by the owner in the Cin7 UI (T4-T6). Production writes stay OFF throughout.

## What each step must prove
Owner questions: (a) deposit invoice before fulfilment; (b) Additional Charges preserved; (c) picking, packing and shipping AFTER an invoice; (d) zero-value product lines; (e) later progress invoices; (f) no duplicate revenue, Sales or stock movements; (g) the customer-facing invoice shows Additional Charges only.

## Environment and fixtures (all disposable, none real)
- Cin7: the NewQuip POC trial instance only (instance pin on). Toolbox: the PR #126 branch Preview with `NEWQUIP_CIN7_WRITES_ENABLED=true` on that Preview only. Check first, read-only, whether the instance is connected to Xero; if it is, the owner decides whether to proceed or to disconnect for the test (nothing here touches Xero directly).
- Customer: a disposable Cin7 customer `ZZ-NQ-VERIFY-CUSTOMER` (owner creates it). No customer email is sent.
- Location: the instance's test location (the P0 convention uses `MSTR`).
- Test SKUs (owner chooses two existing, active, STOCKED, low-value products and records them; names below are placeholders): `TEST-A` and `TEST-B`, each with free stock >= 4 and >= 2 at the location.
- Disposable Project: contract R10,000 ex VAT, 15% VAT, the standard 40/55/5 schedule: Deposit R4,000 (VAT R600, total R4,600), Delivery R5,500 (VAT R825, total R6,325), Installation R500 (VAT R75, total R575).
- Sale (created by the Toolbox from the Project): Advanced Sale, AUTHORISED, product lines `TEST-A` x4 and `TEST-B` x2 at R0, three order-level Additional Charges for the three stages.
- Revenue account: the proven revenue account (code `200`, Sales) for T1-T6, T8.

## Read-back after EVERY step (GET /sale, read-only)
Record: Sale Type and Order.Status; Order totals; `Invoices[]` count, and for each invoice: number, status, TaskID, memo, TotalBeforeTax/Tax/Total, `Lines` (SKU, qty, price) and `AdditionalCharges` (description, qty, price, total, tax, account); `Fulfilments`; Combined picking/packing/shipping/invoice status; `COGSAmount`; `InventoryMovements`; `Transactions`. Save the sanitised JSON next to the step number in the evidence table (`cin7-api-contracts-to-verify.md`, "Recorded outcomes").

## Steps
| Step | Action (who) | Payload / input | Expected result | Resolves |
|---|---|---|---|---|
| T0 | Create the disposable Project and Sale via the Toolbox (writer, one attempt) | as above | Sale `Advanced Sale`, AUTHORISED, R0 lines, 3 order charges; no invoice; nothing picked/packed/shipped; COGS 0; no movements | C1, C2, C4, C5 |
| T1 | Approve the Deposit claim; post it (Toolbox writer) | Deposit-only claim R4,000 + R600; `Lines: []`; 1 AdditionalCharge | 1 DRAFT invoice, total R4,600, charge only, memo `NEWQUIP-PROJECTS:<project>:<claim>`; Fulfilments `[]`; COGS 0; movements `[]`; order totals unchanged | deposit before fulfilment; P5 re-confirmed |
| T2 | OPTIONAL, needs its own GO: owner authorises INV-T1 in Cin7 and prints the customer invoice with the customised template | n/a | Printed invoice shows ONLY the Additional Charge (no product lines, no R0 lines) | (g) customer-facing template |
| T3 | Approve the Delivery claim; post it as an authorised EARLY invoice (Toolbox writer) with `earlyReason` | R5,500 + R825 charge AND R0 lines `TEST-A` x2 | 2nd DRAFT invoice, total R6,325; line `TEST-A` qty 2 at price 0; charge intact; INV-T1 unchanged; order totals unchanged; still nothing shipped | C6, (d), early invoicing |
| T4 | Owner, in the Cin7 UI: try to add an invoice line for `TEST-A` above the ordered quantity (e.g. total 99) on a spare DRAFT, then discard the attempt | n/a | Cin7 rejects or warns; nothing is saved | C7 (quantity) |
| T5 | Owner, in the Cin7 UI: pick, pack and ship `TEST-A` x2 | n/a | Fulfilment recorded; `InventoryMovements` for TEST-A x2; COGS booked; INV-T1 and INV-T3 UNCHANGED (charges, totals, status); no new invoice; no new revenue | C9, (c) |
| T6 | Owner, in the Cin7 UI: use Cin7's own populate / "invoice the fulfilled lines" function for the fulfilled `TEST-A` x2 | n/a | Record exactly what it creates or changes. EXPECTED SAFE OUTCOME: nothing is overwritten and no second revenue-bearing invoice appears. If it does either, STOP (see below) | U1, U2 (bulk population vs Additional Charges) |
| T7 | Balance-sheet account: Toolbox writer on a SEPARATE tiny disposable Sale, or owner-operated, DRAFT only: one AdditionalCharge (R100 + VAT) on a nominated liability / unearned-revenue account | owner nominates the account code | Cin7 accepts or rejects it; record the exact message; no posting beyond DRAFT | UAT-010 account compatibility |
| T8 | Approve the Installation claim; post it (Toolbox writer) | R500 + R75 charge, `Lines: []` | 3rd DRAFT invoice; INV-T1/INV-T3 unchanged; sum of invoice charges = R10,000 ex VAT = contract; no duplicate revenue; fulfilment unaffected | (e), (f) |
| T9 | Second post attempt of the SAME claim (Toolbox) | same claim | Refused by the Toolbox (already posted / idempotent); Cin7 shows no new invoice | (f) duplicates |

## Stop conditions (stop immediately, record, do NOT retry or "fix")
- Any invoice, charge, total or status that changed without our request, or any extra revenue-bearing invoice, extra Sale or extra stock movement.
- A response that is neither a clear success nor a clear failure (treat as uncertain: reconcile read-only first, never repost).
- The Toolbox reports `FAILED_UNCERTAIN` at any point.
- Cin7 reports a Xero sync / posting error for any document.
- T6 changes or removes an Additional Charge, or creates a second revenue invoice. This is the key finding: it means Cin7's populate function must not be used on Project Sales, and the owner decides between a Toolbox guard and an operating rule.
- Any read-back differing from the table's expected result in a financial figure.

## Evidence, cleanup, approvals
- After each step: sanitised read-back JSON, the Cin7 document numbers, the step's PASS / FAIL / STOP, appended to `cin7-api-contracts-to-verify.md` "Recorded outcomes" with the commit SHA of the Preview.
- Cleanup: DRAFT invoices may be voided in the Cin7 UI at the owner's discretion; nothing is deleted; the disposable Project and Sale remain as evidence.
- Gate: the owner replies "GO <step>" per step. T2 and T7 are separately optional. A STOP ends the run until the owner decides.
- Not part of this plan: Production writes, real customers, any email, any Xero action.
