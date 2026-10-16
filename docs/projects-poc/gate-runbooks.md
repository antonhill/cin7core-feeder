# Projects POC — runbooks for the gates that need credentials / a session

## V1 — read-only Cin7 probe (GET only)
Needs the NewQuip **trial** Cin7 account id + application key, on a machine that already has them.
```
export CIN7_ACCOUNT_ID='…'   # NewQuip TRIAL only
export CIN7_APP_KEY='…'
node scripts/probe-sale-invoices-readonly.mjs --max 100
```
Safe to share: structure/counts only. Paste the output; P0 §6 and P4 are then updated with PROVEN / OBSERVED / UNVERIFIED labels. If no sale has >1 invoice, that is reported and **no sale is created**.

## V2 — authenticated walkthrough (NO Cin7 write)
Normal authenticated Toolbox session in the NewQuip trial org. A super-admin enables the **Projects** module for the org (it ships OFF; migration 0101 must first be applied to the target database with Anton's approval — until then `/projects` cannot persist anything).

| # | Step | Expected |
|---|---|---|
| 1 | open `/projects` | list renders (empty state with the fixture button) |
| 2 | as owner/admin: *Create golden fixture project* → open it | project opens |
| 3 | Stages tab | six stages, R10,000,000 total, % of contract 10/30/20/20/15/5 |
| 4 | Update progress (physical only) on Installation | recorded; approved % unchanged |
| 5 | confirm separation | Physical / Commercial approval / Billed columns are distinct and differently coloured |
| 6 | open stage History | earlier events still present; new event appended |
| 7 | Claims → Preview claim | Manufacturing R450,000; Delivery R500,000; ex VAT R950,000; VAT R142,500; total R1,092,500 |
| 8 | Save as draft claim | draft appears; claimable unchanged |
| 9 | Submit → Approve as owner/admin | status APPROVED, "reserves value" |
| 10 | as a plain member: Approve a READY claim | rejected ("Only an org owner or admin can approve a progress claim.") |
| 11 | approved claim | no edit path in UI; DB rejects edits |
| 12 | Preview again with no progress change | NOTHING_TO_CLAIM |
| 13 | as admin approve Manufacturing 100% → Preview | Manufacturing R1,050,000 only |
| 14/15 | FAILED_UNCERTAIN / FAILED_CONFIRMED_NO_WRITE | reachable only through the (future) Cin7 write path; POC evidence = engine + SQL tests (see report) |
| — | Network tab | **no request leaves the Toolbox origin** |
