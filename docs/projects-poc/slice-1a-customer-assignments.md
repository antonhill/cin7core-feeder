# NewQuip Slice 1A: customer-to-Rep assignments and the authorisation foundation

Status: implemented on `feature/newquip-rep-customer-assignments`, **migration 0118 NOT applied to hosted Supabase** (owner approval required). Stacked on PR #126
(`feature/newquip-completion` at `ca7f4e6`). This slice changes **no existing permission, RLS policy, role, quotation or Project**, activates **no strict roles**, and writes nothing to Cin7 or
Xero. It does not start Slice 1B.

## 1. What this slice adds

| Piece | Location |
|---|---|
| Additive table `customer_rep_assignments` (append-only history) + guard trigger, no client policy | `supabase/migrations/0118_newquip_customer_rep_assignments.sql` |
| Transactional SQL test (guards, partial unique index, privileges, RLS) | `supabase/tests/0118_newquip_customer_rep_assignments.test.sql` |
| Assignment store: assign / end / reassign / history | `src/lib/newquip-assignments/assignment-store.ts` |
| Visibility helpers derived from assignments | `src/lib/newquip-assignments/visibility.ts` |
| Allowlist-built, cost-free Rep projection | `src/lib/newquip-assignments/rep-view.ts`, `rep-commercial.ts` |
| Rep read boundary (new, no UI yet) | `src/app/newquip-rep/actions.ts`, `rep-actor.ts` |
| Assignment management actions (Manager/administrator, no UI yet) | `src/app/newquip-rep/assignment-actions.ts` |
| Test support: FakeDb emulates 0118 incl. its guards | `src/lib/projects/__tests__/fake-db.ts` (`assignmentsApplied`) |
| One reviewed allowlist entry (a new file calls `createServiceRoleClient`) | `scripts/service-role-allowlist.json` |

No existing action, store, page, route, policy or migration was modified. (`fake-db.ts` and the allowlist are test/guardrail files.)

## 2. Rules

* **Visibility follows the customer, not the creator.** A quotation is visible to a Rep when its *current* customer (latest `newquip_quote_customers` snapshot, not a `(cleared)`
  marker) is one of the Rep's *active* assignments. Who created the quotation is irrelevant. A quotation with no customer yet is visible to nobody through this boundary (enquiries
  arrive in a later slice). A quotation moved to another customer follows the new customer's Reps.
* **History follows the customer.** Every state and revision (drafts, review, approved, issued) of an assigned customer's quotations is visible; ending the assignment removes all of it
  on the next read.
* **Visibility is not authority.** An assignment grants *seeing* only. Editing, signing off, approving, issuing, sending and accepting stay role-gated by the existing code, untouched.
* **Multiple Reps per customer** are allowed (one *active* row per customer + Rep, enforced by a partial unique index). Assigning is idempotent.
* **Append-only history.** Ending needs a reason (>= 3 chars) and records who/when; the row is never deleted or reopened. Re-assigning the same Rep later is a new row.
* **Reassignment is ATOMIC.** It is one database function, `customer_rep_reassign` (in the unapplied migration 0118), i.e. ONE transaction: it ends only the from-Rep's active assignment and
  creates the replacement together, or does neither. If anything fails (validation, the replacement insert, a constraint) the whole call rolls back and the previous assignment is exactly as
  it was: the customer is never left without its Rep, and other Reps on the same customer are never touched. Concurrent changes to one customer are serialised by a per-customer advisory lock
  plus a row lock on the assignment being ended. If the new Rep is already assigned (several Reps per customer), the old access is ended and no duplicate is created. A replayed request is
  refused (the old assignment is already ended) and changes nothing. The function is SECURITY INVOKER (runs with service_role's narrow grants, widening nothing), executable by service_role only,
  and requires the new Rep to be a member of the same organisation (the application additionally checks the Rep role and the actor's permission, unchanged). There is **no fallback** to separate
  end + create calls: without the function the application fails closed.
* **Audit.** The authoritative record of who changed what, when and why is the append-only assignment history itself, written inside the same transaction as the change, so it can never disagree
  with the state. The additional activity-log entry is written by the application after the commit and is best-effort by the platform's design (`logActivity` swallows its own errors); it is
  written only for a reassignment that succeeded.
* **Same denial for everything.** Unassigned, revoked, another organisation's, and non-existent quotations all return exactly `Quote not found.` (no probing), and the check runs *before*
  any quotation data is loaded.
* **Rep responses are cost-free by construction.** They are built from named fields (no estimator state, baseline or margin sheet), the evaluation is produced with cost withheld, and a
  final recursive pass removes and then asserts the absence of any cost/margin/supplier/landed/freight/GP key. An administrator using the Rep boundary gets the same response, and still
  needs an assignment.
* **Fails closed** when 0118 is not applied: no assignments exist, so nothing is visible and the Rep boundary reports "not available". It never falls back to organisation-wide reads.
* **Cin7 is the customer master.** `cin7_customer_id` is the Cin7 customer GUID (as on quotation snapshots). The synced `customers` table has no Cin7 id (keyed by org + name), so the
  management action validates the GUID format; a verified customer picker (reusing the existing read-only lookup) belongs to the UI slice.

## 3. Verification

See the final report on the PR for the exact-head test and CI results. Mutation checks performed for this slice: 10 application mutants (visibility check removed, ended assignments
still granting access, org scoping removed, estimator state leaked, Rep role not required, reassignment order inverted, latest-customer filter dropped, manager gate dropped, cost
stripping removed, unpaged reads) were all caught; 4 migration mutants (guard trigger removed, partial unique index broken, over-broad service_role grant, RLS disabled) were all caught.

**Reassignment atomicity review (PR #127 follow-up).** The first version of reassignment performed separate end and create calls (not one transaction), so a failure after the end could leave a
customer with no Rep; that was confirmed in the code and replaced by the single database function above. Evidence: the new tests fail against the old implementation (the table state after a failed
reassignment differs from before it) and pass against the new one; 6 of 7 SQL-function mutants are caught (the seventh, removing the reason check, is equivalent because the table CHECK still
refuses a trivial reason); and a real-Postgres, multi-connection run (`supabase/tests/manual/0118_reassign_concurrency.mjs`, Postgres 17.5 with all 119 migrations): a competing request
waited for the first transaction then lost; 150 rounds of 10 parallel conflicting requests gave exactly one success per intended Rep with no duplicate active Rep, no uncovered customer and the
unrelated Rep untouched; 120 randomised failure-injection rounds rolled back about 300 calls that failed after updating the old row, leaving no trace; 0 invariant violations. With the locks removed
from the function the database guards still prevent corruption but competing requests fail with raw internal errors and a duplicate-key leak, so the locks are what make the behaviour clean. The CI
SQL suite is single-session and cannot race; the concurrency script is a manual check (it needs `pg` and a throwaway database).

## 4. Migration compatibility and rollback assessment (0118)

* **Additive and independent.** One new table, two functions (the history guard and the atomic reassignment), one trigger. No existing table, column, policy, grant, function or row is touched; nothing existing references it.
* **Order-independent deployment.** The application can be deployed before or after the migration: until applied, the new boundary reports "not available" and every existing screen is
  unchanged. Applying it changes nothing for any user until assignments are created.
* **Bootstrap.** Applies cleanly after 0001-0117 (119 files) in a clean database; the SQL test passes; 4 migration mutants fail the test as they should.
* **Ledger.** 0114 is still outstanding on hosted and is independent; 0118 would be registered after 0117 (entry 132 expected) when the owner approves.
* **Privileges.** RLS enabled with **no client policy**; `anon`/`authenticated` have no privilege; `service_role` has SELECT, INSERT and column-level UPDATE of the three "end" columns only (no
  DELETE/TRUNCATE/REFERENCES/TRIGGER), matching the 0117 least-privilege pattern. `customer_rep_reassign` is executable by `service_role` only (revoked from public, anon and authenticated).
* **Rollback.** `drop function customer_rep_reassign(uuid, text, text, uuid, uuid, text, text, text, text); drop table customer_rep_assignments cascade; drop function customer_rep_assignments_guard();` returns the schema to 0117. No data elsewhere depends on it. Rolling back
  loses only assignment history (which would be exported first if it contained real assignments).
* **Hosted impact if applied:** none visible; the table starts empty.

## 5. Existing actions that STILL rely on organisation-wide visibility (unchanged by this slice)

Every action below authorises the actor and scopes by organisation, but not by customer assignment. Any holder of the required role sees every quotation/project of the organisation.

**Quotation actions (`src/app/newquip-grower/`)** (48 exported actions):
* `actions.ts` (12): `getGrowerViewerAction`, `listGrowerQuotesAction` (**lists all organisation quotations**), `createGrowerQuoteAction`, `getGrowerQuoteAction`, `previewGrowerDraftAction`,
  `saveGrowerDraftAction`, `sendGrowerQuoteToEstimatorAction`, `returnGrowerQuoteToRepAction`, `signOffGrowerQuoteAction`, `returnGrowerQuoteToEstimatorAction`, `approveGrowerQuoteAction`,
  `createProjectFromGrowerQuoteAction`
* `cost-actions.ts` (9): `getQuoteCostEstimateAction`, `captureLatestCostsAction`, `selectSupplierAction`, `recalculateCostsAction`, `recordFxRateAction`, `confirmUnitBasisAction`,
  `acceptIncompleteCostsAction`, `setManualCostEstimateAction`, `clearManualCostEstimateAction` (cost holders only)
* `customer-actions.ts` (6): `getQuoteCustomerAction`, `searchQuoteCustomersForQuoteAction`, `selectQuoteCustomerAction`, `clearQuoteCustomerAction`, `chooseQuoteContactAction`, `refreshQuoteCustomerAction`
* `document-actions.ts` (4): `getCompanyProfileAction`, `saveCompanyProfileAction`, `getQuoteDocumentsAction`, `issueQuoteDocumentAction`
* `delivery-actions.ts` (6): `getQuoteDeliveryAction`, `sendQuoteToCustomerAction`, `retryQuoteSendAction`, `recordCustomerResponseAction`, `reviewCustomerResponseAction`, `revokeResponseLinksAction`
* `mapping-actions.ts` (3): `getQuoteScopeAction`, `getMappingHistoryAction`, `saveReusableMappingAction`
* `template-actions.ts` (8): organisation configuration (billing-schedule templates), not customer data

**Routes:** `GET /api/newquip-quote-documents/[id]` (any actor with module access can download any issued PDF of the organisation), `GET /api/newquip-response-evidence/[id]`
(rep, manager or estimator), `POST /api/newquip-quote-responses` (rep or manager).

**Projects and approvals:** `src/app/projects/{actions,cin7-actions,delivery-actions,physical-actions,procurement-actions,profitability-actions,variation-billing-actions}.ts` (50 actions),
`src/app/approvals/{actions,role-actions}.ts` (18 actions).

**Database API:** the existing `org members read ...` `SELECT` policies (`is_org_member(org_id)`) on `newquip_quotes`, `newquip_quote_documents`, `projects`, `project_stages`,
`project_progress_events`, `customers` and the other NewQuip/Project/approval tables are unchanged: any signed-in organisation member can read those rows directly through the
database API. (Out of scope and unrelated: the older generic Quotes module in `src/app/quotes`, which uses a different table.)

## 6. Audit of existing user-session (RLS-subject) database access

Question: if client reads on the NewQuip/Project tables were removed, would anything in the app break?

Method: every module that creates a browser or user-session Supabase client (`createBrowserSupabaseClient`, `createSessionClient`, `createServerClient`) was listed, and the tables each reads were extracted.

| File | Tables read with the user's session |
|---|---|
| `src/middleware.ts`, `src/lib/current-org.ts`, `src/actions/active-org.ts`, `src/actions/auth.ts`, `src/app/signup/actions.ts` | `org_members`, `organizations`, `super_admins` |
| `src/lib/require-privileged.ts`, `src/lib/require-super-admin.ts` | `organizations`, `super_admins` |
| `src/app/login`, `signup`, `mfa-challenge`, `settings/security`, `auth/callback` | none (authentication calls only) |

**Result:** no NewQuip, Project, approval, customer or document table is ever read through an RLS-subject client. All application reads of those tables go through the service-role
server code. The org-wide read policies therefore protect nothing the app itself relies on; they are only an exposure to anyone holding a valid session calling the database API
directly. **Caveat (UNKNOWN):** this covers this repository's code. Any external client, script or third-party integration using a user JWT against those tables is not visible from the code
and must be checked (hosted API logs) before the cutover.

## 7. Slice 1B cutover proposal (strict functional roles and database-policy cutover). NOT started.

Separate PR and separate owner approval for each numbered stage. Nothing here is implemented in 1A.

**Facts the plan rests on (read-only, hosted, at 2026-10-31):** strict roles is off (`approval_settings` has no row); the NewQuip organisation has 4 members and 4 functional-role rows;
effective-role logic is `src/lib/approvals/roles.ts` `effectiveRoles` (explicit roles override the tier mapping; with none and strict off a member is Rep+Estimator, an admin is
Rep+Estimator+Manager+Administrator).

1. **Dry-run report (read-only, no change).** A report of every member: tier, explicit roles, effective roles today, effective roles under strict. Lists who loses a role. Owner reviews.
2. **Complete explicit roles.** Through the existing `org_role_assign`/`assignRole` path, add an explicit role row for everyone who must keep authority (notably any admin who must remain
   Manager: under strict, an admin without an explicit MANAGER row keeps only ADMINISTRATOR, which never approves). Owner approves the list.
3. **Populate assignments.** Owner supplies customer -> Rep mappings (including which existing customers have quotations). Assign via `assignRepToCustomerAction`. Reps with no assignment see an empty
   Rep workspace by design.
4. **Scope the existing Rep screens (code PR).** In strict mode, a user whose **only** role is REP should be limited by assignment in `listGrowerQuotesAction`, `getGrowerQuoteAction`,
   `saveGrowerDraftAction` and the quote-scoped customer/document/delivery reads, and in the document and evidence download routes. Estimator and Manager stay organisation-wide. Tests: the negative matrix
   below.
5. **Activate strict roles** for the NewQuip organisation (existing `setStrictRoles` upsert; recorded in `org_functional_role_events`). **Rollback:** set it back to false (instant, restores the
   tier fallback; no data changes).
6. **Database-policy cutover (new migration, e.g. 0119).** Because section 6 shows no client reads, revoke `SELECT` from `authenticated` (and `anon`) on the NewQuip, Project and approval tables
   (list to be generated from the catalogue at that time; it includes `newquip_quotes`, `newquip_quote_customers`, `newquip_quote_documents`, `newquip_quote_sends`, `newquip_quote_responses`,
   `newquip_response_*`, `newquip_company_profiles`, `newquip_fx_rates`, `newquip_package_mappings`, `newquip_project_templates*`, `projects`, `project_*`, `approval_*`). Keep the
   existing policies in place for the first release (inert without the grant); drop them in a later release. **Rollback:** re-grant `SELECT` (policies still exist), instant, no data change.
   Pre-check: hosted API logs show no user-JWT reads of those tables for 14 days. SQL tests: a signed-in organisation member gets `permission denied` on every listed table; `service_role`
   behaviour unchanged.
7. **Verification before and after each stage:** the existing suite; the negative matrix; a Preview walk-through as Rep, Estimator and Manager through quote, approval, issue, customer response,
   Project creation; confirm the Toolbox keeps working because it reads through the service role.

**Negative access matrix for 1B (and extended from 1A's tests):** unassigned Rep; revoked Rep; cross-organisation identity; Rep opening another Rep's quotation by id (action, document
download, evidence download); Rep calling approve/sign-off/issue/send/create-Project; member calling the database API directly on each restricted table; subcontractor identity (later slice)
calling any of them.

**Owner decisions needed before 1B:** the customer -> Rep mapping; which admins must keep Manager; the 14-day log window and who reviews it; whether Estimators and Managers stay organisation-wide (recommended).

## 8. Known limits of this slice

* No UI: the boundary and management actions are server-only until Slice 3 and the 1B management screen.
* Enquiries (a quotation before a customer exists) are not visible to a Rep through this boundary; the enquiry entity is Slice 3.
* The assignment action validates GUID format, not that the id exists in Cin7 (no live Cin7 call was added). A verified picker comes with the UI.
* The assignment/ownership of *drafts without a customer* and ownership transfer of open drafts is part of Slice 3.
