# UAT-019/020: Cin7 billing versus fulfilment (findings and proposed proof)

Status: INVESTIGATION COMPLETE, DECISION NEEDED. No Cin7 call was made for this document; it is built from existing code and the recorded read-only/owner-run evidence.
Architecture (approved, unchanged): one Project = one Cin7 Advanced Sale (except approved variations); each approved claim = one invoice on that Sale whose value is carried by
Additional Charges only; physical product lines on an invoice are quantity-only at R0.

## 1. What the code already supports (mapped to the required behaviours)

| Requirement | Where | State |
|---|---|---|
| 1 Deposit invoice before fulfilment | `proposeInvoice`: DEPOSIT/SERVICE claims propose no product lines; charges only | supported; invoice shape proven by P5 (Lines `[]`, AdditionalCharges only) |
| 2 Standard claim after fulfilment | default rule: eligible = shipped - invoiced - reserved | supported (read-only evidence of shipments) |
| 3 Authorised early invoicing | manager selects above eligible up to the Sale's remaining invoiceable quantity; `validateSelection` demands a recorded `earlyReason`, stored on the posting | supported in code; behaviour in Cin7 unproven (section 3) |
| 4 Later pick/pack/ship on the same Sale | fulfilment is never created by the Toolbox | the P5 DRAFT invoice (returned Sale model only) showed no pick/pack/ship/stock/COGS; authorised invoices and the reverse order (invoice first, fulfil later) are unproven |
| 5 Multiple claims/invoices on one Sale | `project_claim_cin7_postings` unique per claim; memo `NEWQUIP-PROJECTS:<project>:<claim>` | one P5 invoice proven (INV-00019 on SO-00015). The Toolbox writer also produced INV-00032 on SO-00026 in owner UAT (hosted posting row RECONCILED, Cin7 status DRAFT; owner-reported, from the hosted database and UAT, not independently inspected in Cin7 here and not yet in the recorded-outcomes table). Several live invoices on one Sale is NOT separately proven |
| 6 Zero-value internal physical lines | R0 lines with quantity; read-back requires `Price = 0` | writer implemented; contract C4/C6 not proven |
| 7 Customer invoice shows Additional Charges only | charges carry the whole value | charge-only DRAFT invoice shape accepted by Cin7 (P5, INV-00019); the customer-facing printed invoice and invoices with R0 lines have not been checked against the customised template |
| 8 No overwriting of earlier charges | each invoice is a separate task with its own charges; cumulative claims <= approved | within Toolbox proven by design/tests; Cin7's own bulk functions are UNVERIFIED (section 3) |
| 9 No duplicate Sales/invoices/revenue/stock | idempotency key + exact memo reconcile + `FAILED_UNCERTAIN` blocks retry | tested locally; live evidence is limited to the P5 invoice and the owner-UAT posting above |

Added in this work (local tests only): selective claims by billing stage (UAT-013), bulk product selection on the invoice preparation screen (UAT-024). Neither changes what is sent to Cin7
beyond which product quantities the manager chooses; the commercial charges still come only from the approved claim.

## 2. What the existing evidence does NOT tell us

The UAT wording mentions "bulk invoice-population behaviour". Nothing in the repository or the recorded evidence describes how Cin7's own bulk "populate invoice lines" function
behaves when an invoice already holds Additional Charges, or how a later fulfilment (pick/pack/ship) interacts with invoices that were created first. These are Cin7 product behaviours,
not Toolbox behaviours, and I have not invented an answer.

## 3. Unproven contracts that matter here (from `cin7-api-contracts-to-verify.md`)

- C6 invoice with R0 product lines plus AdditionalCharges.
- C7 over-invoicing: whether Cin7 rejects quantity above ordered and charges above the order.
- C9 a fulfilment of R0 lines: COGS but no revenue.
- NEW U1: invoice created BEFORE fulfilment, then Cin7's UI/API fulfilment-to-invoice population is used: does it add lines to, replace, or duplicate the existing invoice?
- NEW U2: does a Cin7 bulk "create invoice from fulfilment" overwrite existing AdditionalCharges on that Sale's invoices or create a second revenue-bearing invoice?

## 4. Proposed controlled proof (NOT executed; needs the owner's explicit GO)

Environment: the NewQuip POC trial Cin7 instance only (instance pin stays on), PR #126 branch Preview, Production writes OFF. A throw-away customer, Advanced Sale and Project; no real customer data;
no emails; nothing on Xero (confirm the instance's Xero connection state first).

1. Create a disposable Advanced Sale, AUTHORISED, two R0 product lines (SKU-A qty 4, SKU-B qty 2), one order-level contract charge. Record the full `GET /sale`.
2. T1 deposit: post a charge-only DRAFT invoice (Lines `[]`). Expect: no fulfilment/COGS/stock. (Re-confirms P5.)
3. T2 early invoice: post an invoice with R0 lines (SKU-A 2) plus a charge, with `earlyReason`. Read back: lines R0, charge present, quantities as sent, order totals unchanged. Resolves C6.
4. T3 over-quantity attempt (SKU-A 99): expect Cin7 rejection, no write. Resolves C7 (quantity). A charge above the order is attempted only if the owner agrees.
5. T4 fulfil after invoicing: pick/pack/ship SKU-A 2 in the Cin7 UI (owner-operated). Read back: invoices unchanged, COGS booked, no new revenue. Resolves C9 and U1.
6. T5 bulk population: owner uses Cin7's own populate/bulk-invoice function on the fulfilled lines. Capture before/after of every invoice's charges and totals. Resolves U1/U2. This is the step that decides whether any Toolbox guard is needed.
7. T6 second claim after T5: post another charge invoice; verify earlier invoices' charges unchanged and no duplicate revenue.

Stop conditions: any unexpected revenue, a modified earlier invoice, or a second Sale: stop, record, do not retry. Evidence is appended to the "Recorded outcomes" table in `cin7-api-contracts-to-verify.md`.

## 5. Decisions needed from the owner
1. GO (or not) for the disposable-Sale proof above, and who operates the Cin7 UI steps (T4, T5).
2. If T5 shows Cin7's bulk population can overwrite charges: choose between a Toolbox-side guard (read-back verification before/after any fulfilment-driven invoice) and an operating rule (no bulk population on Project Sales).
3. Partial-amount claims (UAT-013 second half) need a database change: `project_claim_lines` enforces `current_claim_cents = earned_to_date_cents - previously_committed_cents`, so a partial amount needs a new migration (relax the check and persist a partial marker so staleness and approval recompute the same amount). Not written; migration ownership and hosted application are the owner's call.
