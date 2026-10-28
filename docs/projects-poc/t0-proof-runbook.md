> **SUPERSEDED (2026-10-28).** Written for priced product lines (NQ2886 x2 at R500). The model is now R0 physical lines plus a contract charge; use `cin7-acceptance-proof-plan.md` (P0-P7). Kept as evidence only.

# T0 proof runbook: physical Advanced Sale, authorised, allocation only

Status: **PREPARED. NOT AUTHORISED TO RUN.** The owner separately authorises execution after reviewing the GO/NO-GO checklist (section 4). T1 and T2 are **not approved**. No Cin7 write, no Supabase mutation, no invoice, fulfilment, stock adjustment or production operation is part of preparation.

Specification and hypotheses: `architecture-inventory-billing-costing.md` section 19 (T0). This runbook is the operating procedure for that specification.

Roles: **Owner** performs every Cin7 UI action and captures evidence. **Claude** built the read-only inspector, prepares this procedure, and evaluates the evidence the owner returns. Claude performs no Cin7 action.

---

## 1. What T0 proves, and what it deliberately does not

T0 asks one question: *does an authorised Advanced Sale with one product line reserve stock, and do nothing else?* Hypotheses (UNVERIFIED until run): the Sale is an Advanced Sale; the order is AUTHORISED; 2 units become allocated at MSTR and available falls by 2; on-hand and stock value do not move; no invoice, fulfilment, journal, COGS, inventory movement or Xero event exists.

It does **not** test invoicing (T1), shipping or COGS (T2), VAT liability, revenue, variations or manufacturing. Nothing in T0 may create an invoice, a pick, a pack, a ship, a credit note or a stock adjustment. If any of those appear, STOP.

---

## 2. Baseline and fixture disposability (read-only evidence)

Source: the Toolbox's synced copy of the NewQuip POC trial's Cin7 data (organisation `e1aea782-...`, instance `30eac8f2-...`, last stock sync 2026-10-27 20:08 UTC). The inspector re-reads this **live** from Cin7 before the test (section 5, step B); the cache is not trusted on its own.

| Property | Value | Source |
|---|---|---|
| SKU / name | `NQ2886` "CUP DRINKER BRACKET PEN MOUNT 1644248MMX820MM" | cache |
| Type, status | Stock item, Active, sellable | cache |
| Costing | **FIFO** | cache |
| Average cost field | R50 (placeholder; not a real cost) | cache |
| UOM, category | Item, Other | cache |
| Auto assemble / disassemble / drop ship / make-to-order | No / No / No drop ship / none | cache |
| Sale tax rule on the product | none (the Sale's tax rule applies) | cache |
| Revenue / COGS / inventory account on the product | none synced (Cin7 defaults, if any, unknown) | cache |
| Default location, reorder point/qty | none; 0 / 0 | cache |
| Stock | **MSTR only**: on hand 1,000; allocated 0; available 1,000; on order 0; in transit 0; stock value R50,000.00 (R50.0000 a unit) | cache |
| Documents referencing the SKU | **None found** in synced sale lines, sale order lines, purchase lines or assembly BOMs | cache |

### Is it disposable? What the evidence shows and does not show

- **Supports disposability:** the stock is the seeded placeholder (exactly 1,000 at exactly R50.0000, the pattern on 11,021 of the org's stock rows); no sale, purchase or BOM in the Toolbox cache references the SKU; nothing is allocated; it is a single-location stock item.
- **Does not prove it:** the cache does not include stock adjustments, stock takes, stock transfers, production orders, open quotes, or documents created after the last sync. The owner must check the SKU's movement history in Cin7 (checklist item O1).
- **Blast radius if the test goes wrong:** 2 units of seeded stock allocated at MSTR, reversible by voiding the order. No cost, revenue or VAT effect is expected in T0.
- **Residual risk to flag:** MSTR also holds real operational stock for other SKUs. T0 touches only `NQ2886`. Owner to confirm MSTR is acceptable (O2).

---

## 3. Fixture sheet (to be signed by the owner)

| Field | Value |
|---|---|
| Instance | NewQuip POC trial organisation |
| Sale type | **Advanced Sale** (must be Advanced from creation; do not create a Simple Sale) |
| Customer | **Recommended:** a dedicated test customer (e.g. "ZZ T0 TEST - DO NOT USE"), created by the owner. **Alternative:** the customer used on SO-00019. Earlier disposable Sales used customer records that look real; a dedicated customer avoids putting a test order on a real account |
| Customer reference | `T0 PROOF - DISPOSABLE - DO NOT FULFIL` |
| Order date | the day of the test |
| Currency | ZAR |
| Location | MSTR |
| Tax rule | Standard Rate Sales (the Sale-level rule; check the customer default does not change it) |
| Terms | 30 days |
| Product line | `NQ2886`, quantity **2**, price **R500.00** ex VAT, discount 0 |
| Expected order totals | ex VAT R1,000.00; VAT R150.00; total R1,150.00 |
| Final state | **Authorised** order. Nothing else |

---

## 4. GO / NO-GO checklist

Every item must be GO. Any NO-GO stops T0. Items marked CLAUDE are done by Claude; items marked OWNER are done or confirmed by the owner.

### A. Prepared and verified (CLAUDE)

| # | Item | Status |
|---|---|---|
| A1 | Fixture facts and baseline captured read-only (section 2) | **DONE** |
| A2 | Inspector built on the isolated investigation branch, from `origin/main`, with none of the #121/#122 code | **DONE** |
| A3 | Inspector is GET-only: no form, no action, no write method, no Supabase mutation; reads only SKU `NQ2886` and one Sale by SaleID | **DONE** (19 + 5 tests) |
| A4 | Access: signed-in, NewQuip POC organisation hard-coded, org owner/admin only; otherwise 404 before any Cin7 call. Unauthenticated requests redirect to login (verified on a production build) | **DONE** |
| A5 | Output is an allow-list projection: no customer, address, contact, note, attachment, credentials or raw payload (tested) | **DONE** |
| A6 | Full suite 2,030 tests, TypeScript, ESLint (0 errors), production build, `git diff --check` pass; service-role allowlist updated | **DONE** |
| A7 | Preview deployment of the investigation branch is READY on the exact commit, with no #121/#122 content | **PENDING: needs your approval to push** |
| A8 | Live BEFORE reading from the Preview shows `ALL EXPECTED` (live stock equals the baseline) | **PENDING: after A7** |

### B. Owner confirmations (OWNER)

| # | Item | Status |
|---|---|---|
| O1 | `NQ2886` is **confirmed disposable test stock**: its Cin7 movement history shows no real purchases, sales, adjustments, transfers or production, and nobody else will transact it during the test | |
| O2 | MSTR is acceptable for a reservation of 2 units of `NQ2886` | |
| O3 | The Cin7 setting "Default Load Advanced Sales Order" is recorded (on or off) before starting | |
| O4 | Customer chosen (dedicated test customer recommended) | |
| O5 | The Xero connection state is recorded (which organisation; whether sync is automatic), even though T0 should send nothing | |
| O6 | Evidence method agreed: screenshots S1 to S10 (section 6) and a journal/accounting view if Cin7 shows one for the Sale | |
| O7 | Rollback understood: void the order (section 8) | |
| O8 | Stop conditions understood (section 7); owner will stop and report instead of improvising | |
| O9 | Written statement: **T1 and T2 are not approved**; nothing is invoiced, fulfilled, adjusted or produced | |
| O10 | The fixture sheet (section 3) is signed with any substitutions | |

### C. Final authorisation (OWNER)

> "GO for T0 as specified in `t0-proof-runbook.md`, with the fixture sheet as signed."

T0 does not start without this sentence (or equivalent) from the owner.

---

## 5. Exact UI procedure

Screen and button names below follow Cin7 Core's usual layout and **may differ slightly on your screen**. If a control is missing or the screen behaves differently from a step, **STOP and send a screenshot**; do not work around it.

**A. Before (no Cin7 changes)**

1. Open Cin7 and note the date and time. Open **Settings > General settings** and screenshot the "Default Load Advanced Sales Order" setting (**S1**). Do not change it.
2. In Cin7, open product `NQ2886`. Screenshot the stock/availability for location MSTR (on hand, allocated, available) (**S2**) and its movement/history list (**S3**).
3. Open the inspector on the dedicated Preview, signed in as the org owner or admin: `<preview-url>/cin7-proof/t0` (no parameters). Confirm the verdict is **ALL EXPECTED** and the stock reads 1,000 / 0 / 1,000 at MSTR. Screenshot it (**S4**). If it says DEVIATION: **NO-GO**.

**B. Create the Sale (Cin7 write by the owner)**

4. Go to **Sales > Sales** and start a new sale. If the screen offers a choice, choose **Advanced Sale**. If it opens a Simple Sale, STOP and report; do not convert it.
5. Enter exactly the fixture sheet: customer, customer reference, ZAR, location MSTR, Standard Rate Sales, 30-day terms.
6. Add one line: SKU `NQ2886`, quantity 2, price 500.00, discount 0. Confirm the line shows R1,000.00 ex VAT and the order shows VAT R150.00, total R1,150.00. Screenshot the unsaved order (**S5**).
7. Save as **draft** first. Confirm it is shown as an Advanced Sale and screenshot the header (**S6**).

**C. Authorise (Cin7 write by the owner)**

8. Authorise the **sale order** only. Do **not** open or use the Pick, Pack, Ship, Invoice or Credit Note tabs, and do not press any button that creates them.
9. Note the Sale number (e.g. SO-000nn) and copy the SaleID from the browser address (the long GUID in the URL). Screenshot the authorised order, including the status (**S7**).
10. If Cin7 shows a journal or accounting view for this Sale, screenshot it, even if empty (**S8**).

**D. After (read-only)**

11. Wait about 30 seconds, then in Cin7 screenshot `NQ2886` availability at MSTR again (**S9**).
12. Open the inspector with the SaleID: `<preview-url>/cin7-proof/t0?sale=<SaleID>`. Screenshot the whole page, including the checks and the Sale block (**S10**).
13. Send Claude: S1 to S10, the Sale number and SaleID, the date/time of each step, and anything that looked unexpected.

Do nothing further to the Sale until Claude's evaluation is returned and the owner decides the next step.

---

## 6. Evidence and before/after reconciliation

### Screenshots

| ID | What | When |
|---|---|---|
| S1 | Default Load Advanced Sales Order setting | Before |
| S2 | `NQ2886` availability at MSTR | Before |
| S3 | `NQ2886` movement/history | Before |
| S4 | Inspector, BEFORE mode | Before |
| S5 | Unsaved order with line and totals | During |
| S6 | Draft Sale header showing Advanced | During |
| S7 | Authorised order, status and number | After authorise |
| S8 | Journal/accounting view if available | After |
| S9 | `NQ2886` availability at MSTR | After |
| S10 | Inspector, AFTER mode with the SaleID | After |

### Reconciliation sheet (Claude fills in from the evidence)

| Measure | Before (live) | Expected after | After (live) | Match |
|---|---|---|---|---|
| `NQ2886` on hand, MSTR | 1,000 | 1,000 | | |
| allocated | 0 | 2 | | |
| available | 1,000 | 998 | | |
| on order / in transit | 0 / 0 | 0 / 0 | | |
| stock value | R50,000.00 | R50,000.00 | | |
| Sale type | n/a | Advanced Sale | | |
| Order status | n/a | AUTHORISED | | |
| Lines | n/a | 1 x `NQ2886` x 2 @ 500.00 | | |
| Order ex VAT / VAT / total | n/a | 1,000 / 150 / 1,150 | | |
| Invoices / fulfilments | n/a | 0 / 0 | | |
| COGS amount / inventory movements | n/a | 0 / 0 | | |
| Journals / Xero | n/a | none / nothing | | |

A deviation is a **finding**, recorded and explained; it is not hidden or "fixed". Stock value is read from the Cin7 UI (the inspector shows quantities, not valuation).

---

## 7. Stop conditions (stop and report; do not continue)

- The Sale is a Simple Sale, or Cin7 offers only a Simple Sale.
- The inspector's BEFORE reading is not ALL EXPECTED.
- Any invoice, pick, pack, ship, fulfilment, credit note or stock adjustment appears or is offered as part of the flow.
- Authorising the order prompts for anything beyond the order (for example "create invoice", "create purchase order", "create production").
- A journal, Xero invoice or Xero event appears.
- Allocation lands on a different SKU or location, or on-hand changes.
- Any screen differs materially from this procedure.
- Anyone else transacts `NQ2886`.

## 8. Rollback and cleanup

- **Voiding the order** (owner, in the UI, once evidence is captured): expected result, allocation returns to 0 and available to 1,000. Read the inspector (BEFORE mode) and screenshot it; this is **T0b**, evidence that reversal works.
- **Leaving it authorised** is the default if the owner wants T1 later: the 2 units stay reserved. Since T1 and T2 are not approved, decide explicitly after Claude's evaluation: void now, or keep the fixture for a stated period.
- Neither action touches any real NewQuip project, claim or stock.

## 9. Inspector reference

- Route: `/cin7-proof/t0` (BEFORE mode) and `/cin7-proof/t0?sale=<SaleID>` (AFTER mode).
- Access: signed in, NewQuip POC organisation, org owner/admin; otherwise 404.
- Reads (GET only): availability for SKU `NQ2886`; one Sale by SaleID.
- Shows: stock rows; pass/deviation/not-readable checks against section 6; an allow-listed Sale projection (numbers, statuses, SKUs, quantities, money, counts, and payload property **names** to reveal shape).
- Never shows or logs: credentials, customer or contact data, addresses, notes, attachments, raw API payloads.
- Temporary: removed from the branch after the proof, with its service-role allowlist entry.
