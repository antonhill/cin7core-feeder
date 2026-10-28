# Cin7 API acceptance proof plan (P0-P7)

Supersedes the T0/T1/T2 runbook (`t0-proof-runbook.md`, written for priced lines). Model under test: one Advanced Sale per scope, physical SKUs at **R0**, the approved contract value as **Additional Charges**, invoices raised by Toolbox from approved claims, manual assembly and fulfilment in Cin7. Contract assumptions under test are C1-C10 in `cin7-api-contracts-to-verify.md`.

**Nothing in this plan has been executed. P1 to P7 each need their own written owner approval; P0 is read-only.**

## Common rules (apply to every proof)
- **Disposable only.** NewQuip POC Cin7 instance, a *dedicated* test customer created by the owner in Cin7 (never AGRICO, AFGRI, AMANZIMNENGI or any operational customer), disposable SKUs/stock verified as disposable (movement history checked by the owner). `PRJ-NQ-Q-0001`, `PRJ-NQ-Q-0001-C01`, `INV-00021` and SO-00019 are never touched. Use a **new** disposable Toolbox project, not the real POC project.
- **Where it runs.** The integration Preview only, with `NEWQUIP_CIN7_WRITES_ENABLED=true` set for that branch for the duration of the proof and **unset immediately afterwards**. Production can never write (the flag is forced off when `VERCEL_ENV=production`, `src/lib/projects/write-flag.ts`). The Preview must use the POC Supabase project through branch-scoped variables (see readiness report section 3).
- **One write at a time.** Before each write: state the exact operation, the records affected, the flag and environment, the expected financial and inventory effect, and record the pre-write state (screenshot/GET). Owner replies with the exact approval sentence for that step. Execute once. Read back. Reconcile. Stop on any deviation. A failed or ambiguous response is **never** permission to resend; reconcile first.
- **Evidence per step:** exact commit, Cin7 document numbers, sanitised request/response (no keys), before/after state, database rows, inventory/accounting effect, PASS/FAIL, exceptions. Appended to `cin7-api-contracts-to-verify.md` "Recorded outcomes".
- **Global stop conditions:** any document not created by this proof appears; any amount, VAT, quantity or status differs from the plan; a response is missing a field the verification needs; the Sale reads back as not Advanced or not AUTHORISED; a second document with our reference exists; Cin7 or Toolbox reports an uncertain outcome; the rate limit is hit repeatedly. On stop: do nothing further, record state, report.
- **Cleanup.** Cin7 documents are not deleted by Toolbox. Disposable documents are voided/left by the owner in the Cin7 UI after the proof, recorded in the evidence.

## P0 - read-only prerequisites (no write; can run now with owner sign-in)
**Interface:** on the disposable project's Claims tab, "Create the Cin7 Advanced Sale" panel: enter the customer name, location, revenue account and the SKU rows (quantity, expected type), then **Run P0 checklist (read-only)**. It performs GETs only and returns a table of PASS / FAIL / MANUAL / NOT RUN.
**Automated checks:** not Production; write flag OFF; Supabase project is `pnzwjqjovxxdikxtfngq` (both URLs); the organisation has **exactly one** active Cin7 instance and it is the NewQuip POC instance (`30eac8f2-...`); customer is not AGRICO / AFGRI / AMANZIMNENGI; customer exists by **exact** name; the customer's default tax rule, revenue account and location equal what was entered (and the project's tax rule); every SKU exists by exact match; assembly flag is as expected per SKU; free stock at the named location >= the quantity; no Sale already carries the proof's ExternalID.
**Explicit failures, never substitution:** a wrong/missing database, instance, customer or SKU is a FAIL with the facts; later checks that depend on it are NOT RUN; P0 never creates or selects an alternative. `READY_PENDING_MANUAL` is the best possible automated verdict.
**Manual checks (owner confirms with screenshots):** customer is dedicated and disposable; movement history of the stock reviewed; tax rule and rate; revenue account exists; BOM components and FIFO costing; "Default Load Advanced Sales Order" setting.
**Pass:** zero FAIL, zero NOT RUN, manual items confirmed; baseline recorded (stock on hand/allocated, last Sale/invoice numbers).
**Stop:** anything missing or ambiguous. P0 is not authorisation for P1.

## P1 - create the Advanced Sale (first external write)
**Operation:** Toolbox "Create the Cin7 Advanced Sale" for a new disposable project. Exactly: header `POST /sale` (Customer, Location, `SaleType: Advanced`, ExternalID `NEWQUIP-PROJECTS-SALE:<ref>`, tax rule) then `POST /sale/order` (R0 lines for the chosen SKUs; one Additional Charge per billing stage for the full contract; VAT as per-charge amounts; AUTHORISED). Two POSTs, once each.
**Disposable fixture (proposed):** contract R100,000 ex VAT in stages Deposit 10% / Manufacturing 60% / Delivery 30% (R10,000 / R60,000 / R30,000; VAT R1,500 / R9,000 / R4,500; total ex VAT R100,000, VAT R15,000); one physical SKU, quantity 2 (the owner's chosen disposable SKU, location with stock). Small numbers so a wrong figure is obvious.
**Expected effects:** one Sale with one order; no invoice, fulfilment, pick, pack, stock movement or COGS; allocation of 2 units (if stock) is acceptable and recorded.
**Owner approval sentence:** `GO P1: create ONE Advanced Sale for project <ref> for customer <name>, SKU <sku> x2, contract R100,000 ex VAT, on the integration Preview at commit <sha>.`
**Pass:** creation state RECONCILED and the Sale linked (Toolbox verified the read-back); otherwise STOP.
**Stop (in addition to global):** Cin7 rejects `SaleType`, the Sale reads back as Simple, the order is not AUTHORISED, an R0 line carries a price/VAT, a charge amount or VAT differs by one cent, the header exists without the order (orphan header: do not retry; reconcile; owner decides void vs link).

## P2 - read back and verify (read-only)
Independent of Toolbox's own check: owner screenshots and a raw GET compared line by line: Type, Order.Status AUTHORISED, customer, tax rule, ExternalID, quantities, line prices all R0, three charges and amounts, order total ex VAT R100,000, VAT R15,000, no invoices/fulfilments/credit notes/adjustments; stock allocation vs baseline. Verify the Toolbox project shows the Sale linked and the creation row RECONCILED with an audit trail. **Pass:** all identical. Records C1-C5.

## P3 - deposit-only DRAFT invoice
**Preconditions:** P1-P2 passed; claim for the Deposit stage approved in Toolbox (R10,000 ex VAT, VAT R1,500, total R11,500).
**Operation:** "Create a Cin7 invoice for this approved claim" (charges only, no product lines, DRAFT). One `POST /sale/invoice`.
**Expected:** one DRAFT invoice with memo `NEWQUIP-PROJECTS:<ref>:<claim>`, ex VAT R10,000, VAT R1,500, total R11,500; Sale "amount to invoice" reduced accordingly; no fulfilment, stock or COGS.
**Approval sentence:** `GO P3: post claim <claim> (deposit R10,000 + VAT R1,500) as ONE DRAFT invoice on Sale <SO> ...`
**Pass:** posting RECONCILED, figures exact in cents. **Stop:** VAT or total wrong (INV-00021 shape), NaN/missing fields, duplicate memo, any stock/COGS effect. Then **replay the same request**: Toolbox must return the existing result and send nothing (verify no second invoice). Records C3, C6 (charges), C8.

## P4 - progress invoice with R0 physical lines plus charges
**Operation:** next approved claim (Manufacturing, R60,000 + R9,000 VAT) posted with physical line SKU x1 (a quantity within the remaining invoiceable 2). One `POST /sale/invoice`.
**Expected:** DRAFT invoice with the product line at R0 (qty 1) and the charge; totals R60,000 / R9,000 / R69,000; invoiced qty 1 of 2.
**Also test (each separately approved if they write):** request qty 3 -> **Toolbox refuses before sending** (read-only check; no approval needed); a second invoice for the remaining 1 succeeds; a further qty is refused. If the owner approves a deliberate direct-API over-quantity attempt (separate GO), record whether Cin7 itself rejects it (C7).
**Stop:** product line carries a price or VAT, quantity read back differs, totals differ. Records C4, C6, C7, C8.

## P5 - manual assembly and finished-goods visibility (owner works in Cin7; Toolbox read-only)
Owner manually builds the assembly SKU in Cin7 for the disposable stock (their own Cin7 action, not Toolbox). Verify in Toolbox "Physical": finished-goods record appears with status/quantity, component consumption once, finished stock up, shortfall estimate falls, no duplicate consumption; the account-wide labels are accurate. No Toolbox write exists in this step (pinned by test). Records C10.

## P6 - partial fulfilment, inventory movement, cost recognition (owner works in Cin7)
Owner picks/packs/ships 1 of 2 units. Verify: stock down by 1; shipped = 1, remaining = 1 in Toolbox; COGS recognised on the Sale (read via the profitability panel: cost to date) equals 1 x average/FIFO cost; **no revenue** recognised for the R0 line; invoices unchanged; actual margin still "not meaningful yet" (delivery incomplete). Records C9 and the COGS timing (draft vs authorised fulfilment) for Sean (S2).

## P7 - variation Sale, claim routing, consolidation
**Preconditions:** P1-P6 passed. New variation (e.g. R20,000, own schedule 50/50) raised, priced, approved in Toolbox; manager starts variation billing (local, no Cin7 write) then separately approves creation of the **variation's own Sale** (second P1-style write, new project/scope, ExternalID with the variation code) for the same customer.
**Approval sentence:** as P1 for the variation scope.
**Verify:** a different Sale (own number) with the variation's R0 lines/charges; the variation's claim posts to **its** Sale (invoice memo has the variation reference), never to the base Sale; base Sale and invoices unchanged; consolidated view totals (contract, claimed, invoiced, remaining, estimated margin, cost to date) equal the sums of the two Sales' documents; profitability exceptions list stays empty. **Stop:** any invoice on the wrong Sale, any base-Sale change. Records the multi-Sale model end to end.

## After the sequence
Remove/unset the branch flag; owner voids or retains the disposable documents; evidence appended; readiness re-assessed. No proof authorises production use, hosted migration, merging, or posting `PRJ-NQ-Q-0001-C01`.
