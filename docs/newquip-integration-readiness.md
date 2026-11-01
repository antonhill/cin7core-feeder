# NewQuip UAT stack - integration readiness (1 Nov 2026)

Status: READY FOR INTEGRATION REVIEW. Nothing here has been merged, deployed, migrated, or written to Cin7/Xero. Honest statuses apply: findings are "implemented, awaiting live UAT" until the owner confirms them live.

## 1. Heads (exact) and review state
| PR | Head | CI | Independent review of this head |
|---|---|---|---|
| #135 | 83d363e | green | no P0/P1 |
| #136 | 7c99453 | green | no P0/P1 (1 P2 open, below) |
| #137 | 7a73377 | green | no P0/P1 (2 P2, 3 P3 open) |
| #139 | c6a343c | green | df1eded reviewed: no P0/P1; c6a343c is docs-only (review P2s on the 0120 plan and the Cin7 plan) |
| #140 | c744fd3 | green | no P0/P1 |
| #141 | 180c434 | green | no P0/P1 |
| #142 (new) | e124366 | green | eee4394 reviewed: no P0/P1; e124366 is a 4-line P2 fix with a test and mutation proof, not re-reviewed |

Open P2s (none block merge): #136 a quantity typed on an EXCLUDED invoice line is dropped silently (owner decision: disable the input, or send it as before); #137 preview-staleness key omits some inputs (server recomputes on save); #142 no draft_hash compare-and-set on save, and Rep-only users still see mapping controls that the server will refuse; #139 concurrent approvals of two partial claims on one stage can race in the database trigger (pre-existing pattern).

## 2. Integration facts (trial merge, nothing pushed)
Trial branch `scratch/integration-trial` (local only) = main + #126 + #135 + #136 + #139 + #137 + #140 + #142 + #141 + #127 + #131.
- #126 merges into current main without conflict (20 commits behind, 75 ahead).
- Real conflicts, all small: `docs/newquip-uat-tracking.md` (keep both sides); #137 x #136/#139 in `ProjectWorkspace.tsx` (3 hunks: claim-selection state + preview-staleness key + the Preview/Save buttons - keep both, Save passes `previewedIds, previewedAmounts`, Preview also disabled when nothing is chosen); #137 x #140 in `Cin7SaleCreationPanel.tsx` (keep the `confirmed` checkbox and the reference-list state; drop the old `typed` state); #141 x #137 one import line.
- After resolving: `tsc` clean, ESLint 0 errors, `next build` OK, 4,099 tests pass, but only with three glue fixes needed ONLY when #131 is included: (1) `getCin7ReferenceOptionsAction` (#140) must pass `{ projectData: true }` to `requireModuleAccess` (#131's static guard); (2) a #131 test expects the pre-#135 Project-create message; (3) a #131 test has a Rep saving a mapped/priced draft, which #140/#142 now correctly refuse. #127 and #131 need no source conflict resolution.
- Migrations in the stack: 0114 (#126), 0118 (#127), 0119 (#131), 0120 (#139). None of #135-#137, #140-#142 needs a migration.

## 3. Recommended integration order (and why it minimises Production deploys)
Production only deploys from `main`. Merge the UAT PRs INTO the #126 branch first (each merge triggers a Preview build of that branch only), then merge #126 to main ONCE.
1. Owner finishes UAT on the current #126 Preview; #126 leaves draft.
2. Merge #135 into #126's branch. Retarget #136, #137, #140, #141 to it.
3. #136, then #139 (the pair is stacked).
4. #137 (resolve the 3+1 conflicts above), then #140, then #142, then #141 (one import conflict).
5. Owner UATs the combined #126 Preview once (it already carries the branch-scoped writes/demo/Resend/portal variables).
6. Merge #126 to main: ONE Production deploy. Writes stay OFF in Production by code, email is allowlisted outside Production.
7. #127 and #131 afterwards as a separate release (Rep isolation stays OFF; needs 0118/0119 and the glue above). Include them in step 4 only if the owner wants a single deploy and has UATed them.
Do not rebase #126/#127/#131; merge commits only.

## 4. Migration sequence (hosted `cin7toolbox` is shared by Preview AND Production code)
Hosted state read-only 1 Nov 2026: applied through 0117; 0114, 0118, 0119, 0120 are not applied.
1. 0114 (optional): only adds a SUPPRESSED status; code works without it (records ABANDONED with a marker). Apply any time after #126 is live.
2. 0120: independent of the others, additive and idempotent; needed ONLY to save a partial claim (full claims and old code are unaffected, a partial attempt before 0120 is refused before any row is written). Apply after #139 is in the deployed branch, with the pre/post checks in `docs/projects-poc/migration-plan-0120-partial-claims.md`, including the check that exactly one constraint matches the definition pattern.
3. 0118 then 0119 (0119 needs 0118; both with #127/#131): 0119 re-creates read policies on shared tables (dormant while the switch is OFF) - apply last, separately, with its own read-only preflight. Not needed for the UAT stack.

## 5. Combined integration Preview without touching Production
Yes. Preview deployments are built automatically per pushed branch and per PR; Production is main only. Facts verified read-only: crons run only on Production; Preview email is allowlist-restricted by code for every non-production deployment; Cin7 writes need `VERCEL_ENV=preview` AND `NEWQUIP_CIN7_WRITES_ENABLED=true` AND the Supabase wiring (the variable exists only on the `feature/newquip-completion` branch, so every other Preview has writes OFF); Demo Mode likewise needs its own variable. Therefore:
- Cheapest: merge into the #126 branch (section 3); its Preview has all the variables. Production unchanged.
- A new integration branch would build a Preview with writes OFF and Demo Mode OFF (safe, read-only UAT) but WITHOUT the Resend/portal/demo variables; adding those is a Preview environment change that needs owner approval (secrets are hidden and cannot be copied from here).
- Existing PR Previews (e.g. #139's) already run the stack's code with writes OFF and are the right place for the read-only Cin7 P0 checklist.
- A migration applied to the hosted database is visible to Production code at once; all four are backwards compatible.

## 6. Cin7 disposable-Sale test: read-only T0 preflight
(The plan's old "T0" is the Sale creation - a write. Here T0 = read-only preflight only; the Sale creation is proposed as T1.)

Verified from the Toolbox's synced copy of Cin7 and the hosted database (read-only; NO live Cin7 call was made from this session):
- Instance: organisation "NewQuip POC", Cin7 instance "NewQuip POC" (id 30eac8f2-d55c-486c-be70-a5f2d778a761), active, the only instance for that org; the instance pin in code targets this org. Other orgs' instances are separate rows.
- Environment: Cin7 writes are ON only on the `feature/newquip-completion` Preview (variable scoped to that branch); Production has no such variable and code forces OFF in Production. Supabase project pnzwjqjovxxdikxtfngq is the required one.
- Existing Sales that could be affected: SO-00023..SO-00026 are Toolbox-created Project Sales (customers "NQ P0 Test Customer" and "Spark"); SO-00019..22 are earlier tests. SO-00025 is mid-picking and SO-00026 shows partial pick/pack. Do not reuse or touch them. Posting rows: INV-00021 and INV-00033 are CREATED but not RECONCILED (read-back not completed) - reconcile them in the app before the test, they are not part of it.
- Stock: product NQ2886 is oversold (on hand 1,000, allocated 1,296, available -296): do NOT use it. Proposed SKUs `NQ1000` (SELF TAPPING SCREW M4X10) and `NQ1001` (WASHER M4): Stock type, FIFO, active, not assembly, not drop-ship, MSTR on hand 1,000 / allocated 0 / value R50,000 (the seeded placeholder pattern), referenced by NO sale, purchase, pick/pack or BOM line in the synced data (stock synced 1 Nov 2026 12:08 UTC).
- Customer: "NQ P0 Test Customer" exists (Active, Standard Rate Sales, revenue account 200, location MSTR) and already carries SO-00023..25. A dedicated "ZZ T1 TEST - DO NOT USE" customer created by the owner is cleaner (and is what the earlier runbook recommended); either is acceptable, owner chooses.
- Account/tax: revenue account `200` and tax rule "Standard Rate Sales" are what all five linked Project Sales used; whether Cin7 accepts them on an invoice charge for a NEW Sale is what T2 observes. Liability-account behaviour is untested (plan step T7).
- Xero: the Xero account reachable from this session has ONE connected organisation ("Spark Business Consulting (Pty) Ltd"). Whether the Cin7 NewQuip POC instance is linked to Xero cannot be determined from the Toolbox data or from here. UNKNOWN. This is a precondition (GO G1): owner checks Cin7 Settings > Integrations. DRAFT invoices should not sync; authorising an invoice (T3) and shipping stock (T6) may. Do not authorise or ship until the answer is known.
- Not done, needs the owner in a browser (read-only): run the Toolbox's own P0 checklist (live Cin7 reads: customer, SKU resolution, assembly check, stock, ExternalID pre-existence, environment) on an existing PR Preview with writes OFF. It deliberately FAILS on the #126 Preview because writes are ON there.

Rollback / stop: the only artefacts of T1 are one Sale (AUTHORISED, no invoice) and a stock allocation of 4 + 2 units; reversible by voiding the Sale in Cin7 (owner, UI). Stop and do not retry on: any invoice/fulfilment/stock movement present after T1; any total different from the table; `FAILED_UNCERTAIN`; any Xero message; a second Sale for the same ExternalID. Never repost; reconcile read-only first.

### Proposed T1 (one transaction; needs "GO T1" plus G1 answered)
Preconditions (owner/Toolbox, no Cin7 writes): the disposable Project prepared with the Toolbox's existing P0 disposable-project mechanism on hosted Supabase (a Toolbox data write, also needs its own OK): contract R10,000.00 ex VAT, VAT 15%, stages Deposit R4,000 / Delivery R5,500 / Installation R500; approved scope NQ1000 x4 and NQ1001 x2.
Transaction: on the #126 Preview, as a Manager, "Create Cin7 Sale" once, with the confirmation ticked:
| Field | Value |
|---|---|
| Sale type | Advanced Sale |
| Customer / location | chosen disposable customer / MSTR |
| Tax rule / revenue account | Standard Rate Sales / 200 |
| ExternalID | NEWQUIP-PROJECTS-SALE:<project ref> |
| Product lines | NQ1000 qty 4 @ R0.00; NQ1001 qty 2 @ R0.00 |
| Order Additional Charges | Deposit R4,000.00; Delivery R5,500.00; Installation R500.00 (ex VAT, 15% VAT) |
| Expected totals | ex VAT R10,000.00; VAT R1,500.00; total R11,500.00 |
Expected result (HYPOTHESIS until read back): order AUTHORISED; 0 invoices; nothing picked/packed/shipped; COGS 0; NQ1000 allocated 4 and NQ1001 allocated 2 (available 996/998); Toolbox state RECONCILED with the read-back verified.
Then STOP and report. T2 (deposit invoice, a second Cin7 write) is a separate GO.

## 7. Owner browser UAT checklist (21 implemented findings)
Legend - Code: the PR whose code must be on the Preview (the combined #126 Preview after step 5, or the PR's own Preview). 0120: migration 0120 applied. Cin7 R: needs live Cin7 read-only access. Cin7 W: needs a separately authorised Cin7 write (do NOT do these yet). Roles: Rep (REP only) / Est (Estimator) / Mgr (Manager/admin).
| UAT | Check | Code | 0120 | Cin7 R | Cin7 W | Role |
|---|---|---|---|---|---|---|
| 001 | An optional element (e.g. controller) can be mapped with the catalogue search; the line is no longer "unmapped" | #140 | - | - | - | Est/Mgr; a Rep is refused (#142) |
| 002 | A manual price needs a reason, shows "MANUAL QUOTATION PRICE - exceptional...", and records who/when after save | #140 | - | - | - | Est/Mgr |
| 003 | Editing a cost estimate shows an unsaved warning; saving clears it (not reproduced earlier) | #140 | - | - | - | Mgr |
| 004 | A saved cost override is the cost used on the margin sheet and carried to the Project | #140 | - | - | - | Mgr |
| 005 | A cost override reason without an amount is rejected; override inputs are always visible | #135 | - | - | - | Mgr |
| 006 | Double sign-off (two tabs/double click) is refused | #135 | - | - | - | Est |
| 008 | Only a Manager can create a Project from an accepted quote | #135 | - | - | - | Est (refused), Mgr (allowed) |
| 009 | Opening commitments panel is collapsed by default | #137 | - | - | - | Mgr |
| 010 | Location/Revenue account are pick lists from Cin7; liability/inactive accounts are not selectable; typed fallback works | #140 | - | yes | - | Mgr |
| 011 | The Create-Sale confirmation box starts unticked and the button stays disabled until ticked (do not create) | #137 | - | - | - | Mgr |
| 012 | Wording says "Sales Order"; recovery section is "Advanced / administrative recovery" | #137 | - | - | - | Mgr |
| 013 | Choose stages (none ticked by default); enter a partial amount below the maximum; preview; save draft; approve; remainder stays claimable; over-maximum, zero, negative are refused | #136+#139 | YES to save a partial | - | - (draft/approve are Toolbox-only; do not post) | Mgr (+ PM to submit) |
| 014 | After the project data changes, the preview says stale and offers Refresh; Save is disabled until refreshed | #137 | - | - | - | Mgr |
| 015 | Claim history reads as cards with status/next step | #141 | - | - | - | Mgr |
| 016 | A submitted claim shows no Recalculate/Submit | #135 | - | - | - | PM/Est |
| 017 | Cancel reads "Withdraw claim" and the awaiting role is named | #135 | - | - | - | PM/Est, Mgr |
| 018 | Approvals filters show chips and "Clear filters" resets them | #137 | - | - | - | Mgr |
| 021 | Tabs: Commercial / Claims, Deliveries, Products & Stock; milestone confirmation sits in the Commercial tab and loads itself | #141 | - | - | - | Mgr |
| 022 | A posted claim shows its Cin7 invoice number/status (e.g. INV-00032 DRAFT) and "Open in Approvals" for pending ones | #135 | - | - | - | Mgr |
| 023 | After Approve/Reject, the decision controls disappear at once and "Decision recorded" shows (use a TEST request) | #135 | - | - | - | Mgr |
| 024 | Invoice proposal: Select all eligible / Clear / per-line tick; the post button needs the proposal loaded (do not post) | #136 | - | yes (loads the proposal) | posting needs W | Mgr |
Also worth a browser pass (stack-wide, not a single finding): Rep trying to change a mapping on an existing quote is refused with a clear message; sign-off of a quote whose mapped product is inactive is blocked with the product named.
Not browser-testable yet: UAT-007 (owner Microsoft 365 message trace and quarantine, 07:04-07:08 UTC 1 Nov), UAT-019/020 (needs the disposable-Sale proof).

## 8. Remaining release blockers
1. #126 is still a draft and awaits the owner's own UAT; it is 20 commits behind main (clean merge).
2. Owner decisions: G1 (is Cin7 linked to Xero), GO per Cin7 step, apply 0120 (and 0114), the #136 excluded-line quantity behaviour, include #127/#131 in this release or not.
3. No UI has been exercised in a browser by the assistant; every status above is "implemented, awaiting live UAT".
4. Unreconciled postings INV-00021 and INV-00033 should be reconciled in the app.
5. Unproven Cin7 behaviours (fulfilment after invoice, populate vs charges, R0 lines on invoices, liability accounts) do not block the merge (Production writes stay OFF) but block enabling Production writes.
6. UAT-010 account class names from Cin7 are unverified live.
