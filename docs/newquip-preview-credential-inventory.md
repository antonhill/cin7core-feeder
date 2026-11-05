# Vercel Preview deployments built with Production credentials: inventory and remediation proposal

Date: 2026-11-04. Project `spark18/cin7core-feeder` (`prj_5TU8aVNRfE43hMFWya8vJHgOicf2`). Read-only review: nothing was deleted, changed, redeployed or re-protected. No secret appears here (variable NAMES and deployment URLs only). Values are hidden by Vercel, so "points at Production" is taken from the project's recorded setup (the project-wide Preview variables were created 98 to 124 days ago with the Production values; see also the owner notes on the 2026-10-31 environment-leak incident) and could not be re-read from the values themselves.

## 1. Protection (who can open a Preview)

* Vercel Authentication (SSO) mode `all_except_custom_domains`: every `*.vercel.app` deployment URL and branch alias, Preview and Production, answers `302 https://vercel.com/sso-api` to an unauthenticated visitor, on every path (verified by request on `/login`, `/api/sync` and `/api/webhooks/lemonsqueezy` of three different Previews). No password protection and no trusted-IP rule is configured. Only the custom domain `cin7toolbox.com` (Production) is public, as intended.
* One automation-bypass secret exists for the project (used by test tooling). Anyone holding it passes SSO on every Preview of the project. Its value was not read.
* Team `spark18` has one member, the owner (role OWNER). Fork protection (`gitForkProtection`) is ON. The GitHub repository `antonhill/cin7core-feeder` is **PUBLIC**: source code is readable by anyone; build logs and the deployed Preview are behind SSO.
* Vercel Cron runs only against Production; Previews are never cron-invoked. The routes that are "public by design" in `src/middleware.ts` (excluded from the app login: `/api/sync*`, `/api/delete-expired-trials`, `/api/notify-ship-by-changes`, `/api/approvals-deliver`, `/api/webhooks/*`) are guarded by `Authorization: Bearer CRON_SECRET` or an HMAC signature (Lemon Squeezy). On a Preview they sit behind SSO first, and the bearer value is the inherited Production `CRON_SECRET` (see section 3).

## 2. Inventory (1 069 deployments listed, 2026-11-04 07:30 UTC)

| Class | Count | Notes |
|---|---|---|
| Production (target production, branch `main`) | 491 | State READY; oldest 124 days. Not in scope. |
| Preview READY | 575 | Across about 150 branches; all created by account `antonhill`. |
| Preview ERROR | 3 | `fix/p0-product-search`, `dependabot/npm_and_yarn/multi-d8ec5a502f`, `feature/newquip-ux006b-stage2-steps`: no running app. |
| Preview CANCELED / other | 0 | |

Branch-scoped overrides present (names only; `vercel env ls --project cin7core-feeder --scope spark18`):

| Branch | Overridden names | Effect |
|---|---|---|
| `feature/newquip-ux006-final-candidate` | 13: `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY`, `CRON_SECRET`, `SYNC_SHARED_SECRET`, `RESEND_API_KEY`, `LEMONSQUEEZY_*` (5) | Isolated (UAT Supabase branch + inert third-party values). 2 Previews (0379ba1, 04ac6c7), both built after the overrides existed. |
| `feature/newquip-projects-poc` | 5: `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY` | Deliberately points at a deleted Supabase project (fails closed). 10 Previews. Still inherit Production `CRON_SECRET`, `SYNC_SHARED_SECRET`, `RESEND_API_KEY`, `LEMONSQUEEZY_*`. |
| `feature/newquip-completion` | `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `NEXT_PUBLIC_SITE_URL`, `NEWQUIP_PUBLIC_PORTAL_URL`, `NEWQUIP_DEMO_MODE_ENABLED`, `NEWQUIP_DEMO_OWNER_EMAIL`, `NEWQUIP_CIN7_WRITES_ENABLED` | **No Supabase override**: its 75 Previews use the Production database and service-role key; this is the owner's active UAT/acceptance Preview (Cin7 writes flag ON by owner decision, email allowlist in code). |

Everything else inherits the project-wide Preview variables (13 names): `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY` (a Preview-only value exists, created 121 days ago, same age as Production's; not shown whether different), `RESEND_API_KEY`, `LEMONSQUEEZY_STORE_ACTIVE`, `LEMONSQUEEZY_BUY_LINK_ID`, `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_WEBHOOK_SECRET`, `LEMONSQUEEZY_STORE_SLUG`, `CRON_SECRET`, `SYNC_SHARED_SECRET`.

**Result:** of 575 READY Previews, 2 are isolated, 10 fail closed on the database (but carry Production cron/sync/email/billing secrets), and **563 are built with the Production Supabase URL, anon key and SERVICE-ROLE key** (75 of them `feature/newquip-completion`, 21 `integration/newquip-ux006-review`, 10 `feature/rwtsa-live-cin7-snapshot`, plus about 450 older, many over 60 days, back to `harden/*`, `quotes/*`, `lbl/*`, `security/*`, `dependabot/*` branches). One Preview (branch `main`, 5.9 days old) also exists. All 563 are active (READY), reachable only behind SSO.

Selected recent ones: `integration/newquip-ux006-review`: `cin7core-feeder-ja3ui2qq7-spark18.vercel.app` (0379ba1, newest), `-nyuvnutvh` (b6cfaa6), `-qhq5supp6` (b951f6c). `feature/rwtsa-live-cin7-snapshot`: `-qsfl4dtuv` (aae2e19, newest). Full list reproducible with `vercel list cin7core-feeder --scope spark18 --limit 100 --json` plus `-N <next>` pagination.

## 3. Exposure

* To open any of them one must pass Vercel SSO: today only the owner account, or a holder of the project's automation-bypass secret. Build logs and source are not public (the repository itself is public, so source is, independently).
* Once past SSO, the app's own login (email code, MFA for privileged users) still applies, but a Preview with the Production database lets any real Production user sign in and act on Production data; server actions use the service-role key after in-app authorisation. The risk is "tests and demos act on live data", not an anonymous hole.
* Machine endpoints: reachable only past SSO; additionally need the inherited `CRON_SECRET` / `SYNC_SHARED_SECRET` / Lemon Squeezy signature secret. Anyone who holds the Production `CRON_SECRET` and the bypass secret could run a sync against Production through any such Preview. Nothing found indicates that has happened (no evidence was searched for beyond the configuration; runtime logs were not reviewed).
* Preview-only code guards: Cin7 writes are Preview-gated by `NEWQUIP_CIN7_WRITES_ENABLED` (set only on `feature/newquip-completion`); Preview email goes through an allowlist.

## 4. Ranked risk

1. **High (design):** project-wide Preview variables = Production secrets, so every new branch push builds a Production-credential Preview (this is why the final-candidate branch needed overrides after its first push and why `integration/newquip-ux006-review` must not be pushed).
2. **High:** `feature/newquip-completion` (75 Previews) runs on the Production database with an active Cin7 write flag, by deliberate owner decision (UAT on shared data). Tests act on live NewQuip data.
3. **Medium:** about 450 stale READY Previews with the service-role key, each a live copy of old code (including pre-hardening `harden/*`, `quotes/*`, `security/*` builds with since-fixed vulnerabilities) that a bypass-secret holder can still call. Old code with known flaws on Production data is the sharpest part of this.
4. **Medium:** single automation-bypass secret, long-lived, used by test tooling; a public repository makes the code (not secrets) known to attackers.
5. **Low:** the 3 ERROR builds (no running app); `projects-poc` Previews (fail closed on data, hold inherited cron/sync/email/billing secrets).

## 5. Remediation proposals (NOT executed; need owner approval; safest first)

1. **Make branches safe by default.** Replace the project-wide Preview values of the 13 names with non-production ones: a dedicated Supabase "preview" branch/project, fresh random `ENCRYPTION_KEY`/`CRON_SECRET`/`SYNC_SHARED_SECRET`, inert `RESEND_API_KEY` and `LEMONSQUEEZY_*`. Effect: no future Preview touches Production. Breaks: any Preview that currently relies on the inherited Production data and has no override (notably `feature/newquip-completion` and anything the owner tests on Production data); give it its own override first (step 3). Does not affect already-built Previews (env is fixed at build), so it must be paired with step 2.
2. **Delete stale READY Previews** (Previews only, never target production): ordering, oldest and merged/closed-branch first, keeping the active ones: `feature/newquip-completion` newest Preview, `feature/newquip-ux006-final-candidate`, `integration/newquip-ux006-review`, `feature/rwtsa-live-cin7-snapshot` newest, and open-PR branches. Exact command per item: `vercel remove <deployment-url-or-id> --yes --scope spark18` (not `vercel api -X DELETE`). Candidate list to be produced from the JSON listing above and approved by the owner as a list; branch aliases disappear with their deployment. Breaks: shared links to those old Previews.
3. **Add branch overrides** (Supabase URL/anon/service-role and `ENCRYPTION_KEY`, plus inert `CRON_SECRET`, `SYNC_SHARED_SECRET`, `RESEND_API_KEY`, `LEMONSQUEEZY_*`) to long-lived branches that must keep working (`feature/newquip-completion` if it should move to an isolated database; `feature/rwtsa-live-cin7-snapshot`; `integration/newquip-ux006-review` to stop it building Production-credential Previews). The branch must exist before overrides can be set, so the first push builds a Production-credential Preview that must be deleted straight after.
4. **Rotate** the Production service-role/anon keys, `ENCRYPTION_KEY` and `CRON_SECRET` only if exposure beyond SSO is suspected. Nothing found suggests that: protection was active on every sampled Preview, the team has one member, and no public alias of a Preview exists. Rotating `ENCRYPTION_KEY` breaks decryption of stored encrypted data unless re-encrypted: do not rotate it casually. Rotating the project's automation-bypass secret is cheap and reasonable if the tooling copy may have leaked (it breaks the test harnesses until updated).
5. **Limit who can trigger Previews:** Vercel project "Ignored Build Step"/branch rules (build Previews only for branches with a prefix or open PR), keep fork protection ON, and consider making the repository private or restricting Dependabot Preview builds. Breaks: ad hoc branch Previews.

Ordering recommended: 3 for the branches in use, then 1, then 2 (delete only after replacements work), 5 as hygiene, 4 only on evidence.

## 6. Not verified

Exact values of any variable (hidden), including whether the Preview-scoped `ENCRYPTION_KEY` differs from Production's; whether specific older Previews were built before a given override existed (only the final-candidate pair was checked by build time); runtime logs for unexpected traffic; Vercel cookie lifetime and Safari behaviour of the SSO redirect; the fine-grained list of deployments to delete (to be agreed).
