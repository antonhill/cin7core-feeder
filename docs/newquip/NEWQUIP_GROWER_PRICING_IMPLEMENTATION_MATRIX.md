# NewQuip Grower Budget Pricing: implementation and acceptance matrix

Baseline: the NewQuip Grower Pricing Handoff of 2026-11-25 (latest NewQuip replies). That document holds NewQuip's detailed supplier costs and is deliberately NOT in this repository or its history; this matrix carries no cost figure. Compared on 2026-11-25 against the UAT candidate `feature/newquip-ux006-final-candidate` at `d3d5695`.
Rules applied: no cost, price, mapping or SKU is invented; a cost conflict is never resolved automatically; an open decision stays visibly provisional or blocked; the Cin7 posting path and the Rep → Estimator → Manager workflow are untouched.

Status key: **DONE** implemented and tested in this PR · **EXISTS** already correct in the engine · **PARTIAL** part done, remainder named · **BLOCKED** needs a NewQuip / owner decision · **NOT STARTED** confirmed but needs an owner-approved cross-cutting change first.

## 1. Engine facts the handoff must fit
| Fact | Where |
|---|---|
| A Budget line is a single SKU or a **fixed-quantity package** (each component × a fixed quantity per unit). Components are costed from live Cin7 supplier cost, aged by the owner-approved age bands, converted at fresh FX, then freight and **one** project markup (20% in the UAT settings). | `commercial.ts`, `auto-pricing-service.ts`, `cost-escalation.ts` |
| A package can be **layout-driven** (quantity depends on a length) only as a reference: the engine never prices it automatically. | `PackageComponent.quantityStatus` |
| A package that carries an open question (`estimatorConfirmation`) is priced **provisionally** in the Budget and still needs the Estimator's sign-off at hand-off. | `provisionalPackageBasis` |
| Quotations are evaluated against the template revision they were created under. Original (`grower-2026-10`) quotations keep their original definitions. | `commercialMappingFor` |
| There is no Cin7 **assembly / BOM-sum** cost path, no per-item markup rule, and no **GRV-age-banded markup**. | none |

## 2. Matrix
| # | Handoff requirement | Existing implementation | Status | What this PR does / what blocks it |
|---|---|---|---|---|
| 1a | PVC door `NQ3444` (2.1×1.2) BOM `KNQ199`+`NQ3845`+`NQ3846` | Door is manual selection; offered list `NQ3444, NQ2161, NQ2281`; unpriced unless the Estimator maps and costs it. Budget register is empty. | **BLOCKED** | The calculated BOM total and the last stock-adjustment cost differ materially and are **not reconciled**; Shirnel must approve the cost basis; `NQ3845/3846` may rise in 2027. A BOM-sum cost path does not exist. Door stays explicitly unpriced. |
| 1b | `NQ3444-B` (2.1×1.0) BOM `KNQ086`+`NQ3845`+`NQ3846` | Not in the offered list | **BLOCKED** | Same decision. Adding `NQ3444-B` to the manual list is safe once the cost basis is approved. |
| 2 | THOMAS CL1 `HO05084000` (no panel) / `HO05084007` (with panel), EUR, one per room | `controller` unmapped; no cost in Cin7 on 18 Nov | **BLOCKED** | Variant rule and duplicate-panel prevention not decided; EUR costs and date not supplied. Live Cin7 cost must be read first. |
| 3 | THOMAS BF `HO05084507`, one per room, current Cin7 cost + mark-up | `silo_weighing` unmapped (package undefined) | **PARTIAL / NOT STARTED** | Confirmed. Needs a live read-only Cin7 check (value, date, currency), then a single-SKU mapping and an approved Budget register entry. Not done: the register entry needs a named approver and an external approval record. |
| 4 | CL1 / BF panels: interim Budget amount (one figure if both are present, a lower one if only one) | `control_panel` unpriced; Rep/Estimator manual entry exists | **BLOCKED** | Selling price or cost? ex/incl VAT? consumables? Until answered no automatic mark-up and no auto price. Manual entry stays available. |
| 5 | Emergency windows `ERT003` + shared `HO08990730`/`HO08020800` (1 per 2 windows) | Unmapped | **BLOCKED** | Rounding of odd counts, scope of "per two windows", and the original 11-line BOM screenshot are missing. |
| 6 | Sumpless pad cooling, 33-line BOM, length formulas, >20 m plumbing ×2 | Unmapped; no length input | **PARTIAL** | **DONE:** `cooling-bom.ts`, a pure, tested calculator (12 m example reproduced exactly; 20 m / 20.01 m boundary; rods, nuts, washers, pads, middle kits; fractions rounded up; `KNQCOOL16` counted once). **NOT STARTED:** wiring into a quotation needs a system-length input on the draft and a package kind the engine can price (a draft-schema and engine change; CLAUDE.md principle 10: report first). Labour days, travel, food and accommodation are manual and no rate was supplied. **Open readings** (returned by the function): over 20 m plumbing is doubled before rounding (acetone/Sikaflex 1.5 → 3); `KNQCOOL16` not doubled; no supported minimum length. |
| 7 | 57" fan `MUG4D14A1M10238`, last GRV cost + 15% (<1 yr) / 20% (>1 yr) | Unmapped (an earlier note named `MUC4D14A3M10238`, a different code) | **BLOCKED** | The engine already adds age **escalation** bands plus a **project markup**; a separate 15/20% GRV-age markup would double count. Which rule governs, and whether Cin7 `LastSupplied` is a true GRV date (it may be a data-load date), must be settled first. Quantity stays manual. |
| 8 | 250 mm manure plug `MNQ048` = `MNQ039`+`MNQ040`+`MNQ041`, Rep enters quantity | Unmapped (no BOM) | **DONE** | New package in the **current** template only (original template stays unmapped). Priced from current Cin7 component costs when all three have one; missing cost → not priced. Carries the standard Estimator sign-off, so it appears as Provisional in the Budget. |
| 9 | Cup drinker: seven-part BOM confirmed, **not** `NB3542-03`; customer text "Sow Cup Drinker Including Mounting Material" | Seven parts already the composition; `NB3542-03` held as an open alternative; provisional | **DONE** | On the current template the `NB3542-03` question is closed and the customer description is "Sow Cup Drinker Including Mounting Material". Still provisional until the Estimator signs off (workflow baseline preserved). Original template unchanged. |
| 10 | LED `HNQ7046` ×1, `HNQ7093` ×3, `HNQ7088` ×1; family FERAX, not FORTIS | SKUs and quantities already match | **PARTIAL / BLOCKED (name)** | The FORTIS-naming question is closed in the package notes. **The FERAX customer name is held:** the existing Rep-safe document guard forbids that brand in Rep-facing Budget documents. Owner must decide whether FERAX may appear to customers before the label changes. |
| 11 | Preserve quote → estimator → manager → project → Cin7 Advanced Sale, claims, invoices | Intact | **EXISTS** | Full test suite green; no workflow, posting or schema code changed. |
| 12 | "Not for Commercial Use" watermark, PDF, email, hand-off | Exists (Budget document, UAT) | **EXISTS** | Re-verify in UAT on the deployed SHA. |
| 13 | Cost provenance (source, timestamp, SKU, currency, approval) | Stored per SKU in the pricing record and the Budget basis register | **EXISTS** | No change. |
| 14 | Approved BOM cost ≠ approved selling price | Engine separates cost, freight, markup | **EXISTS** | No change. |

## 3. Commercially unapproved (blocks a "ready" claim)
1. Door cost basis (calculated BOM total vs the last stock-adjustment cost), approved by Shirnel. 2. CL1 variant rule, EUR costs and date. 3. BF final calculation path. 4. Panel interim amounts (R-figures are in the handoff): cost or selling, VAT, consumables. 5. Emergency-window quantity rules. 6. Cooling: >20 m doubling reading, `KNQCOOL16`, labour rate, days and travel. 7. Fan: GRV-age markup vs existing escalation, true GRV date, correct SKU. 8. FERAX as a customer-facing brand. 9. A named approver and external approval record for any Budget register entry (the register ships empty).

## 4. Acceptance checks
| Check | Result |
|---|---|
| `npm test` (full suite) | **PASS: 514 files, 6,991 tests** |
| `tsc --noEmit` | PASS |
| `eslint src/newquip src/app/newquip-grower` | 0 errors (41 pre-existing warnings) |
| `git diff --check` | PASS |
| Cooling 12 m / 20 m / 20.01 m / 25 m scenarios | PASS (unit) |
| Manure plug priced, missing-cost not priced, original template unchanged | PASS (unit) |
| Original-template quotations unchanged (cup drinker, LED, plug) | PASS (unit) |
| Connected UAT: Rep → Estimator → Manager → Rep, PDF, handoff, one browser | **NOT RUN** (needs PR deploy to newquip-uat and OTP sign-ins) |
| Live Cin7 read of the new SKUs' costs and dates | **NOT RUN** (read-only; needs the diagnostic gate on UAT) |
