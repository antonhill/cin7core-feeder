# NewQuip POC - post-integration readiness report (2026-10-28)

Checkpoint accepted by the owner; this is not approval for hosted migrations, Cin7 writes or merging. Everything below was local or read-only.

## 1. Integration head and CI
Code head `903290a` (`feature/newquip-poc-integration`, draft PR #123): lint/typecheck/2,477 tests/production build **pass**; secret scan **pass**; clean-bootstrap + RLS matrix including `0105_...test.sql` **pass**; dependency audit **fails** (inherited, see section 6). Later commits on the branch are documentation only.

## 2. Variation architecture: PASS, with one defect fixed and four weaknesses reported
Verified by `variation-architecture-invariants.test.ts` and the dry run: one customer-facing project (billing projects are filtered from the list and carry a banner pointing to the parent); contract = original + billed variations, unbilled approved variations are listed and counted once in the revised contract; a variation's claims exist only on its own scope and leave the BASE claims/stages byte-identical; the original contract value never moves; another organisation can neither read nor start variation billing and foreign rows are never consolidated; only a manager starts billing; lineage (parent, variation, schedule) and the audited amendment are recorded. V001 is untouched.
**Defect found and fixed (minimal, not a model change):** `createProjectFromAcceptedQuote`'s crash-recovery lookup matched projects by `originating_quote_ref`, which variation billing projects copy from their parent, so it could have linked a quote to an internal billing project. It now selects the BASE project only (regression test added).
**Weaknesses reported, model unchanged:**
1. Closing/completing the parent project does not cascade to its billing projects (they stay ACTIVE and claimable). Needs a guard or a rule in a later migration.
2. The billing project page is reachable by URL for any module member (read access is org-wide, as for any project); it is labelled but not hidden.
3. Opening commitments can be set on a billing project by a manager (a legitimate pre-claim mechanism) - an unneeded surface for variations.
4. Negative variations / cancellations / credit notes have no representation (documented as unsupported; no fabricated positive Sales).

## 3. Migration 0105 dry run: PASS
`scripts/dryrun-0105/run.mjs` (WASM Postgres, real migrations 0101-0105, hosted-shaped fixture, no connection to Supabase): **48/48 assertions** - existing rows identical, BASE defaults, INV-00021 posting and approved claims/stages still immutable, V001 unbillable until a manager-assigned audited schedule, new schedules cannot bypass approval/freeze/claim limits, duplicate/over-claim/cross-scope claims refused, other-org isolation, members cannot write or call the amendment function. Read-only assessment of the hosted data found no row that can violate a 0105 constraint. Forward recovery and the hosted procedure are in `migration-0105-recovery.md`. **Not applied to hosted.**

## 4. Effective Preview write-flag status: OFF (no exposure of values)
`vercel env ls` metadata (names, scopes, types; no values read or decrypted):
- `NEWQUIP_CIN7_WRITES_ENABLED` exists **only** as a Preview variable scoped to branch `feature/cin7-claim-posting` (type Config, created ~16h earlier). There is no unscoped Preview, Production or Development entry. For branch `feature/newquip-poc-integration` the variable is **unset, therefore OFF**.
- **Code now guarantees it:** `cin7WritesEnabled()` is OFF unless the variable is exactly `"true"` and is **forced OFF on Production** (`VERCEL_ENV=production`) regardless of the variable. Every Cin7-writing action derives its gate from this single function (pinned by test).
- **Separate finding the owner must act on:** the Supabase and encryption variables for Preview (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY`, `NEXT_PUBLIC_*`) are scoped to branch `feature/newquip-projects-poc` as overrides, alongside unscoped Preview values. The integration branch therefore inherits the **unscoped Preview** values; I did not read them and cannot tell which database they point at. Before anyone signs in to the integration Preview, the owner should add branch-scoped overrides for `feature/newquip-poc-integration` that point at the POC Supabase project (as was done for the earlier POC branches), or confirm the unscoped values already do. Until then the Preview must not be used with data.
- No Sale creation or invoice posting occurred or can occur during this validation (flag unset, all tests use fakes).

## 5. First disposable API proof
See `cin7-acceptance-proof-plan.md`: P0 read-only prerequisites (a read-only check is built into the Sale creation panel) through P7 variation Sale, each with an exact operation, disposable fixture (R100,000 contract in 10/60/30 stages, VAT R15,000, one SKU x2), expected effects, approval sentence and stop conditions. P1 (create the Advanced Sale) is the first external write; P0 is read-only and can run as soon as the owner has created the dedicated customer and signed in. Nothing in P1-P7 has run.

## 6. Security findings
See `security-npm-audit-assessment.md` (branch `security/newquip-integration-npm-audit-assessment`). 11 advisories (1 critical Next RCE x3, 6 high, 4 moderate); a targeted trial (next/eslint-config-next 16.4.3, zod 4.6.7, vitest 4.1.12, lockfile updates) leaves only the unreachable-in-practice `uuid`/`exceljs` moderate and passes the full suite and build. PR #109 pins next 16.3.4, which is still within today's vulnerable range. No `npm audit fix` was run.

## 7. Remaining owner approvals
1. Branch-scoped Supabase/encryption overrides (or confirmation) for the integration Preview, section 4.
2. Create the dedicated disposable Cin7 customer; verify disposable SKU movement history; then P0 sign-in checks.
3. Written GO for each of P1 to P7, each with its own sentence.
4. Hosted migration 0105 (after the dry-run is accepted): by name, never `db push`.
5. Security PR: approve the dependency bump set and the `uuid` risk decision; decide on #109.
6. Decisions on the four weaknesses in section 2; Sean's accounting decisions S1-S17 before any production use.
7. Final merge strategy for #121/#122/#123 (all draft).
