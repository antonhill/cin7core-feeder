# NewQuip UX-006 - complete quotation journey: audit, ownership and screen map

Status: **proposal for the consolidated redesign** (audit of integration/newquip-ux006-review @021b036). Evidence from read-only code audits and read-only checks of the hosted role setup. No hosted writes.

## 1. What "Pre-approval" actually is
The Rep records that **a named customer contact confirmed the exact quote total (ex VAT)** before internal approval, and the same action **hands the quotation to the Estimator** (`sendGrowerQuoteToEstimatorAction` -> `sendToEstimator`: readiness READY, total > 0, confirmed-by non-blank, confirmed amount = total; sets `customer_confirmed_*`, `handoff_by_email`, state ESTIMATOR_REVIEW, clears any sign-off, appends `snapshot.confirmationContact`, notifies the Estimator). It is **not** sent to the customer, **not** the issued quotation, **not** the formal acceptance (Stage 5) and **not** an Estimator check. It is an honour-system attestation; nothing proves the customer confirmed. The UI label is therefore **"Submit to Estimator"** with the confirmation recorded as part of it.

## 2. Actual causes of the duplication and navigation defects
1. **Two customer identities**: a free-text Customer field (saved by Save draft) sits above the Cin7 customer search; the Cin7 pick overwrites it. Readiness accepts the free text alone.
2. **Contact chosen three times**: Stage 1 CustomerPanel (buttons + "Add or correct contact"), the Site step link, and Stage 2 `ConfirmationPanel` (default / another Cin7 contact / alternative). The Stage 2 default already equals the Stage 1 contact.
3. **Rep work lives in Stage 2**: quantities, charges, M75 price, exclusions, mappings and the submit action are in Stage 2, so Stage 2 mixes Rep and Estimator work and repeats Stage 1.
4. **Stage is derived** (`picked ?? landing ?? here`), steps start at 1, nothing picks the first incomplete authorised step.
5. **Global "Load Demo Defaults"** replaces whole-quote inputs and was the source of the jump to Stage 2 (fixed in #176), but remains a confusing everyday action.
6. **Readiness/amount/handoff facts repeated** in 5+ places; long explanatory text in ordinary flows.

## 3. Field-ownership matrix (condensed)
Edit rights are what the **server** enforces today. "R/E" = Rep or Estimator may edit (`canEditDraft`, no field-level restriction).

| Group | Fields / actions | Storage | Required? | Edit (server) | Proposed location |
|---|---|---|---|---|---|
| Customer | Cin7 customer search/select/replace/clear | snapshot table; mirrors `customer_name` | needed to send | Rep | Stage 1 step 1 |
| Contact | Cin7 contact or quotation-only contact; email correction (reason) | `snapshot.chosenContact` | needed to send | Rep | Stage 1 step 1 (ONE chooser) |
| Delivery email | = `chosenContact.email` (no separate field) | derived | - | via contact | Stage 1 step 1 (confirmation line) |
| Site / project name, pricing basis | `draft.siteName`, `quoteType` | draft | site required | R/E | Stage 1 step 2 |
| Room dims, rooms, pens, pigs/room | `config.*` | draft | required (calc validity) | R/E | Stage 1 step 2 |
| System selections (feeder variant, pig size, running metres, slatted area) | `config.*` | draft | pig size required | R/E | Stage 1 step 3 |
| Optional equipment (7) | `config.optionalEquipment` | draft | optional | R/E | Stage 1 step 3 |
| Per-room product quantities, quantity overrides + reasons | `estimatorQuantities`, `quantityOverrides` | draft | required (readiness) | R/E | Stage 1 step 3 (sub-section "Quantities") |
| Charges (delivery, installation, slat delivery), M75 price, assumptions | `estimator.charges/unitPrices/assumptions` | draft | required | R/E | Stage 1 step 3 (sub-section "Charges & assumptions") |
| Customer-driven exclusions + reasons | `config.exclusions` | draft | reason required to save | R/E | Stage 1 step 3 (sub-section) |
| Optional-element product mappings, confirm source-backed mappings | `confirmedMappings/Packages` | draft | **blocks READY** | **Estimator/Manager** (mapping-access) | Stage 2 step 1 (Estimator); shown read-only with owner label to the Rep |
| Manual quotation prices (price resolutions) | `estimator.priceResolutions` | draft | **blocks READY** when a line is unpriced | **Estimator/Manager** | Stage 2 step 1 |
| Cost capture, supplier, FX, unit basis, accept-incomplete | cost tables / `physicalCosts` | cost tables | for complete costing | Estimator/Manager/Owner-observer (cost) | Stage 2 step 2 |
| Margin / cost overrides | `estimator.costOverrides` | draft | reason+amount pair | needs cost visibility | Stage 2 step 2 |
| Pre-approval price confirmation + submit | confirmation fields + state | quote cols + snapshot | to leave REP_DRAFT | **Rep** | Stage 1 step 5 "Submit to Estimator" |
| Cost review acknowledgement | client-local | none | none | Estimator/Manager | Stage 2 step 3 (Final review) |
| Estimator sign-off / return | `estimator_signoff_hash`; state | quote | READY | Estimator (return: Estimator; Manager at its stage) | Stage 2 step 4 |
| Manager approve / return to Rep or Estimator | state | quote | sign-off current | Manager only | Stage 3 workspace |

## 4. Rep vs Estimator: the one real conflic
`checkHandoff` needs readiness READY, and readiness includes **mappings and price resolutions that only an Estimator may enter**. A Rep can therefore be blocked on Estimator-only work (the UI shows "Awaiting an Estimator"), with no notification path. This is a **business-rule decision, not a UI bug**:
- A: keep the rule; make the owner of each blocker explicit, let the Estimator act on a Rep draft's mapping step (server already allows Estimator edits of a REP_DRAFT) and show the Rep exactly what is waiting on whom. **(implemented as presentation)**
- B: let the Rep submit with Estimator-owned blockers outstanding (changes `checkHandoff`/readiness: needs approval).
- C: give the Rep mapping/price authority (changes financial authority: needs approval).

## 5. Final stage/step structure
**Stage 1 - Rep preparation** (editor: Rep; Estimator/Manager/observer read-only)
1. Customer & contact (trading name prominent; one contact chooser; "Quotation will be sent to <email>"; technical IDs in Details; replacing the customer shows what it invalidates).
2. Site & measurements.
3. Equipment & options (selections; optional equipment; sub-sections Quantities, Charges & assumptions, Exclusions; contextual "Load recommended configuration").
4. Review configuration (compact summary, completion indicators, Edit links, missing required information with owner).
5. Submit to Estimator (readiness summary; "Submit to Estimator" - states that it records the customer's price confirmation by <contact>, notifies the Estimator and moves the quotation to Estimator review).

**Stage 2 - Estimator review** (editor: Estimator; Manager oversight; Rep read-only)
0. Compact read-only Rep summary (what was submitted) above the steps.
1. Lines & mapping review (mapping choosers, confirm source-backed mappings, manual quotation prices).
2. Costs, margins & pricing exceptions (cost capture, margin overrides, totals).
3. Final review (**Mark reviewed & continue**, client-local, invalidated by any change).
4. Sign-off or return (sign-off; return with reason and next owner).

**Stage 3 - Manager approval**: signed-off summary workspace (read-only Rep + Estimator results) with Approve / Return; no editable fields.
Stages 4-6 unchanged except wizard locks.

## 6. Navigation contract (derived, role-aware)
Pure `deriveWizard()` -> per step `{status, access: edit|readonly|hidden|locked, blockedBy[], owner}` + `entryStep`. Entry = first incomplete step the viewer may act on, resolved ONCE after customer facts load (avoid the async jump), latched. Locks are **UX policy** where no server gate exists (Stage 1 steps 2-4 are server-independent; sequencing is the owner's chosen guidance) and **real gates** where the server enforces (snapshot + contact + READY to submit). Back/rail to earlier permitted steps always allowed; locked future steps show the blocking requirement; Show all steps lists permitted steps only (locked as heading + reason); no navigation writes; defaults/save/recalc never move the step; editing an earlier step revalidates downstream without destroying valid data; a returned quotation opens at the first incomplete step with the return reason banner (reason is not stored on the quote row: it is read from approval history when present; storing it needs approval).

## 7. Decisions held for the owner (not implemented)
D1 mapping/price ownership vs Rep submit (section 4). D2 server guard so `saveDraft` cannot overwrite `customer_name` once a snapshot exists. D3 remove the typed-name fallback when the snapshot table is unavailable. D4 whether a contact change after confirmation should withdraw the confirmation/sign-off. D5 persist return reason/target step. D6 remove the alternative confirmer. D7 any persisted "delivery email confirmed" flag. D8 whole-quote demo loader kept as a Preview-only utility (implemented gated) vs removed.
