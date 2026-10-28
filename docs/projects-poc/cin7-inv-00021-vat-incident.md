# Incident: INV-00021 posted with R30 VAT (first live claim post, 2026-10-27)

**What happened.** The first post through the writer (claim NQ-POC-MVQWWSNB-C02 on disposable Advanced Sale SO-00019) created ONE DRAFT invoice INV-00021 with two AdditionalCharges (R500,000 and R450,000), account 200, correct memo, no product lines. Cin7 holds ex VAT R950,000 / VAT **R30** / total R950,030; the approved claim is R950,000 / R142,500 / R1,092,500. Toolbox recorded `CREATED` with `AMOUNT_MISMATCH` and "NaN" amounts. Nothing was re-sent; the claim is still APPROVED; there is one posting row.

**Root cause 1 - VAT sent as a rate.** `AdditionalCharges[].Tax` is the VAT **amount**, and Cin7 uses the value it is sent rather than deriving it from the tax rule (`src/cin7/sale-quote-write.ts`, confirmed live 2026-08-26). The writer sent `Tax: 15` (the rate) on both charges: R15 + R15 = R30. The P5 hand test (R100 at 15%) could not distinguish rate from amount - both are 15 - so the wrong reading looked proven. Fixed: the charge now carries `taxAmount` (the frozen per-line VAT) and sends `Tax: <amount>`.

**Root cause 2 - missing totals read as NaN / zero.** The POST response carried no usable `TotalBeforeTax` / `Tax` / `Total` (inferred from the NaN; the response itself was not captured). The code turned missing into `NaN`, and the read-back adapter turned missing into 0. Fixed: missing or non-finite is `null`, never a number, never a match. When the POST echoes no totals the writer reads the Sale back (read-only) and verifies the amounts; unreadable amounts are reported as a mismatch ("not returned by Cin7"), with real figures in rands otherwise.

**What held.** Persist-PENDING-first, `unique(claim_id)`, CREATED never re-sent, mismatch not silently reconciled. Duplicate prevention was never in question.

**Remediation of INV-00021.** None automatic. It stays CREATED/AMOUNT_MISMATCH in Toolbox (a mismatch is never RECONCILED). The owner voids it in Cin7 by hand if wanted; C02 is a disposable claim and cannot be re-posted (that is the point of the state machine). Verify the fix on a NEW disposable Project and claim.
