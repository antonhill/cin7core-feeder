# NewQuip POC: end-to-end demo proof and operational readiness

Prepared 1 November 2026 against `feature/newquip-completion` (#126) at `4df1876`. Read-only evidence from the hosted database (project `pnzwjq…`) and local fixtures.
Nothing in this document was produced by a Cin7, Xero or email write. **No scenario is called proven without a record behind it.**

## How to read the labels

| Label | Meaning |
|---|---|
| PASS (live record) | The hosted database holds the records that show it, from real owner UAT activity. Cin7 itself was not re-read for this document. |
| PASS (local fixture) | Proven by a reproducible test against in-memory fakes (`src/lib/projects/__tests__/poc-scenarios.test.ts`). Shows what the Toolbox does with the Cin7 responses it is given, not how Cin7 behaves. |
| BLOCKED BY EXTERNAL PROOF | Needs Cin7 behaviour that has not been observed under control. Needs the owner's separate GO. |
| REQUIRES OWNER DECISION / ACTION | Waiting on the owner. |

"Observed, uncontrolled" means the sequence happened during UAT but was not run as a controlled test, so cause and ordering are inferred, not read.

## 1. Release state (preflight, 1 Nov 2026)

| Item | State |
|---|---|
| `main` | `6a4e72b` (RWTSA #147 deployed to Production 21:35 SAST; unrelated to NewQuip). #126 is 123 commits ahead of and 36 behind `main`. |
| #126 | head `4df1876`, OPEN, **draft**, base `main`, CI green (build/lint/test, migration + RLS matrix, dependency scan, secret scan), Preview READY. |
| #127 (Rep assignments, migration 0118) | OPEN, base #126, head `1af7c48`. Not part of this work. |
| #131 (Rep isolation, migration 0119, default off) | OPEN, stacked on #127, head `e5cca7f`. Rep isolation stays disabled. |
| #143 (integration readiness docs) | OPEN, docs only, base `main`. |
| #148 (temporary SO-00028 diagnostic) | OPEN draft, not merged. No remaining dependency: recovery is verified (section 2). Removal is prepared, not executed. |
| Hosted migrations | Applied through 0117 (`newquip_customer_response_portal`). **Not applied:** 0114 (email suppressed status), 0118, 0119 (both Rep, in #127/#131), 0120 (partial claim amounts). |
| Rep isolation | Disabled. Not changed. |

UAT remediation already inside #126: PRs #135, #136, #139, #137, #140, #142, #141, #144 (mapping chooser), #146 (live recalculation), #149 and #150 (UAT-027 fulfilment verification).

## 2. UAT-027 closure: FIXED AND LIVE VERIFIED

Read-only checks, hosted database, after the owner's Reconcile click:

| Check | Result |
|---|---|
| Creation record `16d70a64…` | `RECONCILED`, evidence `READ_BACK_VERIFIED`, verified 20:32:41 UTC, no error |
| Variation Sale link | exactly one, `LINKED`, role `VARIATION`, Cin7 Sale `ab919729-36e5-44c4-ae7b-f7a4797e8b75` (SO-00028), unchanged |
| Creation rows for `NEWQUIP-PROJECTS-SALE:PRJ-NQ-Q-0017-V001` | 1 |
| Links for that Cin7 Sale ID | 1 |
| Sales created after SO-00028 | 0 |
| Claim postings on the variation | 1: claim 1 (APPROVED 20:33:56) posted 20:35 UTC by the owner's test user as **DRAFT invoice INV-00038**, R500,000 + R75,000 VAT = R575,000, reconciled by memo match 20:35:27. This is the normal workflow after linking, performed by the owner, not a side effect of recovery. |
| Base project Sale | SO-00027 link unchanged; its four postings unchanged |

Root cause chain: the verifier rejected any fulfilment; per the owner's SO-00028 diagnostic (not re-read by this document), Cin7 had created an empty fulfilment container for the stock-less Advanced Sale (status FULFILLED, Pick/Pack/Ship each AUTHORISED with no lines); the first fix then failed closed on the real Ship object's `ShippingAddress` and `ShippingNotes`. Both are corrected (#149, #150) with fail-before-fix tests; the mutation proofs are recorded in those PRs' descriptions and review threads.

**Diagnostic #148:** nothing depends on it. Prepared, **not executed** (needs owner approval because the branch is unmerged):
`gh pr close 148 --comment "UAT-027 recovered and verified; diagnostic no longer needed"`, then `git push origin --delete diagnostic/newquip-uat027-sale-inspect`, then
`git worktree remove ~/dev/cin7core-feeder-newquip-uat027-diagnostic` and `git branch -D diagnostic/newquip-uat027-sale-inspect` (`-D` because it is unmerged). Removing it also removes its `scripts/service-role-allowlist.json` entry.

## 3. Workstream A: the business process, record by record

Reference Project: **PRJ-NQ-Q-0017** (quote NQ-Q-0017 r1), contract R10,072,000 ex VAT, with variation **PRJ-NQ-Q-0017-V001** (R500,000). Both ACTIVE.

| Step | What the records show | Status |
|---|---|---|
| A1 Quotation | NQ-Q-0017 r1 reached `MANAGER_APPROVED_FINAL`: customer confirmed 16:13, Estimator sign-off 16:14, Manager approval 16:15 (1 Nov). Live recalculation (UAT-003), Cin7 mapping chooser (UAT-001), controlled price/cost overrides (UAT-002/004/005) and the branded PDF are in #126. | IMPLEMENTED, AWAITING LIVE UAT (UAT-001, UAT-003 re-test pending owner) |
| A2 Customer acceptance | Quotes NQ-Q-0015, -0016 and -0017 each recorded **ACCEPTED via CUSTOMER_LINK** (31 Oct 07:02, 1 Nov 07:12, 1 Nov 16:48), each after at least one send recorded ACCEPTED by Resend. Refusal of repeated or contradictory responses was **not re-tested for this document**; it is covered by the response-store tests from the portal work. | PASS (live record) for the acceptance workflow. **Email delivery: see 3.1.** |
| A3 Project creation | All three quotes have a Project. PRJ-NQ-Q-0017's contract (R10,072,000) equals the quote's `contract_cents` exactly; stages are inherited, not re-entered. | PASS (live record) |
| A4 Commercial claims | Four claims on PRJ-NQ-Q-0017: Deposit (C01), Delivery (C03, C04 as two progress claims), Installation (C05); claim 2 was withdrawn (`CANCELLED_BEFORE_WRITE`). Their charges total R10,072,000 ex VAT, exactly the contract. Partial claim amounts need migration 0120 (**not applied**). | PASS (live record) for staged and progress claims; partial amounts BLOCKED by migration 0120 |
| A5 Inventory and fulfilment | See Workstream B. | see section 4 |

No cost entries are recorded on either Project (`project_cost_entries` is empty for both), so Project cost and margin on the dashboard come from the approved quotation budget, not actual costs. Say so in the demo.

### 3.1 UAT-007: controlled email-delivery verification (REQUIRES OWNER GO)

Facts: Resend accepted every send; the same sender's internal notifications arrive; earlier quotation emails with the pre-logo PDF arrived; Microsoft 365 quarantined later ones as High Confidence Phish; Microsoft's submission review returned "No threats found". **Future delivery is not assumed reliable.** The brief authorises no customer email send, so this is a plan only.

Plan (owner GO required; allowlisted test mailbox only, never a customer; no change to any anti-phishing policy):
1. **Before the demo**, send the current quotation email to the owner's own allowlisted address, three variants, one at a time, 10 minutes apart: (a) full email with PDF and portal links; (b) same text with the PDF but no links; (c) links but no PDF. Subject carries a marker per variant.
2. For each, record: arrival folder (Inbox/Junk/none), arrival time, and for any missing one the Exchange admin message-trace status and Defender quarantine entry (admin-only items included).
3. Decision rule: if (a) arrives in the Inbox, the demo may send live to the allowlisted address. If any variant is quarantined, **do not send live**; use the fallback (3.2). Never ask Microsoft to allow-list or bypass; a verdict on the real mail is information, not a policy change.
4. Hardening the owner may choose (none done here): a public DNS lookup during the UAT-007 investigation showed a 1024-bit DKIM key for the sending subdomain (**not re-verified for this document**); a 2048-bit key and stricter DMARC alignment are standard improvements. These change DNS and need the owner's decision.

### 3.2 Demo fallback for email

Do not rely on live email. Open the quotation PDF from the Toolbox and open the customer-response link already issued for NQ-Q-0017 (acceptance is already recorded). Show the recorded acceptance with its timestamp and audit history rather than sending a new message.

## 4. Workstream B: Cin7 billing and fulfilment scenarios

Evidence used: hosted records for PRJ-NQ-Q-0017 / Sale SO-00027 and PRJ-NQ-Q-0017-V001 / Sale SO-00028; local fixtures (`poc-scenarios.test.ts`, 5 tests; mutation-checked during preparation: removing the fully-billed guard, the replay `alreadyPosted` flag or the empty-container allowance each fails the suite); the owner's SO-00028 diagnostic. **I did not re-read Cin7 for this document**: Cin7-side statements come from the Toolbox's stored postings, the synced pick/pack rows and the owner's diagnostic.

Live facts for SO-00027 (base Sale): four draft invoices INV-00034 (R4,633,120), INV-00035 (R6,052,013), INV-00036 (R318,527), INV-00037 (R579,140), total R11,582,800 incl VAT = contract R10,072,000 + 15% VAT. INV-00034/35/36 are `RECONCILED`; **INV-00037 is `CREATED` and not reconciled** (an exception to resolve). Synced fulfilment rows: 3 fulfilments, all AUTHORISED pick and pack: #1 11,292 units over 23 SKUs, #2 296 units of one SKU, #3 19,672 units over 4 SKUs; cumulative 31,260 of 31,260 ordered over 25 SKUs. No fulfilment shows a linked invoice number. The synced sale status reads "PARTIALLY INVOICED". Pick/pack rows carry a date only (no time).

| # | Scenario | Expected | Actual | Cin7 records | Toolbox records | Verdict |
|---|---|---|---|---|---|---|
| 1 | Deposit before fulfilment | Charge-only draft invoice; products stay on the Sale for later fulfilment; Additional Charge preserved | Live: C01 posted as INV-00034 with no physical lines, R4,028,800 + VAT, reconciled. Fixture: request has no product lines, charges equal the stage, VAT is an amount, Sale products and shipped quantities untouched. | SO-00027, INV-00034 (DRAFT) | claim C01, posting `RECONCILED` (READ_BACK_MEMO_MATCH) | **Toolbox: PASS (live record + local fixture).** Cin7 "fulfilment after invoicing" ordering: **BLOCKED BY EXTERNAL PROOF**. Pick/pack rows have no time, so whether fulfilment #1 followed INV-00034 is not provable from stored data. |
| 2 | Partial fulfilment | Available stock fulfilled; remainder outstanding; commercial position independent | Fulfilment #1 covered 11,292 of 31,260 units; the delivery invoice INV-00035 carried 352 of 648 units for three SKUs. The claims were raised from approved percentages (inferred from the claim records: no claim is tied to a stock quantity). Physical status shows outstanding units and shortfall as separate figures; unread stock is shown unknown, not zero (fixture). | SO-00027 fulfilments #1-#3 (synced) | postings with `physical_lines` | **OBSERVED (uncontrolled), not proven live; PASS (local fixture).** The synced rows show the partial batch; they do not prove the cause or the timing. Ship-stage quantities are not stored; shipped status relies on the Sale-level status. |
| 3 | Stock replenishment | Second pick/pack/ship after stock arrives; cumulative quantities correct | Fulfilment #2 is 296 units of one SKU, exactly the remainder claimed on INV-00036; #3 adds the other outstanding lines; cumulative 31,260 = ordered. | SO-00027 fulfilments #2, #3 | INV-00036 posting (296 units) | **OBSERVED (uncontrolled), not proven.** The arithmetic holds (11,292 + 296 + 19,672 = 31,260 ordered; #2 equals the C04 posting), but reading #2 as the remainder after a shortage, and as replenished stock, is an inference from Toolbox claim records, not something read from Cin7. A controlled proof is **BLOCKED BY EXTERNAL PROOF** (owner GO, controlled inventory). Note: fulfilment #3's 19,672 units appear on no Toolbox invoice posting. |
| 4 | Further progress claim | Further invoice on the same Advanced Sale; earlier invoices unchanged; no duplicate commercial charge | Live: four distinct invoices, one Sale, sum of charges = contract exactly. Fixture: second invoice on the same Sale, first invoice object unchanged, only new progress charged, a replayed post returns the existing posting ("This claim is already in Cin7. Nothing was sent.") and sends nothing. | SO-00027, INV-00034..37 | claims C01, C03, C04, C05 and postings | **PASS (live record + local fixture)** with one open exception: INV-00037 unreconciled. |
| 5 | Fully billed, not fully shipped | 100% billed; no further claimable amount; warehouse can continue | Fixture: after 100% is billed, claim creation is refused ("nothing new to claim"), no Cin7 call is made, and physical status still shows 4 outstanding and a visible shortfall. The Toolbox's Cin7 port has no fulfilment-writing method, so it cannot block or perform fulfilment. **Live: not observed.** SO-00027 is fully billed and fully picked/packed, so the target state has not occurred. | none | none | **PASS (local fixture) only. Live proof BLOCKED BY EXTERNAL PROOF.** This is a mandatory requirement, so it should be proven in the disposable run (step T8 after partial T5). |
| 6 | Variation | Own linked Advanced Sale; commercial-only variation with an empty fulfilment container verifies; original Sale unchanged; revenue and cost separately traceable | Live: SO-00028 created, verified after fixes #149/#150, linked as `VARIATION`, INV-00038 R575,000 draft reconciled; SO-00027's link and four postings unchanged. Fixture: same shape (including `ShippingAddress`/`ShippingNotes`) links; original link unchanged; replay creates no second Sale. | SO-00028, INV-00038 | creation `RECONCILED`, 1 link, 1 posting | **PASS (live record + local fixture)** for the Sale and revenue. **Cost separation: not demonstrated**, because no cost entries exist on either Project. |

Also required, owner check outstanding: **customer invoice shows Additional Charges only.** The template change is an owner task in Cin7 (`docs/projects-poc/customer-invoice-presentation.md`). No evidence that it was done is stored: **REQUIRES OWNER DECISION / ACTION.**

### 4.1 Mapping the unproven scenarios to owner-gated Cin7 steps

No transaction below is authorised. Each needs its own explicit "GO <step>" (plan: `docs/projects-poc/cin7-disposable-sale-verification-plan.md`).

| Open item | Step(s) | What it would prove |
|---|---|---|
| Scenario 1 ordering, Scenario 2 | T1 then T5 | Deposit invoice before any fulfilment, then pick/pack/ship after it, invoice unchanged |
| Scenario 3 (controlled) | add **T5b** (proposed): owner adds a small stock adjustment for the disposable SKU, then ships the remainder | Second batch after replenishment with controlled inventory |
| Scenario 5 (mandatory) | T3, partial T5, then T8 | 100% billed while part of the order is unshipped; no further claim; fulfilment continues |
| Cin7 populate vs Additional Charges | T6 | Whether Cin7's own populate function would double revenue |
| Reconcile INV-00037 | owner clicks **Reconcile with Cin7 (read-only)** on PRJ-NQ-Q-0017, claim C05 | Moves the posting from `CREATED` to `RECONCILED`; read-only; recommended before the demo |

## 5. Workstreams C and D (separate PRs, all against #126, none merged)

| PR | Content | Head | CI |
|---|---|---|---|
| #152 (PR A) | UAT-025 inline action feedback; UAT-023 root cause; rendered tests; no server action or policy change | `a413b65` | see final report |
| #151 (PR B) | Executive Project Overview (read-only; unknowns stay unknown; cost/margin admin-only) | `f915635` | green |
| this PR (PR C) | This document, the UAT register update, `poc-scenarios.test.ts` | see PR | see PR |

## 6. Twenty-minute demonstration

Demo Project: **PRJ-NQ-Q-0017** (quote NQ-Q-0017) with variation V001, on the #126 Preview. Everything shown is an existing record. Nothing is created live except a read-only Reconcile click.

Before the demo (the day before): run the email check (3.1); reconcile INV-00037 (4.1); confirm the Preview deployment is READY and the presenter has an Estimator, a Manager and an owner/admin login; confirm the Cin7 trial instance is reachable (read-only P0 check); have the fallback material below open in tabs.

| Minutes | Segment | Show | Implemented? | If it fails |
|---|---|---|---|---|
| 0-4 | Solution configuration | New Grower quote for a customer; include/exclude optional equipment; totals and margin recalculate (a server round trip, a few seconds on the Preview); product mapping chooser | IMPLEMENTED, AWAITING LIVE UAT (UAT-001, UAT-003) | Open the saved NQ-Q-0017 draft; walk through its recorded exclusions and mappings |
| 4-7 | Customer quotation | Estimator and Manager sign-off trail on NQ-Q-0017; branded PDF; customer response page with the recorded acceptance and timestamp | Implemented; customer-link acceptance is recorded for NQ-Q-0017 but its UAT items are awaiting live confirmation. Live email send is **not** part of the demo. | PDF and acceptance record from the Toolbox (3.2) |
| 7-10 | Project handover | PRJ-NQ-Q-0017 created from the accepted quote: stages, value and product scope carried over without re-entry | Implemented (project creation permissions: UAT-008 awaiting live UAT) | Show the Project; do not create a new one live |
| 10-15 | Claims and Cin7 | Deposit and delivery claim history with approval trail; draft invoices INV-00034..37 and their reconciliation status; the variation SO-00028 / INV-00038; physical fulfilment position | Implemented; claim cards and approval feedback await live UAT (UAT-015, UAT-025). Cin7 steps are **history**, not live writes. | Screenshots of the claim cards and the stored posting evidence; never improvise a Cin7 write |
| 15-18 | Executive overview | Project Overview dashboard: contract, variation, billed, remaining, margin from the approved budget, fulfilment progress, exceptions | Available when PR B is merged | Show the existing Commercial and Products & Stock tabs |
| 18-20 | Roadmap | Mobile Rep App, Site Operations App (offline capture, supervisor verification), versioned Template Builder | **NOT implemented**: roadmap only; say so on the slide | n/a |

Honest statements to make: costs shown are the approved quotation budget (no actual costs recorded); Xero bank/payment reconciliation is **not** part of the POC (the Toolbox reconciles Cin7 invoices only); invoices are Cin7 **drafts**; partial claim amounts await migration 0120; Rep isolation is off.

## 7. Remaining integration gaps

1. Cin7 "fulfilment after invoicing" ordering and "billed 100% / shipped partially" are unproven live (T1/T5/T8).
2. INV-00037 unreconciled.
3. Migrations 0114, 0118, 0119, 0120 unapplied; each has an owner decision.
4. Customer invoice template (Additional Charges only) unconfirmed.
5. Quotation email delivery to Microsoft 365 unreliable until verified (3.1).
6. No actual cost entries, so margin is budget-based.
7. #126 is a draft, 36 commits behind `main`; a pre-release merge check is needed.
