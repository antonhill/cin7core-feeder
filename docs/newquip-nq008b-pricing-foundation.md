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

## Guarantees (each is a test)
- Legacy rule version reproduces the POC price source SKU for SKU, to the cent (18 of 21 snapshot rows; the other 3 are zero-priced "supplier quote required" rows, which the model also never prices).
- NQ-008A snapshot hash and the existing engine's totals are pinned and unchanged; no existing file was modified.
- Nothing outside the model imports it; it imports no Cin7/Xero/Supabase/server/email code.
- A Rep-level view contains no cost, rate, supplier, freight, markup, margin, override reason or issue text.

## Not in Phase 1 (by design)
Persistence (proposed migration 0124: append-only `newquip_pricing_versions` + sealed revisions, modelled on 0123), server actions, Estimator workspace UI, selecting a non-legacy rule version for a real quotation, importing Sean's workbook, customer-document presentation of a project adjustment, role switcher, BOM enhancements.

## Open commercial decisions (not invented here)
See the Phase 1 report: final markup(s) and whether they are per category, freight/landed method, forward-cover policy, approval thresholds for overrides/adjustments, rounding, how an adjustment appears to the customer, whether an unverified cost may reach a formal quotation.

## Known note
The shared `marginFigures` helper rounds an exact half (14.125%) to 14.12 because it rounds in floating point. Display only; not changed here (shared with Projects).
