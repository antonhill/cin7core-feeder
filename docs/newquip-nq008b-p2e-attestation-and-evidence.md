# NewQuip NQ-008B P2-E: forward-cover rate attestation and pricing evidence for manual items

Status: built on branch `feature/newquip-nq008b-p2e-rate-attestation-manual-evidence`, stacked on PR #212. Not merged, not deployed. Migration 0126 is **amended in place** (it is not applied anywhere shared); the function signature is unchanged. Nothing here talks to Cin7 or Xero.

Owner instruction: (A) an independent forward-cover rate attestation, including contract reference, validity dates, evidence and reviewer identity, where a person cannot attest their own rate; (B) pricing evidence for SKU-less manual items (M75, LED, penning), with a recorded evidence note required before final approval. No physical SKU is invented, no price or formula is changed, there are no self-approval exceptions and no age-band percentages.

## A. Forward-cover rate attestation

* A forward-cover rate is the Estimator's own rate and replaces spot, so it has no market reference. It is **attested** only when an independent reviewer has checked it.
* Stored on `EstimatorPricing.forwardCover[currency].review` = `{ by, at, evidence, inputHash }`. **Server-owned**: the pricing form never submits it (`submissionFrom` strips it, the strict shape ignores it).
* `inputHash` binds the attestation to the currency, rate, cover days, contract reference, validity dates and reason. Any change to those drops the review on the next save (an unchanged rate keeps it, with its original who/when). Attribution and the review itself are not part of the hash.
* States: `missing`, `undocumented` (no contract reference, or no validity dates where the rule requires them), `unattested`, `attestation_outdated`, `self_attested`, `attested`.
* Rule data (`PricingRuleVersion.rateReview`): `{ reviewerRoles: ["manager"], requireIndependent: true }`. **The reviewer roles are provisional** (same as `costReview`); they are not NewQuip's final personnel assignment.
* `applyRateAttestation` refuses the whole request when the viewer lacks the role or cost visibility, entered or last changed the rate (case-insensitive), names an unknown currency, sends a stale hash, the rate lacks a contract reference or validity dates, or the evidence is not 3 to 500 characters. It bumps the revision, leaves the pricing date alone and reprices nothing.
* `pricingFinality`: a currency priced on a forward-cover rate that is not attested adds a reason that names the currency only (never the rate), with the standard "cannot be waived by the incomplete-costing exception" wording, alongside the existing expiry reason. **Spot rates are not attested** and keep the 24 hour freshness limit.
* Server: `attestEstimatorRates` (store) and `attestRates` (service) go through the same `persist()` and atomic `newquip_apply_pricing_revision` as every other pricing change; action `attestEstimatorRatesAction` audits `newquip.rate_attestation`. The workspace bundle exposes `rateAttestation: { canReview, reviewerRoles, attestableCurrencies }`; the panel shows each rate's state and an attest control for a permitted reviewer. The view stays cost-entitled only.
* Database (defence in depth): the independent-verification loop in `newquip_apply_pricing_revision` now also covers `forwardCover[currency].review` with the same four structural rules as cost reviews (existing rate only, unchanged rate, reviewer equals the recorded change-maker, reviewer differs from whoever entered it).

## B. Pricing evidence for SKU-less manual items

* `skuLessManualItems(budget)`: priced lines whose price the Estimator set by hand and that cost verification does not govern. M75 (`estimator_input`) and penning (`penning_rate`) always qualify: cost verification skips those lines entirely, whatever reference component SKUs the M75 line lists. A manual price resolution (`estimator_resolution`, for example LED lighting) qualifies only when it has no SKU of its own and no non-reference component SKU; a manual price on a SKU line is governed by cost verification (`manualPricedSkus`) instead.
* `EstimatorPricing.manualEvidence[itemKey]` = `{ note, reference?, by, at, priceHash }`. `priceHash` binds the evidence to the item key, its current unit price in cents and what priced it, so a later price change makes it **outdated** (states: `missing`, `recorded`, `outdated`).
* Recorded through the dedicated `recordManualPriceEvidenceAction(quoteId, items[{ itemKey, note, reference? }])`. The server evaluates the budget itself and computes the hash; a client hash, `by` or `at` is never read. The note is 10 to 500 characters, the reference at most 100, keys must be current SKU-less items (reserved keys refused), at most 100 items per request. Allowed for an Estimator or Manager with cost visibility. One immutable revision through the atomic function; no price changes. Audit action `newquip.manual_price_evidence`.
* `pricingFinality` adds a reason per item with missing or outdated evidence, naming the item label only (never a price), with the same non-waivable wording, so the incomplete-costing exception cannot waive it.
* Server-owned: a client draft can never write `manualEvidence` (`keepServerOwnedPricing` discards the submitted pricing wholesale); a pricing save carries stored evidence over untouched.
* The Manager sees the note, who recorded it and when, and the state at approval, in a read-only panel on Stages 2 and 3, from `QuoteView.manualPriceEvidence`. That field is built only for cost-entitled viewers and only while supplier pricing is on; a Rep's payload never carries it, and `redactInternalFinancials` strips `estimator.pricing` (including evidence and rate attestations) from the quote record and the accepted baseline for a Rep.
* **Opt-in**: evidence is part of supplier pricing. While `estimator.pricing` is not enabled nothing changes (legacy POC behaviour and hashes are untouched).
* DB: `manualEvidence` lives inside `estimator.pricing`, so the existing only-pricing-differs proof covers it; no new table.

## Provisional / deliberately not decided

* The reviewer roles for both reviews (`costReview`, `rateReview`) are provisional.
* The evidence note is free text; NewQuip has not said what evidence an M75, LED or penning price must rest on, so nothing is validated beyond length.

## Explicitly NOT built

* No age-band percentages or any age-based cost allowance.
* No historical-cost allowances.
* No day-to-day (non-project) quoting changes.
* No supplier price-list automation or import.
* No change to any price, formula or markup; no invented SKUs.
* No Cin7 or Xero write.

## Tests

`estimator/__tests__/attestation.test.ts`, `manual-evidence.test.ts` (pure, including ownership and Rep/customer leak checks), `lib/newquip-quotes/__tests__/rate-attestation-and-evidence.test.ts` (store, FakeDb emulating 0123 and 0126), and the panel/approval cases in `app/newquip-grower/__tests__/estimator-pricing-panel.ui.test.tsx`. The FakeDb emulation of 0126 does not replay the new SQL structural checks; they are reviewed by reading, and need a database run when 0126 is applied.
