# NewQuip owner UAT tracking (1 November 2026)

Single tracking document for UAT-001 to UAT-024. Statuses: FIXED AND VERIFIED, IMPLEMENTED AWAITING LIVE UAT, INVESTIGATION COMPLETE DECISION NEEDED,
BLOCKED BY EXTERNAL INTEGRATION, DEFERRED WITH REASON, plus NOT STARTED (work not yet begun; not a completion claim).

"FIXED AND VERIFIED" is reserved for findings the owner has confirmed live. Code plus tests is at most IMPLEMENTED, AWAITING LIVE UAT.

| ID | Finding | Status | Where | Evidence |
|---|---|---|---|---|
| UAT-001 | Additional element product mapping | IMPLEMENTED, AWAITING LIVE UAT | PR-E | The seven optional elements had no matcher so could never be mapped. Searchable Cin7 catalogue chooser (Estimator/Manager), SKU verified server-side (exists, active, this org) on every save; unpriced SKUs still need an explicit manual price; 7 tests + 4 mutations |
| UAT-002 | POC selling-price overrides | IMPLEMENTED, AWAITING LIVE UAT | PR-E | Manual price relabelled MANUAL QUOTATION PRICE (exceptional); server-stamped by/at, Estimator/Manager only, frozen in baseline, shown to approvers; POC wording about the price SOURCE kept because the source is not ready; 3 tests + 3 mutations |
| UAT-003 | Exclusion recalculation feedback | IMPLEMENTED, AWAITING LIVE UAT (not reproduced) | PR-E | The quote totals already recalculated live while unsaved; the saved-draft-based Cin7 cost estimate did not. Banner now says so and the cost panel shows an unsaved warning. Not reproduced live |
| UAT-004 | Cost override and Procurement | IMPLEMENTED (verification + docs), AWAITING LIVE UAT | PR-E | Carry-through proved by test (override -> frozen sheet -> Project budget input, incomplete sheet gives no cost); Procurement targets already role-gated and read-only; relationships documented in docs/projects-poc/cost-and-pricing-provenance.md |
| UAT-005 | Cost override inputs disappear | IMPLEMENTED, AWAITING LIVE UAT | PR-A | `previewCostOverrides`; reason-without-amount no longer becomes a R0 override (found by independent review); 5 tests; mutations killed |
| UAT-006 | Estimator sign-off button persists | IMPLEMENTED, AWAITING LIVE UAT | PR-A | completed state in UI; server refuses a second sign-off, atomic `is null` guard; test + mutation |
| UAT-007 | Customer emails missing from Outlook | INVESTIGATION COMPLETE, DECISION NEEDED | - | Both sends recorded ACCEPTED with Resend IDs (07:04:08Z first send, 07:07:04Z deliberate re-send, rep@ as sender, [PREVIEW] subject). Application side is consistent; not a sending-code defect on this evidence. Toolbox notifications from the same sender domain DID reach the mailbox (07:00, 07:16Z), and the Junk folder holds neither quote email, so the loss is specific to the customer-quote message (likely tenant quarantine / anti-spoof or attachment policy). Owner check: Microsoft 365 Message trace + Quarantine for 07:04-07:08Z. No emails sent. |
| UAT-008 | Create Project visible to Reps | IMPLEMENTED, AWAITING LIVE UAT | PR-A | server requires Manager (`PROJECT_CREATE_ROLES`); UI hides control; mutation killed |
| UAT-009 | Opening Commitments collapsed | IMPLEMENTED, AWAITING LIVE UAT | PR-C | collapsed by default with a compact summary and 'Add Opening Commitments'; calculations and freeze rules untouched; source-level test only |
| UAT-010 | Cin7 location/account dropdowns | IMPLEMENTED, AWAITING LIVE UAT (class names unverified live) | PR-E | Read-only lookup behind a new read-only adapter; only active revenue accounts selectable; liability/balance-sheet accounts listed but locked pending proof T7; typed fallback kept; live Cin7 class names could not be observed here |
| UAT-011 | Cin7 Sale confirmation friction | IMPLEMENTED, AWAITING LIVE UAT | PR-C | unchecked confirmation checkbox replaces the typed phrase; server token, writes flag, instance pin and one-Sale rule unchanged; mutation killed |
| UAT-012 | Confusing Cin7 Sale wording | IMPLEMENTED, AWAITING LIVE UAT | PR-C | 'Sales Order' wording and a linked-order summary; attach-existing stays inside the admin-only 'Advanced / administrative recovery' section with its validation |
| UAT-013 | Selective progress claims | IMPLEMENTED, AWAITING LIVE UAT (migration 0120 NOT applied) | PR-B (#136) + PR-D | Stage selection (#136) and partial amounts (PR-D): engine/store/actions/UI, migration 0120 + SQL test (runs in CI only; no local Postgres), 14 financial tests, 8 mutations killed. Partial claims need 0120 applied before they can be saved; full claims work without it. Plan: docs/projects-poc/migration-plan-0120-partial-claims.md |
| UAT-014 | Preview Claim button | IMPLEMENTED, AWAITING LIVE UAT | PR-C | 'Refresh preview' when stale, disabled when current, Save disabled while stale; preview stays read-only; 2 tests + mutation |
| UAT-015 | Claim History redesign | IMPLEMENTED, AWAITING LIVE UAT | PR-F | Responsive claim cards: reference, approval state, total with ex VAT/VAT, Cin7 status + invoice, plain next-step line, the existing role/state action plan, approval history in a disclosure; layout verified by source-level tests only (no browser run) |
| UAT-016 | Claim actions after submission | IMPLEMENTED, AWAITING LIVE UAT | PR-A | no Recalculate/Submit when submitted (UI + server); Cancel relabelled "Withdraw claim"; 2 existing tests moved to the controlled return-to-draft path |
| UAT-017 | Manager approval navigation | IMPLEMENTED, AWAITING LIVE UAT | PR-A | "Open in Approvals" link; waiting text names the real stage role |
| UAT-018 | Approval filters | IMPLEMENTED, AWAITING LIVE UAT | PR-C | active-filter chips (including the default Pending status) and Clear filters; 3 tests + mutation |
| UAT-019/020 | Cin7 billing vs fulfilment | INVESTIGATION COMPLETE, DECISION NEEDED | PR-B (doc only) | `docs/projects-poc/uat-019-020-cin7-billing-vs-fulfilment.md`: code supports the required sequences; Cin7 behaviour for fulfilment after invoicing and bulk population is UNPROVEN; controlled proof proposed, not run |
| UAT-021 | Simplify Project operations layout | IMPLEMENTED, AWAITING LIVE UAT | PR-F | Commercial / Claims (with milestone confirmation), Deliveries (logistics plan only) and Products & Stock; no business logic changed; statements that a plan moves no stock and milestones are independent of physical delivery; source-level tests only |
| UAT-022 | Incorrect Cin7 claim status | IMPLEMENTED, AWAITING LIVE UAT | PR-A | root cause: history read legacy `project_cin7_links` (0 rows); now reads `project_claim_cin7_postings` (C01 = RECONCILED, INV-00032, DRAFT); 4 tests; mutation killed |
| UAT-023 | Administrator override approval UI | IMPLEMENTED, AWAITING LIVE UAT | PR-A | root cause by code reading (database closes the request atomically; page relied on a reload); decided state applied immediately; decision panel with approver, time, override reason; not reproduced live |
| UAT-024 | Bulk product selection | IMPLEMENTED, AWAITING LIVE UAT | PR-B | select all eligible / per-SKU / populate / clear / selected only; unknown & excluded lines unselectable; 3 mutations killed; charges untouched |

## PR-A: Priority 1 defects and permissions (this branch)

Branch `fix/newquip-uat-p1-defects`, based on `feature/newquip-completion` (#126 head `30e9ea6`).
No migrations. No Cin7 or Xero writes. No emails.

## Integration-readiness addendum: product-mapping safeguards (security/newquip-mapping-integrity)

Closes the two gaps left open on PR #140:

| Gap | Change |
|---|---|
| Non-optional mappings (pvc_door and the source-backed items) could be changed by a Rep through a direct save | `sanitiseSubmittedDraft` now treats a change to ANY item mapping (add / change / remove) as Estimator/Manager authority, on create and on save. Unknown slots are dropped. Non-optional items must equal their source-backed SKU (the feeder follows its variant); pvc_door and the optional elements are the estimator's choice. |
| Mapping integrity was checked only when the draft was saved | `estimatorSignOff` re-verifies EVERY mapped SKU against this organisation's synced catalogue (exists, active, source-backed) before stamping the sign-off; failure stamps nothing. |

Also: a save now verifies only NEW or CHANGED mappings, so a SKU that later goes inactive no longer blocks unrelated edits (it blocks sign-off instead, which is the right place). Manager approval and approved baselines are untouched (approval never calls the check; approved quotations stay immutable).

Read-only hosted check (1 Nov 2026): the six source-backed / default SKUs are active in the NewQuip POC catalogue and every mapping on the four in-flight REP_DRAFT quotes resolves, so existing quotes will pass sign-off.
Operational note: sign-off now depends on the Cin7 product sync having run; a missing or inactive mapped product blocks sign-off until it is remapped by an Estimator/Manager.
