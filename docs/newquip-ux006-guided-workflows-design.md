# NewQuip UX-006 - Guided workflows and numbered steps (design)

Status: **DESIGN READY FOR OWNER REVIEW. Nothing is implemented.** Docs and a static prototype only.
Base: `feature/newquip-completion` at `3bc629a` (#126 incl. D3/D4 and UX-005). Interactive prototype: `docs/newquip-ux006-prototype.html` (open in a browser; resize for laptop/tablet/mobile).

Everything below is derived from the real code (file references are to that head). Where the brief's assumption has no basis in the code, this is stated rather than designed around.

## 0. Summary of findings that shape the design

| # | Finding (evidence) | Design consequence |
|---|---|---|
| 1 | The six stages are **derived, not stored** (`computeStages`, `src/newquip/quote/stages.ts:43-101`). Any stage can be opened any time (`StageNav`). | Steps are derived the same way. Navigation never blocks; only existing action buttons stay gated. |
| 2 | Stage 1 sections share **one draft** saved by Save draft, but the **customer selection saves immediately** (`CustomerPanel` actions) and is outside the dirty guard. | Each step states how it saves ("Saved on selection" vs "Saved with Save draft"). No per-step save is invented. |
| 3 | **No "confirm site" action exists.** Site is a free-text draft field. There is **no "validate" action**; readiness is live (`assessReadiness`). | Proposed Stage 1 steps 2 and 5 are re-scoped: "Contact & site name" and a read-only "Review". |
| 4 | **Per-room quantities are Stage 2** (Line decisions table), not Stage 1. | Owner step 3 "room measurements **and quantities**" splits: measurements in Stage 1, quantities in Stage 2 step 1. |
| 5 | Stage 1 "complete" needs only a typed customer name, but the **Stage 2 handoff** is blocked until a Cin7 customer snapshot and contact exist (`ConfirmationPanel.tsx:78-85`). | Step 1 shows a warning, not a false "Done", when only a typed name exists. |
| 6 | **No project completion/closure state exists** (`projects.status` is DRAFT/ACTIVE only). Milestone confirmation is **evidence only** and does not release claimable value. Claims do **not** require a Cin7 Sale; **posting** does. Invoicing and stock are independent. | The Project Journey has no "completion step"; unknowns render as "Not read yet", never zero. |
| 7 | The Project workspace already loads one `getProjectAction` payload plus the Overview's `getProjectOverviewDataAction`, with Cin7 reads on demand only. | The journey is derived from data already loaded: **zero new requests**. |
| 8 | Panels in Stage 2 start requests on mount timers (Scope/Cost, 800 ms). | Hidden steps stay **mounted** (`hidden` + `inert`), so the request pattern is byte-for-byte unchanged. |

## 1. Solution Builder: the six stages and their numbered steps

Principle: **stages are the workflow; steps are a navigation and explanation layer over the panels that already exist.** A step is a *group of existing panels*. No step maps to a single input. Steps are shown only where the stage has more than one natural decision group; otherwise the stage gets a checklist, not a stepper.

Step status (derived, display only): **Done** (existing readiness/gate satisfied), **Needs attention** (an existing reason applies to this group), **Not done**, **Not available / Not your role** (shown read-only with the acting role named). Completion never gates Next.

### Stage 1 - Configuration (5 steps)

| Step | Existing panels | Done when | Saves | Role |
|---|---|---|---|---|
| 1 Customer | `CustomerPanel` search/select/snapshot | a Cin7 customer snapshot exists (typed-name-only shows a warning "needed before sending to the Estimator") | immediately, own action (`selectQuoteCustomerAction`) | Rep (server re-checked) |
| 2 Contact & site | contact chips, `siteName`, pricing basis | site name entered (contact optional, defaults to the customer's primary) | contact immediately; site/basis with Save draft | Rep / Estimator edit |
| 3 Room inputs | Room inputs panel | `calc.valid` for the room fields | Save draft | Rep / Estimator |
| 4 Equipment & options | Selections + Ventilation | pig size and feeder valid | Save draft | Rep / Estimator |
| 5 Review | read-only summary of the live preview, the Stage 1 readiness reasons and **Continue to Stage 2** | no Stage-1 readiness reasons remain | nothing (read-only) | all |

Differences from the proposed sequence (all code-driven): step 2 drops "confirm site" (no such action; it is a name field); step 3 covers measurements only (quantities are Stage 2); step 5 is a read-only review, not a "validate" action (none exists, readiness is live in the sticky summary).

### Stage 2 - Costing & Estimator Review (3 steps for a Rep, 4 for Estimator/Manager)

| Step | Existing panels | Role notes |
|---|---|---|
| 1 Lines & mappings | Quote readiness, Line decisions (quantities, overrides + reasons), Product mappings, "Confirm source-backed mappings" | Estimator/Manager map; Rep edits quantities |
| 2 Charges, exclusions & prices | Commercial inputs (delivery, installation, slat delivery, M75, assumptions), Manual quotation prices, Customer-driven exclusions | Rep / Estimator edit; reasons required per existing rules |
| 3 Cost & margin *(commercial viewers only)* | ScopePanel, CostPanel, Totals, MarginPanel | hidden for roles without `canViewCommercials`; role visibility rules unchanged |
| 4 Handoff | Rep: `ConfirmationPanel` (amount confirmation, send). Estimator: sign-off / return with reason | exactly today's gates: `sendWhy`, `signoffWhy`, `returnWhy` |

Totals stay visible in the sticky summary at every step.

### Stage 3 - Manager Approval (checklist, no stepper)
One decision. Show the five existing `checkApproval` conditions as a read-only checklist (READY, total > 0, customer confirmed, sign-off matches the current draft, no unsaved edits) above the existing Approve / Return controls. Each unmet item uses the existing Alert text.

### Stage 4 - Customer Quotation (2 steps)
1 Issue PDF (company-profile blocker, schedule chooser, "Generate customer quotation PDF") then 2 Send to customer (recipients, message, reviewed-PDF tick, send history). Step 2 is "Not available" until a PDF exists. Rep-only send is stated, not hidden.

### Stage 5 - Customer Acceptance (status + actions, not steps)
Acceptance is event-driven (emailed link, verification, rejection, changes requested) and the evidence recording and review paths are alternatives, not a sequence. Design: a status banner derived from the existing state ("Awaiting customer response / Pending verification / Accepted / Returned") with the one obvious next action, then the existing panels. No numbering.

### Stage 6 - Project Handover (readiness checklist)
Single manager action. Checklist above "Create Project": quote approved, acceptance recorded (when required), schedule totals the contract (existing disabled reason), manager role. Idempotent create and reconcile-on-lost-response are untouched.

### Navigation model (all stages)
- Two-level: the existing stage nav (unchanged) plus a compact **step rail** under it; one line of progress: "Stage 1 · Step 3 of 5 · 4 done".
- **Back / Next** under the content (sticky bottom bar on mobile). Next never requires completion.
- Rail items are real buttons in an ordered list with `aria-current="step"`; status is icon + text. Focus moves to the step heading on change.
- Deep link `?stage=1&step=3` (via `history.replaceState`, like `?stage=n` today).
- **Expert mode:** "Show all steps" renders every group in the current page order (today's layout), remembered per viewer (per-viewer convenience only, never required); first-time users default to the step view. The default is an owner decision (section 8).
- Save draft stays where it is (Stages 1-2). Save state is one global live-region chip because the draft is one object; the rail shows completeness only, never "saved". The customer step says it saves on selection.
- One progress display: the rail. A **Next incomplete step** action jumps to the first step that is not complete.

## 2. Project Journey

Not a stepper. A **journey map** at the top of the existing Overview tab: a Setup strip, then three parallel lanes (Commercial, Physical, Variations), each station a status icon + text, one line of detail and a link to the existing tab via `onOpenTab`.

### Statuses (all derived from data the workspace already holds)

| Station | Source (already loaded) | Not started | In progress | Completed | Needs attention | Blocked |
|---|---|---|---|---|---|---|
| Project details | `view.project` manager/start/target | none set | some set | all set | - | - (informational only) |
| Billing schedule | `commercial.scheduleBalanced` | - | - | balanced | not balanced (critical) | - |
| Opening commitments | `view.openingCommitments`, `...Locked` | none (optional) | entered | locked by first claim | - | - |
| Cin7 Sale | overview data (`saleNumber`, scope blockers), creation state when the Claims tab has loaded | no link, no row | PENDING or blockers outstanding | linked / CREATED / RECONCILED | FAILED_UNCERTAIN | writes off / not manager shown as "needs a manager" |
| Stage progress | `reportedBps/approvedBps/committedBps`, `belowCommitted` | approved = 0 | 0 < approved < 100% | committed = value | `belowCommitted` | - |
| Progress claims | claim statuses, `claimActionPlan` | none | DRAFT/READY_FOR_APPROVAL | all RECONCILED/closed | needs your action | `uncertainClaimBlocking` |
| Post to Cin7 | `claimCin7Status` | - | POSTING | AUTHORISED/RECONCILED | FAILED / UNCERTAIN | **no linked Sale** (the real dependency) |
| Invoice status | last-recorded `cin7_status` | - | - | - | - | "Not read yet" until verified; never live-implied |
| Deliveries | overview delivery counts | none | PLANNED/LOADING/DISPATCHED mix | all dispatched | - | - |
| Fulfilment / Procurement | Cin7 read on demand | **Not read yet** (unknown, not zero) | - | read result | shortfall > 0 | - |
| Milestone confirmations | delivery register rows | none | recorded | - | - | - (evidence only; says so) |
| Variation (per V) | `VARIATION_STATUSES`, `billingProjectByVariation`, `reconciliationByVariation` | DRAFT | APPROVED + billing open | all reconciled | approved with no billing project; uncertain | - |

Rules: nothing is a step the user must complete first; no arrow between lanes; a dependency is shown only as a "Needs: ..." line where the code enforces it (posting needs a linked Sale; Sale creation needs resolved scope; opening commitments lock at the first claim; variation schedule locks once billing starts; an uncertain claim blocks billing). Stock fulfilment and invoicing never reference each other.

**Completion:** there is no authoritative state. The journey shows three read-only checks (all stages committed, no unresolved claims, all deliveries dispatched) and states plainly that a closure state would need an owner decision, a migration and its own PR. It is out of scope here.

## 3. Task-specific flows: wizard or no

| Flow | Today (evidence) | Verdict |
|---|---|---|
| Project setup (`createProjectFromGrowerQuoteAction`, Stage 6; details editing) | one confirm + optional schedule chooser; 3-field details form | **No wizard.** Readiness checklist above the button (Stage 6 design). |
| **Create / link Cin7 Sale** (`Cin7SaleCreationPanel`) | 6-10 interactions; hidden order; one concatenated reasons sentence; **no unsaved guard** on typed references | **Yes - guided 4 steps**: Resolve scope, Cin7 references, Preflight (optional), Confirm & create. Same actions, same `createReasons` gates; writes only on the final button. |
| Prepare progress claims | select stages, preview, save draft, submit (4-5 actions) | **Light stepper** over the existing form (Select, Preview, Save draft, Submit) plus a "nothing claimable yet" hint that says *why* (needs commercial approval of progress). No new writes. |
| Milestone confirmation | one form; evidence only | **No wizard.** One clarifying line: confirmation is evidence; **Approve commercial progress** is what makes value claimable. |
| Raise variation | raise form then price, submit, approve, then billing set-up | **No wizard.** Per-variation "Next:" line like `claimNextStep` (raise, price, submit, approve, start billing, schedule). |
| Approval decisions | one decision form with its own confirm block | **No wizard.** Show key figures beside the buttons. |

## 4. Where to use wizard vs dashboard vs table

- **Step rail (Solution Builder Stages 1, 2, 4):** sequential authoring with several groups.
- **Checklist (Stages 3, 6; Stage 5 status banner):** one decision, many prerequisites.
- **Journey map (Project Overview):** parallel workflows; never a stepper.
- **Guided steps (Cin7 Sale, claims preparation):** real order, writes at the end.
- **Keep as table/dashboard:** Approvals queue, Claims list, Variations list, Deliveries, Physical, Procurement, Profitability, Consolidated report.

## 5. Interactive design (see the prototype)

Desktop/laptop: stage nav, then a single-row step rail (44px targets, number or check, name, status text), content in the full-width workspace (UX-005 widths), Back/Next row. Tablet: rail scrolls horizontally. Mobile: both stage nav and step rail collapse to "Stage 1 of 6" and "Step 3 of 5 · Room inputs" disclosures; Back/Next is a sticky bottom bar; the journey lanes stack. Prototype views: Builder Stage 1 (with Show-all), Stage 2 as Rep vs Estimator, Project Journey, Cin7 Sale steps.

## 6. Implementation PR plan (each small, stacked on #126, no calculation/approval/Cin7-contract changes)

1. **UX-006a StepRail foundation + Stage 1.** Shared `StepRail` and pure `deriveStage1Steps(draft, readiness, customer)`; keep panels mounted; Back/Next; `?step=`; Show-all toggle; tests for derivation, a11y, request counts unchanged, UAT-003 untouched.
2. **UX-006b Stage 2 steps.** Role-aware steps (Rep 3 / Estimator 4), same panels, handoff step.
3. **UX-006c Stages 3-6 guidance.** Approval checklist, Stage 4 two steps, Stage 5 status banner, Stage 6 readiness checklist.
4. **UX-006d Project Journey.** Pure `buildJourney(view, overviewData)` (extends `overview-model.ts`), `JourneyMap`, panel anchors; no new requests.
5. **UX-006e Cin7 Sale guided steps.** Wrap the existing panel; add `useUnsavedGuard`; same actions.
6. **UX-006f Claims stepper + inline "next" copy** (claims preparation, claimable hint, milestone line, variation next-step line).

Order: a, d, e first (largest value, independent); b, c, f follow. No migrations in any of them.

## 7. Regression and acceptance criteria

Behaviour preserved: quotation calculations, totals, margins and role/cost visibility unchanged; UAT-003 recalculation tests pass unchanged; sticky summary, UX-005 widths, D3/D4 behaviours intact; estimator sign-off still withdrawn by Save; unsaved guard still covers every dirty form (and Cin7 Sale references newly).
Requests: the existing mount-request tests (`workspace-mount-requests`) pass; no new server action and no extra request on step change; hidden steps stay mounted.
Business rules: no step gates navigation; Next never skips a gate; disabled reasons keep their exact copy; journey statuses come only from existing state; unknown shows "Not read yet"; no completion step.
Isolation and authority: every write still goes through its existing action; a static test asserts the new modules import no action or store; BASE/VARIATION isolation and org scoping untouched.
Accessibility: ordered list, `aria-current="step"`, status as text, 44px targets, focus to heading on step change, visible focus, no colour-only status, reduced-motion respected, screen-reader announcement of "Step n of N".
Responsive: no horizontal overflow at 1920/1440/1280/820/390; mobile sticky Back/Next does not cover content or the keyboard.
Evidence per PR: real-browser screenshots at those widths, independent review, full tests, exact-head CI.

## 8. Decisions for the owner

1. Re-scope Stage 1 step 2 to "Contact & site name" and step 5 to a read-only Review (no confirm-site or validate action exists)?
2. Default view for the step rail: step view (first-time friendly) or Show-all (today's layout) with the step rail as a jump list?
3. Treat a typed customer name without a Cin7 snapshot as "Needs attention" in step 1 (recommended) or "Done" (today's Stage 1 gate)?
4. Is a project closure/completion state wanted? It needs its own design, migration and approval; this design only shows read-only checks.
5. Approve PR order a, d, e first?

## 9. Pre-existing gaps noticed (not changed here)
Cin7 Sale references, the stage progress card and milestone form have no unsaved guard; "nothing claimable yet" does not say why; the Sale reasons are one concatenated sentence. Addressed in PRs e and f.

## 10. Impeccable critique and what changed

Run as two isolated assessments. **A (design review)** scored the first prototype **24/40** (heuristics: status 2, consistency 2, flexibility 2, minimalism 2, recovery 2, help 2; others 3). **B (evidence)**: the detector ran in a degraded regex-only mode (its empty result proves little) and the browser measurements found real failures. Both are summarised here; the prototype was revised and re-measured.

| Finding | Source | Change made |
|---|---|---|
| "Complete" shown next to "Unsaved changes" conflated *filled in* with *saved* | A | Rail says **Complete / Needs attention / Not complete** (completeness only). Save state is one live-region chip ("All changes saved" / "Unsaved changes (draft fields)"). Customer step states it saves on selection. Per-step dirty dots are **not** proposed: the draft is one object. |
| Two progress tiers and a duplicated "Step 3 of 5 - 4 done" line | A | Duplicate line removed; the step rail is the single progress display; on mobile the stage and step disclosures each carry their own count. |
| Expert path was a throw-away checkbox | A | "Show all steps" is **remembered per viewer** (try/catch storage, per-viewer convenience only) and a **Next incomplete step** action is added. Alt-arrow shortcuts are not proposed (assistive-tech conflicts). |
| Journey too dense, one-word links, 6-state key | A | Key reduced to 5 (unknown merged into "Not started / not read yet", still labelled in text); links name their target ("Open Claims", "Start V002 billing"); the Completion box is now a one-line footnote. Open: collapse lanes to counts by default on mobile (see 11). |
| Cin7 Sale wizard ended on a disabled Next with no reason | A | Last step **hides Next and shows Create** with a requirement checklist (scope, references, confirmation) and a reason; uses `aria-disabled` with visible text. The 4 steps stay because the order is real. |
| Interactive targets under 44px (journey links 17px, buttons 40px) and 13px checkboxes | B | Links, buttons, inputs raised to 44px; checkboxes 24px with 44px label hit areas. Re-measured: no non-checkbox control under 44px at 1440 or 390. |
| Focus outline about 3:1 | B | Darker 3px outline. |
| No horizontal overflow, no unnamed controls, text contrast >= 5.2:1, step rail is an `ol` with `aria-current="step"`, steps reached before panel content in Tab order | B | Confirmed, nothing to change. |

Not tested: screen-reader announcements, the opened mobile disclosures' Tab order, a real signed-in run. These are acceptance items for PR a.

Unresolved critique points kept as owner decisions: "stage chips say *Not yet available* but are clickable" (today's behaviour; recommend wording "Preview only"), and whether a single "What's next for me" action should replace some of the rail (the **Next incomplete step** action is the compromise).

## 11. Open design questions
1. Journey: collapse the lanes to counts on mobile, or always show every station?
2. Wording for stages that are openable but not yet actionable ("Not yet available" vs "Preview only").
3. Whether step status should ever distinguish "complete but unsaved" per step (needs field-to-step tracking; not proposed).
