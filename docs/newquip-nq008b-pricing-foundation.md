# NewQuip NQ-008B Phase 1: versioned Estimator pricing model (foundation)

Status: Phase 1, pure model + tests. Not wired into the quotation engine, no migration, no UI, no Cin7/Xero interaction.
Base: `feature/newquip-ux006-final-candidate` @ 67710c0 (NQ-008A candidate-accepted).

## What exists
`src/newquip/pricing/model/` (pure TypeScript, NewQuip-specific):

| File | Role |
| --- | --- |
| `types.ts` | **Inputs** only: rule version, supplier cost (supplier, currency, native cost, verification, source), freight/landed adjustment, FX quote, forward cover, item overrides, project markup change, project price adjustment. JSON-safe; a supplier workbook maps onto these shapes. |
| `money.ts` | Exact arithmetic: micro-unit integers, BigInt, half-up cents. |
| `rule-versions.ts` | Versioned commercial parameters as **data**. `legacy-poc-v1` (reads the existing 20% constant) is the default and the only selectable version; a `draft` fixture version is refused for quotations. |
| `calculate.ts` | **Calculation**: landed = native x rate x freight (+ add-on); price = landed x (1 + markup); overrides; separate project-adjustment line; markup % and gross margin % kept apart; missing/unverified/stale/unspecified costs reported, never zero. |
| `seal.ts` | Immutable original: deep-frozen copy + sha256 (the hash a Phase 2 append-only row will carry). |
| `compare.ts` | Original vs revised: per line, totals, margin/markup movement, basis changes, recorded reasons. |
| `access.ts` | **Presentation boundary + permissions**: customer-safe view built field by field; `canEnterPricingInputs` (Estimator/Manager AND cost visibility); server-owned who/when stamping. |
| `fixtures.ts` | Invented EUR/USD/ZAR fixture. Not NewQuip data. |

Layers: inputs (`types`) -> calculation (`calculate`) -> presentation/permission (`access`). Nothing in the calculation knows a role, a database or a screen.

## Selling-price completeness is separate from cost and margin completeness
There is deliberately no single "completeness". The result reports two things, so one can never stand in for the other:

| | meaning |
| --- | --- |
| `priceCompleteness` | `complete` every line has a price from confirmed inputs; `provisional` every line is priced but something it rests on is unconfirmed (unverified cost, stale rate, unspecified freight); `incomplete` at least one line has **no price**. |
| `costCompleteness` | `complete` every line's landed cost is known; `partial` some are not; `none` none are. |

Consequences (each is a test, see the combination matrix in `acceptance.test.ts`):
- A line whose supplier cost or rate is missing is **not priced** and is **never zero**. While any line is unpriced the result has **`totalExVatCents = null`**: there is no project total. The sum of the priced lines is exposed only as `pricedSubtotalCents`, labelled as a subtotal, so a quotation can never silently drop a line and look cheaper.
- A target-price adjustment is not applied until every line is priced; an amount adjustment is recorded but the total stays withheld.
- A price override can give a line a selling price where the cost is unknown: the price is then complete/provisional, the cost is `partial`, and **no margin** is shown (never a margin over a partial cost).
- `costCents` and `margin` exist only when the cost is complete (and the price is). `costsVerified` says whether every cost used is verified.
- The customer-safe view carries selling completeness, `pricedSubtotalCents`, and `totalExVatCents` (null while incomplete). It says nothing about cost completeness.
- A before/after comparison never compares a partial total with a whole one (`deltaTotalCents` is null; the priced-subtotal movement is reported separately).

## Rounding rule (exact)
Stated once in `money.ts`, tested in `rounding.test.ts`.
- Money is whole cents. Anything not already whole is rounded **half up** (ties away from zero) in exact BigInt arithmetic; quantities may have at most 3 decimals.
- A margin or markup **percentage** is rounded half up to **2 decimals**, in exact integers: 14.125% is **14.13%**, 14.124% is 14.12%, a loss of 14.125% is -14.13%. Percentages are display figures; nothing is recalculated from them.
- The shared Projects helper `marginFigures` is **unchanged**. It rounds in floating point and shows 14.125% as 14.12%. The model does not use it. A test pins both behaviours, so the 0.01 difference at exact ties is documented rather than accidental; away from ties the two agree (tested). Changing the Projects helper would need its own regression evidence and is out of scope.

## Rule versions and wiring
- The registry holds only versions a quotation may use (today: `legacy-poc-v1`). The development fixture version lives in `fixtures.ts`, is not in the registry and not exported from the index. `selectRuleVersion` has no option to allow a draft, and refuses one even if it were added.
- The model is completely **unwired**: a test fails if any file outside `src/newquip/pricing/model/` mentions it, or if anything but the model's tests imports the fixtures.

## Other guarantees (each is a test)
- Legacy rule version reproduces the POC price source SKU for SKU, to the cent (18 of 21 snapshot rows; the other 3 are zero-priced "supplier quote required" rows, which the model also never prices).
- The NQ-008A indicative snapshot hash and the existing engine's totals are pinned and unchanged; no existing NQ-008A / pricing / confirmation file was modified.
- The model imports no Cin7/Xero/Supabase/server/email code.
- A Rep-level view contains no cost, rate, supplier, freight, markup, margin, override reason or issue text.

## Not in Phase 1 (by design)
Persistence, server actions, Estimator workspace UI, selecting a non-legacy rule version, importing Sean's workbook, customer-document presentation of a project adjustment, role switcher, BOM enhancements.

## Migration plan (corrected, reconciled 2026-11-12; NO migration is authorised)
Reconciled read-only against the shared Supabase ledger (`list_migrations`, project pnzwjqjovxxdikxtfngq) and every `origin/*` branch.
- **Applied:** through 0113, 0115-0117 (NewQuip), **0121** (warehouse review), **0123** (NQ-008A indicative snapshots), **0124** (`purchase_receipt_key_includes_purchase`, the purchasing receipt-key repair, PR #205) and **0125** (`purchase_refresh_queue_and_guarded_replace`, PO freshness, PR #207).
- **In the repository but NOT applied:** 0114 (email suppressed status), 0118/0119 (Rep customer assignments / isolation, PRs #127/#131), 0120 (partial claim lines), 0122 (database-level Rep isolation, PR #196).
- **Reservations beyond 0125:** none found on any branch or PR. The earlier "0124" proposal in this PR was wrong: 0124 and 0125 belong to purchasing.
- **Therefore** the next unreserved number is **0126**, but it is *not reserved by this document*. At the start of Phase 2, with the owner's authorisation, the ledger and branches are reconciled again and one stream owner is named before a number is chosen. Whatever the number, the migration is additive and append-only (modelled on 0123), applied to the shared database only on explicit approval, after the unapplied 0114/0118/0119/0120/0122 questions are settled.

## Open commercial decisions (not invented here)
See the Phase 1 report: final markup(s) and whether they are per category, freight/landed method, forward-cover policy, approval thresholds for overrides/adjustments, rounding, how an adjustment appears to the customer, whether an unverified cost may reach a formal quotation.
