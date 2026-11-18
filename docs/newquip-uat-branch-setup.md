# NewQuip UAT: isolated Supabase branch and Vercel Preview (setup record)

Status: documentation only. No secret, key, token, session, password or mailbox address appears here; variables are named, never valued. Production (Supabase project `pnzwjqjovxxdikxtfngq`, Vercel Production) is not touched by anything in this record.

## 1. What exists

| Item | Value |
|---|---|
| Supabase branch | name `uat-ux006`, project ref `wevhibjvinmdvuuyurql`, URL `https://wevhibjvinmdvuuyurql.supabase.co`. Schema only (no production data copied). Non-persistent; bills hourly compute until deleted. |
| Vercel project / scope | `cin7core-feeder` / `spark18` |
| Git branch that carries the Preview | `feature/newquip-ux006-final-candidate` (PR #197). `integration/newquip-ux006-review` receives the same commits. |
| Env scope of every override | Preview, for the single git branch above only. Nothing project-wide, nothing in Production. |
| Organisation on the branch | `UAT ZZ Demo Org`, trialing (no MFA enrolment redirect). It reuses the app's hard-coded NewQuip POC allowlist id (`src/newquip/access.ts`), otherwise the app refuses it. The id exists only on the branch database. |
| Accounts | Three auth users, each `member` with exactly one functional role: REP, ESTIMATOR, MANAGER. No ADMINISTRATOR. |
| Disposable data | customer `ZZ UAT Demo Farm (Pty) Ltd` (local `customers` row, contact on a non-deliverable `.invalid` domain); LED catalogue item mapped (`led_light` v1) to the test SKU `ZZ-UAT-LED-SKU`; `flex_auger` (M75) and `penning_package` deliberately unmapped (they exercise the Manager exception); demo quotation `NQ-Q-0001`. |

## 2. Branch-scoped Vercel overrides (names only)

Set with `vercel env add <NAME> preview feature/newquip-ux006-final-candidate --project cin7core-feeder --scope spark18` (values piped on stdin; `NEXT_PUBLIC_*` as `--no-sensitive`, the rest `--sensitive`).

| Variable | Set to |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_URL` | the UAT branch URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the UAT branch anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | the UAT branch service-role key |
| `ENCRYPTION_KEY` | a new random throwaway value, so no production ciphertext can ever be decrypted here |
| `CRON_SECRET`, `SYNC_SHARED_SECRET` | new random values |
| `RESEND_API_KEY` | an invalid placeholder: no email can leave; notifications stay in-app and are recorded as failed or suppressed |
| `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_WEBHOOK_SECRET`, `LEMONSQUEEZY_STORE_SLUG`, `LEMONSQUEEZY_BUY_LINK_ID`, `LEMONSQUEEZY_STORE_ACTIVE` | inert placeholders (`LEMONSQUEEZY_STORE_ACTIVE` = `false`) |

Deliberately NOT set on this branch (so they are absent): `NEWQUIP_DEMO_MODE_ENABLED`, `NEWQUIP_DEMO_OWNER_EMAIL`, `NEWQUIP_CIN7_WRITES_ENABLED`, `RESEND_FROM_EMAIL`, `NEWQUIP_PRODUCTION_EMAIL_ENABLED`, `NEWQUIP_PUBLIC_PORTAL_URL`, `NEWQUIP_INTERNAL_APP_URL`, `NEWQUIP_LINK_ENVIRONMENT`, `NEXT_PUBLIC_NEWQUIP_APPROVALS_DISABLED`, `NEXT_PUBLIC_SITE_URL` (approval links then use the stable branch alias). The same-named variables that exist for other branches (for example `feature/newquip-completion`) do not apply to this branch.

## 3. Migration history on the branch

A fresh branch equals production's history (116 entries). Differences found and handled, on the BRANCH only:

1. `0114` (SUPPRESSED notification status), `0120` (project partial claim lines) applied with `apply_migration`.
2. History drift: the branch listed `0115`, `0116`, `0117` as applied, but their objects (the customer, document, send and response tables, company profile, portal tables, functions and the documents bucket) were absent. The three files were re-run from the repository (idempotent). Counts then matched production (112 tables, 118 functions, 104 policies, 579 constraints).
3. `0122` (database-level Rep isolation, PR #196) applied; its pgTAP-style test passes on the branch; rollback and re-apply were exercised. `0119` is not applied.
4. DML grants production has for `authenticated` / `anon` / `service_role` were mirrored (a branch replay lacks them), then 0122 revoked the protected tables.

## 4. How sessions are minted (no email, no password)

Sign-in in the app is an emailed 6-digit code. For automated verification a session is created server-side: the Auth Admin `generate_link` (magiclink) returns a one-time token hash, `verifyOtp` on it returns a real session for that user, and the session is stored in the SSR cookie `sb-wevhibjvinmdvuuyurql-auth-token` (value `base64-` + base64url of the session JSON, split into `.0`, `.1` chunks above 3180 characters). The minting script and session files are local, mode 0600, never committed. Sessions last about one hour; re-mint to refresh. A human tester cannot be handed such a session without handing over a secret; they use the emailed code instead (see the presenter run sheet).

## 5. The Cin7 customer blocker (a SEPARATE OUTSTANDING INTEGRATION GATE: NOT TESTED / OPEN, never a pass)

Selecting a customer on a NEW quotation (`selectQuoteCustomerAction`) calls `readCin7Customer`: it needs the single active `cin7_instances` row with the hard-coded POC instance id, decrypts its key with `ENCRYPTION_KEY` and makes a LIVE read to the Cin7 API for that exact customer name. The branch has no such row (Cin7 credentials were deliberately not copied), so the selection screen cannot complete there.

Handling: the UAT quotations (`NQ-Q-0001` and the fresh `NQ-Q-0003`) are PRE-SEEDED with exactly what the app would have stored: two append-only `newquip_quote_customers` rows (seq 1 "Customer selected from Cin7", seq 2 "Quotation contact set", built by the app's own `buildCustomerSnapshot` and `withChosenContact`, hash by `snapshotHash`), with `quote.customer_name` already equal to the customer name. The workflow therefore starts from the Rep step with the customer already chosen. A new quotation created on the Preview will still hit the blocker at customer selection.

Options to remove it (owner decision):
- (a) supply read-only credentials for a Cin7 sandbox containing a customer named `ZZ UAT Demo Farm (Pty) Ltd` (creating it in Cin7 is a Cin7 write, so the owner does it); the instance row is then inserted on the branch, encrypted with the Preview `ENCRYPTION_KEY`;
- (b) a code seam: an env-gated stub of `readCin7Customer` that is impossible in Production, returning a fixed `.invalid` customer;
- (c) accept that only the pre-seeded quotation (and clones of it) demonstrate the full journey.

## 6. Teardown

1. Supabase: delete the branch `uat-ux006` (dashboard, or the `delete_branch` tool / `supabase branches delete`). This removes every account, session and row.
2. Vercel: remove the branch overrides, for each name in section 2: `vercel env rm <NAME> preview feature/newquip-ux006-final-candidate --yes --project cin7core-feeder --scope spark18`, then list the branch environment and check each entry itself is gone.
3. Delete or leave the Preview deployments of the branch; they stop working against a deleted database. Do not promote any of them.
4. Local: delete the 0600 key and session files and the minting script.
