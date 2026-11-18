# NewQuip NQ-008B Phase 2: PR sequence and safe connected-Preview test plan

Status: proposal for owner review. Nothing here is merged, deployed or applied. All PRs are draft and stacked on the NQ-008A candidate (`feature/newquip-ux006-final-candidate`), never `main`.

## PR sequence (focused, stacked, each independently reviewable)
| PR | Branch | Scope | Migration |
| --- | --- | --- | --- |
| #208 (merged into the candidate) | `feature/newquip-nq008b-pricing-foundation` | Phase 1 pure model | none |
| P2-A | `feature/newquip-nq008b-p2a-draft-integration` | Opt-in `estimator.pricing` on the draft; model as a `PriceSource`; missing SKU = not priced; unverified = indicative only (not waivable); target adjustment internal; redaction; ownership | none |
| P2-B | `feature/newquip-nq008b-p2b-pricing-revisions` | Immutable revisions, atomic apply function, server actions, service, workspace view-model | **0126 (written, NOT applied)** |
| P2-C | `feature/newquip-nq008b-p2c-estimator-workspace` | Estimator pricing workspace UI | none |
| P2-D | `docs/newquip-nq008b-p2d-preview-plan` | This document | none |

Merge order if approved: A, B, C (each into the candidate after the previous), D any time. The migration is applied only after B is approved and only on explicit instruction.

## Migration ownership (reconciled 2026-11-12)
- **Owner:** the NQ-008B pricing stream (`feature/newquip-nq008b-p2b-pricing-revisions`). One stream, one migration.
- **Ledger:** last applied on the shared Supabase project is 0125 (`purchase_refresh_queue_and_guarded_replace`); 0123 and 0124 are applied. Unapplied in the repository: 0114, 0118, 0119, 0120, 0122. No branch or open PR holds 0126 or higher.
- **Rule:** the number is re-verified against the live ledger and every branch immediately before applying. If anything claimed 0126 the file is renumbered, never merged on top.
- The application fails closed without the migration ("pricing revisions are not available yet"): no pricing is ever changed without its revision.

## What was deliberately NOT built
Customer-facing presentation of a project adjustment (decision 3: deferred), any exception that lets unverified costs reach final approval (decision 2: none), a non-legacy rule version (none exists; the registry holds only `legacy-poc-v1`), importing Sean's workbook, any Cin7/Xero write, any change to the existing POC calculation, approval flow or Projects. Quantity changes keep using the existing quantity overrides (with their reasons); they are not duplicated.

## Safe connected-Preview test plan
**Principle:** never test on a connected quotation. Today's Preview shares the Production Supabase and treats `NEWQUIP_CIN7_WRITES_ENABLED` as ON, so the plan uses an isolated database and switches writes off.

### 0. Preconditions (each needs the owner's explicit approval; none is done)
1. A disposable Supabase **branch database** from Production's schema (not the shared project), with 0123 and 0126 applied there only. (Known gotchas, from earlier rounds: the branch must exist before Vercel overrides are set; the branch DB lacks some grants; confirmations expire.)
2. Vercel **Preview** environment overrides for the P2 branch only: the branch Supabase URL/keys, and `NEWQUIP_CIN7_WRITES_ENABLED=false`. Verify by listing the variable (Vercel CLI needs `--project`).
3. A disposable NewQuip organisation / test members (Rep, Estimator, Manager) on that branch DB. Fixture quotation only (the synthetic Grower House); **no connected quotation, no Cin7 customer, no product import**. Email policy: recipients limited to the allowlist.
4. The owner performs the OTP logins; evidence is captured by read-only SQL on the branch DB.

### 1. Walk-through (expected result in brackets)
1. **Rep:** create a project quotation, complete the configuration, confirm the amount, hand off. [snapshot 1 written; state ESTIMATOR_REVIEW; Rep sees no supplier pricing anywhere.]
2. **Rep (negative):** open the quotation; the Costs step shows no supplier-pricing panel; `getEstimatorPricingAction` as the Rep is refused. [no cost leaves the server]
3. **Estimator:** open Costs > Supplier pricing. [Off; POC prices unchanged.] Enter EUR, USD and ZAR supplier costs for every SKU, **unverified**, with a EUR and USD spot rate; give a reason; save. [Revision 1; total equals the POC total when the inputs are equivalent; panel says "indicative only"; the customer total did not change so the Rep's confirmation stands.]
4. **Estimator:** try Sign off. [Refused: unverified supplier cost, not waivable by the incomplete-costing exception.]
5. **Estimator:** set a **90-day forward-cover** rate on EUR with a reason; save. [Revision 2; EUR prices fall; the customer total changed, so the Rep's confirmation is withdrawn and the quotation is back with the Rep; snapshot 1 byte-identical.]
6. **Rep:** reconfirm the new amount, hand off. [snapshot 2; the original is still visible to the Estimator.]
7. **Estimator:** apply a single SKU price override with a reason; change the project markup with a reason; record an internal target price. [Prices move for the first two; the target is shown as "would adjust by ... not applied" and does not move the total.]
8. **Estimator:** delete one SKU's supplier cost and save. [That SKU is NOT priced, no project total, readiness BLOCKED, nothing is R0.] Restore it.
9. **Estimator:** mark every cost **verified**, save, sign off. [Allowed.] **Manager:** approve. [Baseline sealed with the pricing; frozen.]
10. **Everyone:** try to change pricing on the approved quotation. [Refused.]
11. **Read-only SQL on the branch DB:** `newquip_pricing_revisions` has seq 1..n with who/when/why/rule version/previous/new; an UPDATE or DELETE on it is refused; `newquip_indicative_price_snapshots` rows 1 and 2 unchanged.
12. **Cin7:** confirm no Cin7 sale/posting rows or calls were created by any step above (writes are off; the pricing code has no Cin7 import).

### 2. Exit criteria
All 12 steps behave as bracketed; no supplier cost, rate, freight, markup or margin visible to a Rep or in any customer document; the legacy quotation created in step 1 before enabling is priced identically to before; CI green on the exact heads.

### 3. Rollback
Pricing: switch off on the quotation (a recorded revision) to return to POC prices. Migration (branch DB only): `drop function newquip_apply_pricing_revision(...)`, `drop table newquip_pricing_revisions cascade` as written in the migration header. No Production change is involved.

## Open items for NewQuip (unchanged by this work)
Final markup(s) and whether per category; freight/landed method; forward-cover policy and who may set it; approval thresholds for overrides and adjustments; exchange-rate source/age; customer presentation of project adjustments (deferred); whether Sean's workbook becomes the source of supplier cost (importer to be written against `SkuPricingInput`).

## Hardening round (after the isolated test; owner review 2026-11-12)
Everything below is in PR #212 on top of #209-#211, and none of it is merged or applied.

1. **Independent cost verification.** There is no "verified" flag. A supplier cost is verified only by an independent review: a different person from whoever entered or last changed that cost, holding a reviewer role, able to see costs, who names the evidence, and who submits the hash of the exact cost they saw. Any change to the cost drops its review; a reviewer who edits a cost cannot verify it; holding the reviewer role as well never lets someone verify what they entered. One immutable revision per verification (who, when, evidence, which cost). The reviewer roles and independence are rule-version data and PROVISIONAL (`manager`): they are not NewQuip's final personnel assignment. The same rule is enforced structurally inside the database function as defence in depth.
2. **Rate freshness.** Spot rates expire after a configurable number of hours (PROPOSED default 24, subject to NewQuip's confirmation). A forward-cover rate is documented: contract reference plus start and end dates (real calendar dates, at most 366 days). An expired, not-yet-valid or undocumented rate fails safe: the line is not priced, never priced at an older rate or at zero. Freshness is also a gate at sign-off and approval, judged at that moment. Evaluation is deterministic (it uses the stored pricing date), so nothing is ever repriced silently: saving a new rate is what reprices, as an attributed revision.
3. **Manual prices.** A manually entered selling price (a manual resolution or a SKU price override) never conceals a missing or unverified supplier cost. The workspace reports price completeness and cost verification separately, and sign-off and approval are blocked until the required costs are recorded and independently verified. The incomplete-costing exception does not waive this.
4. **UX.** Exchange-rate fields appear as soon as a SKU has a foreign currency. "Clear supplier cost" removes an input; a zero cost is refused and a blank field is ignored.

### Merge and migration sequence (recommended)
1. Merge #209, #210, #211, then #212 into the candidate branch, in that order, each only after exact-head CI (never into `main`).
2. Before any migration: re-reconcile the shared ledger against every branch and open PR. Migration 0126 (revisions table + atomic function, as amended in this round) is the single migration of this stream.
3. Apply 0126 to the shared database only on explicit instruction, after the owner decisions below.
4. Connected acceptance (not before 0126): an Estimator/Manager walk-through on the connected candidate Preview with a NEW fixture quotation, normal sign-in, and customer-data access checked, as listed in the isolated plan above.

### Owner decisions still needed
- Who are the authorised cost reviewers (Sean? one role? named people?). Today: the `manager` role, provisional.
- Confirm 24 hours for spot rates, and whether freshness should also be judged at sign-off/approval (as built) or only when entered.
- Should the reviewer also attest the exchange rate? Today the rate and its time are entered by the Estimator and are not independently reviewed.
- Should a manual selling price on a line with NO supplier SKU (for example the LED light, M75, penning) also require a recorded supplier quote? Today those stay under the existing Manager baseline-exception rules.

### Proposed follow-up migration (NOT written as a file, NOT applied, NOT authorised): member read access to quotations
Tenant isolation holds. But any member of the organisation, including a Rep, can read `newquip_quotes.draft` and `accepted_baseline` directly through the database API with their own session; those contain the supplier pricing inputs and the internal margin. The application hides them in its server layer only. The NewQuip app reads quotations through the service role, so the proposal is to revoke members' table-level SELECT on `newquip_quotes` and grant column-level SELECT on the non-confidential columns only (or none). This needs its own migration number (not 0126), the existing RLS test matrix updated, and a check that nothing relies on member reads. It predates this work (the internal margin was already exposed) but supplier costs make it more important to close before the trial.
