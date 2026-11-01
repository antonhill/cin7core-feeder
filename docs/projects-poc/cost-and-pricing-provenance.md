# NewQuip cost and price provenance (UAT-002, UAT-004, UAT-010)

## The four cost figures (never merged, never rewritten by one another)
| Figure | Where it lives | Who sets it | Changes when |
|---|---|---|---|
| Cin7 source cost | Cin7 latest supplier price, read-only (`latest-cost`, `supplier-price`) | Cin7 | Cin7 changes; the Toolbox only reads it |
| Estimator's expected Project cost | quotation cost override (`costOverrides`, reason, who, when) and the Cin7 capture, then FROZEN into `accepted_baseline.internalMargin` at approval | Estimator | until Manager approval; frozen after |
| Procurement purchasing target | the frozen estimate shown as "approved cost" in Procurement / Cost Targets (`getProcurementTargetsAction`, read-only) beside today's Cin7 cost | read from the frozen estimate | never: a later Cin7 cost does not rewrite it |
| Actual purchase cost | recognised cost on invoiced lines, read from Cin7 | Cin7 / purchasing | as purchases happen |

Carry-through (proved by `cost-override-carry.test.ts`): override -> margin sheet line (reason shown) -> frozen `internalMargin` at approval -> `baseCostFromBaseline` -> Project costing report. An incomplete sheet gives the Project no cost (a partial total is never used). Procurement access: org owner/admin, Manager, or the PROCUREMENT role; the view carries unit costs, never the contract margin. Nothing here writes to Cin7 costs or purchase orders.

## Selling-price provenance (UAT-002)
- Approved catalogue pricing = the configured price source (today the POC price snapshot; it is NOT yet a verified production price list, and the interface still says so).
- An exceptional MANUAL QUOTATION PRICE (a resolution for a line the source cannot price) is labelled as such on the line, listed in the readiness exceptions, frozen in the baseline, shown to approvers, stamped by the server with who and when, and only an Estimator or Manager can create or change one. It is never written to Cin7 or the snapshot.
- POC wording about the price SOURCE is deliberately kept: the source is not ready, so it is not presented as verified.

## Cin7 Location and Revenue Account (UAT-010)
- Lists come from a read-only `GET /ref/location` and `GET /ref/account` against the organisation's single pinned NewQuip instance, manager only. If they cannot be read the typed fields remain and the existing server checks still run.
- Selectable: active, ordinary REVENUE accounts only. Evidence: Cin7 accepted an Additional Charge on account "200: Sales" (P5).
- Listed but locked: balance-sheet LIABILITY accounts (e.g. customer deposits). No evidence yet that Cin7 accepts them on an invoice charge. Proposed proof T7 is in `uat-019-020-cin7-billing-vs-fulfilment.md`.
- Never selectable: Cin7 special accounts (SystemAccount set), inactive accounts, accounts whose class Cin7 did not report.
- Limitation: the class names Cin7 returns were not observable in this session (no Cin7 credentials were used). The classifier matches revenue/income/sales and liabil* on Class or Type; if the live lists show different names, no account would be selectable and the manual fallback applies. Confirm on first Preview use. The Sale-creation server checks were NOT tightened, so a typed account still passes through the existing validation exactly as before.
- The recovery form (admin) still takes typed values.
