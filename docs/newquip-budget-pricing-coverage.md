# NewQuip Budget pricing coverage

Status: framework built, register EMPTY. Nothing is activated. Last evidence validation: 2026-11-18.

## What exists
- `src/newquip/grower/budget-basis.ts`: the types and validation for a NewQuip-approved Budget default product or dated ZAR rate (door and optional equipment only, Budget evaluations only).
- `src/newquip/grower/budget-basis-register.ts`: the active register. It ships empty.
- `src/newquip/grower/budget-coverage.ts` and the internal page `/newquip-grower/coverage` (Estimator / Manager; a Rep gets a 404): all 16 selectable categories with three separate answers (price evidence exists, the engine can price from it, an approved price is in place today), the exact blocker, owner and next action. Reps only ever see a selling-price status and customer-appropriate wording.
- `src/newquip/grower/demo-gate.ts`: where the UAT demonstration preset is offered (Preview, or newquip-uat with BOTH `NEWQUIP_UAT_DEMO_TOOLS=true` and `CIN7_CREDENTIAL_STORE=uat`; never Toolbox Production).

## Pricing policy
1. A confirmed current Cin7 supplier cost is preferred and flows through the existing engine (FX, freight, markup).
2. An approved package composition uses its costed components.
3. Historical ERP costs are SUPPORTING evidence only. A record built on them keeps its source date and states its uncertainty; it can never be marked verified or shown as a current Cin7 supplier cost.
4. With no Cin7 cost, a dated rate is allowed ONLY after approval. A cost-basis rate is aged by the existing cost-age escalation from its evidence date (refused beyond the 5-year maximum) and marked up once. A selling-price rate is used as is, never aged or marked up again.
5. Anything else stays unpriced with a specific reason.

## Approving a register entry (procedure)
A developer editing the register file is NOT an approval. For every entry:
1. The authorised NewQuip Manager, or a formally designated commercial approver, approves the item, specification, unit, amount, currency, basis, effective and expiry dates and the evidence in a record OUTSIDE the code (signed document, email or ticket).
2. The entry carries that record's reference (`approval.reference`), the approver, their role, the approval time, the person who entered the record (who must be different), and the evidence (kind, reference, its own date, verified or not, and the uncertainty when historical or unverified).
3. The pull request that adds or changes an entry must be reviewed and approved on GitHub by the named approver (or someone they delegate in writing in the same record). `.github/CODEOWNERS` names the code owner for the register, the validation rules and this document; for GitHub to ENFORCE it, "Require review from Code Owners" must be switched on in the branch protection of the UAT candidate and `main` (a repository setting this code cannot verify or change; at the time of writing neither branch is protected, so GitHub enforces nothing yet). Because the only code owner today is the account that opens these pull requests, and GitHub does not let an author approve their own pull request, a second reviewer or a designated approver account must be added to CODEOWNERS before this control is real. The names in an entry are self-declared text: the checks refuse look-alike characters and the same person written differently, but the external approval record and the code-owner review are the real control.
4. `budgetBasisProblems()` refuses anything incomplete, expired, future-dated, self-approved or over-age, and a test requires every active entry to pass it.
A database-backed approval screen is a later step; it needs a migration and an explicit owner decision.

## Cost-date finding (NQ2114, NQ2161)
- Live Cin7 (read-only, 2026-11-18): NQ2114 R5,400 (ARUMI, last supplied 2026-11-03), NQ2161 R5,800 (K FAB, 2026-11-13), NQ2281 R3,524.14 (PG Aluminium, 2026-11-13). No other candidate has a supplier cost.
- The ERP "Inventory Last Cost" report dates NQ2161 at 2021-11-04 and NQ2113 at 2022-03-15 (the same R5,400 as NQ2114).
- The engine takes Cin7's `LastSupplied` as the cost date (`cost-survey.ts`, `auto-costing.ts`). Nothing distinguishes a goods receipt from a manual update or import, so a recent date can hide an old price and no age escalation is applied. The synced purchase data holds no purchase of these doors, and the Toolbox log shows no cost write on those dates, so the origin of the dates is UNRESOLVED.
- Treatment: these door costs are candidates, not verified current costs. The Manager's independent cost verification with evidence (a supplier quote) remains the control, and the coverage view labels the dates unverified.

## Open decisions for Sean (decision sheet; not sent)
1. Default PVC door and specification. Candidates: NQ2114 (1970x1000 white UV 35 mm), NQ2113 (1980x1000, no windows), NQ2112 (1980x600), NQ2161 (1980x1000 with windows), NQ2281 (35 mm white 1990x790), NQ3444 "PVC SINGLE DOORS". Which is the standard Budget door, which sizes may the Rep choose, and what is the supplier and date of the current cost?
2. Thomas-CL1 controller: is HO05084000 (box version) correct, or the panel version HO05084007? How many per room?
3. Silo weighing: name the product(s). Candidates: HO05084500 (THOMAS feed controller), 4 x HO53900360 load cells, HO08010880 load-cell I/O module; alternative SIRIUS-SWS-V (pigs) HO05071000. One set per silo?
4. CL1 / BF control panel: panels are built per job. Can NewQuip give a standard budget allowance per panel?
5. Emergency windows: ERT002 (2080x900) or ERT003 (1500x700), both with motor; HO08020800 emergency opening; power supplies. Which, and how many per room (guide: 6)?
6. Sumpless pad cooling: what one house includes (pad size and count, gutters, pumps, plumbing).
7. 57-inch cone fan: the FB57-PLUS fan (YA005) or the 54-inch cone fan MUC4D14A3M10238? How many per room?
8. 250 mm manure plug: product or parts list (tube, seal, plug with breather).
9. Quantity basis for each (per room, per silo, per pen, per house) and the standard default. The current per-room demo values are test data, not rules.
10. Still open: cup-drinker package (7 parts vs NB3542-03); LED package (FERAX 24W with 3 clips and cable per light) and the name shown to customers.
11. The first quote that included fans, which Sean says he saved.
