# Migration 0105: multi-Sale variation billing - plan, dry run and forward recovery

Status: **authored, NOT applied to hosted Supabase** (separate owner GO required). Hosted currently has 0101-0104.

## What it does (additive only)
- `projects`: `billing_scope` (default `BASE`), `parent_project_id`, `variation_id`; shape check; unique billing project per variation; trigger enforcing that a VARIATION billing project belongs to an ACTIVE BASE parent, bills an APPROVED variation at exactly its approved amount, and shares the parent's customer, tax, currency and Cin7 instance. Scope/parent/variation are immutable.
- `project_variation_stages` (basis points, DRAFT-editable, frozen on approval) and append-only `project_variation_schedule_amendments`.
- Trigger on `project_variations`: a variation that HAS a schedule can be approved only if it totals exactly 100%. A variation with no schedule (every pre-0105 variation, and any older code path) can still be approved but cannot be billed until a manager sets a schedule through the audited amendment function. (The first CI run showed the stricter rule broke the existing 0102 test, so the rule was relaxed deliberately.)
- `variation_stage_cents()` (deterministic cents split) and `amend_variation_schedule()` (service-role only, audited, refused once the billing project has claims or progress).
- `project_cin7_sale_links.sale_role` (default `BASE`) with a trigger tying the role to the billing project's scope. 0104's `unique(project_id)` and `unique(org_id, cin7_sale_id)` are **unchanged**: each billing project still has exactly one Sale.
- `project_claim_cin7_postings.physical_lines` (nullable, immutable) for R0 product lines on an invoice.

## Existing data
Every existing row keeps its meaning: all projects become `BASE`, all links `BASE`, all postings have `physical_lines` null. The 0105 test inserts rows without naming the new columns and asserts they default to BASE. **V001** (approved, no schedule) is not touched: the approval trigger only fires on a DRAFT->APPROVED transition, and a billing project for V001 exists only if a manager explicitly sets its schedule (audited amendment) and starts billing. INV-00021 and its posting row are untouched.

## Dry run (before any hosted GO)
1. CI job "Clean migration bootstrap + RLS/security test matrix" applies 0001-0105 to a blank local Postgres and runs every `supabase/tests/*.test.sql` including `0105_project_multi_sale_variation_billing.test.sql`.
2. Existing-data check on a copy of production-shaped data (owner-approved snapshot or a Supabase branch): apply 0105 and confirm `select count(*) from projects where billing_scope <> 'BASE'` = 0, that `PRJ-NQ-Q-0001`, `V001` and the INV-00021 posting row are byte-identical to before, and that the app still loads the project (deploy-order safety: the code tolerates 0105 being absent).
3. Only then apply to hosted, by name, with `apply_migration` for 0105 alone (never `supabase db push`).

## Forward recovery (no destructive down-migration)
- The app reads new columns defensively; if 0105 must be abandoned, stop using the new actions and leave the columns/tables in place - they are inert for BASE-only projects.
- A wrongly created variation billing project with no claims or progress can be left CANCELLED (status update is allowed) and its variation re-billed only after a corrective migration; never delete audit rows.
- A wrong schedule before any claim: `amend_variation_schedule()` with a reason (audited). After claims exist the schedule is deliberately immutable; correction is a credit/re-issue flow that is **not designed yet** and out of POC scope.
- If the trigger set misbehaves in a new scenario, fix forward with a new migration (0106+) that `create or replace`s the specific function; do not edit 0105 once applied.

## Existing-data dry run (local, 2026-10-28)
`scripts/dryrun-0105/run.mjs` (run: `npm i --no-save @electric-sql/pglite && node scripts/dryrun-0105/run.mjs`) applies the REAL migrations 0101-0104 to an in-memory Postgres (WASM) with minimal stand-ins for the foundations, seeds a fixture shaped like the hosted data, snapshots every row, applies the REAL 0105 and asserts: all existing rows are byte-identical apart from the new columns; every project is BASE and the Sale link BASE; the INV-00021 posting is unchanged and still immutable; approved historical claims and frozen stages are still frozen; V001 (approved, no schedule) cannot receive a schedule directly and gets one only through the audited function (empty before-schedule recorded); a new variation cannot be approved on a 50% schedule, its schedule freezes, its billing project must match the approved amount, cannot be duplicated, cannot be over-claimed, cannot claim against a BASE stage; another organisation sees none of the new tables; members cannot write them or call the amendment function. Result: **48/48 assertions passed.** It never connects to Supabase. Limits: RLS here uses a stand-in `is_org_member`; the authoritative RLS/clean-bootstrap run is the CI job (which passed on `0fab277`).

## Read-only assessment of the hosted data (2026-10-28, SELECT only)
3 projects (PRJ-NQ-Q-0001, NQ-POC-MVB55T7T, NQ-POC-MVQWWSNB), all ACTIVE, 18 stages, 4 APPROVED claims, 8 claim lines, 14 progress events, 2 opening commitments, 1 variation (V001, APPROVED, R480,000, on PRJ-NQ-Q-0001), 1 Sale link (SO-00019, on NQ-POC-MVQWWSNB), 1 posting (INV-00021, CREATED, AMOUNT_MISMATCH), 1 quote (NQ-Q-0001, MANAGER_APPROVED_FINAL), 0 legacy `project_cin7_links`. Migrations 0101-0104 applied (`20261016153001`, `20261027133802`, `20261027152905`, `20261027163105`). None of these rows can violate a 0105 constraint (every new column is nullable or defaults to BASE; no row has a parent or variation scope).
