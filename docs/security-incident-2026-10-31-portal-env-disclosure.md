# Security incident 2026-10-31: public portal persisted its environment (incl. the Supabase service-role key) into `activity_log`

Status: **code remediation prepared on `feature/newquip-completion` (not pushed, not deployed); credential rotation, stored-data sanitisation and the portal redeploy are awaiting owner approval.**
No secret value appears in this document. Key NAMES are not secrets and are listed where needed.

## 1. What happened
* `portal/app/quote-response/actions.ts` called `submitPublicResponse(..., { ip, env: process.env })`.
* `src/lib/newquip-portal/store.ts` wrote `environment: ctx.env` into `activity_log.detail` for every customer response (accept / decline / request changes).
* `activity_log` has the policy `org members read activity_log` (`is_org_member(org_id)`) and `authenticated` holds SELECT, so every member of the organisation can read it through the database API.
* Introduced with the portal commit `c0c2931` (2026-10-30 17:58 SAST). Found by the independent pre-release review on 2026-10-31.

## 2. Exposure established (read-only evidence)
* Exactly **one** affected row: `activity_log.id = 700289d9-3e64-4a2c-ae30-86d193e8b526`, action `newquip.customer_link_accepted`, 2026-10-31 07:02:18 UTC. `detail.environment` is a 53-key object.
* Non-system variable NAMES in it: `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `NEWQUIP_INTERNAL_APP_URL`, `NEWQUIP_LINK_ENVIRONMENT` (plus Vercel runtime/system variables and build-tool flags). That matches the `newquip-customer-portal` project's four variables. **No** `RESEND_API_KEY`, `ENCRYPTION_KEY`, `CRON_SECRET`, `SYNC_SHARED_SECRET`, `LEMONSQUEEZY_*` or `VERCEL_OIDC_TOKEN` is present, so the only credential disclosed is the `cin7toolbox` service-role key.
* Only one customer-link response has ever been recorded (`newquip.customer_link_*` rows: 1), so no earlier row is affected. Rows since 07:00 UTC with an `environment` detail key: 1.
* Who can read it: 4 members of the NewQuip organisation (3 not owner/admin). Anyone with direct database access also can.
* **Access evidence.** Supabase API-gateway logs from 2026-10-31 07:00 UTC onward show for `/rest/v1/activity_log` only `POST` inserts (about 24/hour, application writes) and six `HEAD` count requests in the first hour, and **no `GET`**. A `HEAD` returns no body, so there is no evidence the row was read through the database API. Limits: these logs are the API gateway only (24-hour window, so they begin at the incident); they do not show reads through the SQL editor, a direct Postgres connection or the Supabase dashboard. During the review the row was inspected (key names and object type only, never values) with administrator tooling.
* Treat the key as **compromised-in-principle**: it sat in a table readable by four accounts for about nine hours, and in Supabase backups from that point on.

## 3. Code remediation (this branch)
| Change | File |
|---|---|
| Log the coarse label `environmentOf(ctx.env)` (`"preview"`/`"production"`/`"development"`), never the environment | `src/lib/newquip-portal/store.ts` |
| Defence in depth: `redactSecrets` removes (a) values of secret-named variables, (b) JWT-shaped strings, (c) environment-shaped objects, (d) values under credential-named keys; applied to the portal audit insert and to **every** `logActivity` write | `src/lib/audit-safety.ts`, `src/lib/activity-log.ts` |
| Regression tests: hostile environment with sentinel secrets does not reach any audit/response/notification row; the incident's exact code fails them; guard unit tests; static test that no `detail:` references `process.env`/`ctx.env` | `src/lib/__tests__/audit-safety.test.ts`, `response-portal.test.ts` |
Legitimate evidence is preserved: quote, response, link, document id and hash, revision, origin hint, validation label, expiry and submission time.

Adjacent review: a repository-wide search found no other place that puts `process.env`/an environment object into a persisted record. `runP0` receives `process.env` only to evaluate gates and returns a report. Residual note: `authenticated` also holds `INSERT/UPDATE/DELETE/TRUNCATE` table privileges on `activity_log` (RLS blocks the first three; `TRUNCATE` is not subject to RLS but is not reachable through the database API). Revoke the excess privileges in a later hardening migration; not part of this fix.

## 4. Containment (in order; each needs owner approval where marked)
1. **Do not submit any customer response** (accept/decline/changes) through the portal. [no approval needed]
2. **Optional immediate stop of further disclosure** without waiting for the code: revoke the one live preview response link (a database write) so no customer-link submission can occur. [owner approval]
3. **Deploy the fixed portal** (manual: the portal project has Git deployments disabled, so merging never redeploys it): from `portal/`, `vercel deploy --prod` with the portal's project and organisation IDs, only after the fix is on the branch and its CI is green. [owner approval, because it is a Production deployment of the portal]
4. Rotate the key (section 5). Until step 3 is done, do not put the new key into the portal (or: leave the portal on the revoked key so it fails closed as "unavailable").

## 5. Credential rotation plan (nothing rotated yet)
**What is compromised:** the `cin7toolbox` (`pnzwjqjovxxdikxtfngq`) `service_role` key. It bypasses all row-level security.

**Consumers (all must receive the new key):**
| Consumer | Where the old key lives | Redeploy needed |
|---|---|---|
| Internal Toolbox, **Production** (`cin7core-feeder`) | Vercel env `SUPABASE_SERVICE_ROLE_KEY` (Production) | yes: a Production deployment (owner approval) |
| Internal Toolbox, **Preview** (all branches) | Vercel env (Preview, all branches) and the branch-specific `feature/newquip-projects-poc` entry | next push/redeploy of each branch you still use |
| Public portal (`newquip-customer-portal`) | Vercel env (Production) | yes: manual CLI deploy |
| Developer machines / worktrees | local `.env.local` files; `scripts/probe-*.mjs` read the key from the environment | update locally |
| CI | none: the workflows use no Supabase secret (only `GITHUB_TOKEN`) | none |
| Database-side | no `pg_cron`/`pg_net`; `supabase_vault` is installed; nothing in the repository's functions references the key | check the Vault for a stored copy (owner) |
The Cashflow App project (`zknhikeihzfdsvtxamoj`) is a different Supabase project and is unaffected.

**Method.** First check in the Supabase dashboard (Project Settings, API Keys) which key system the project uses.
* *New API keys available (preferred):* create a new secret key; add it everywhere; verify; then **disable the legacy `service_role` key**. The anon key and user sessions are untouched.
* *Legacy JWT keys only:* the `service_role` key cannot be rolled alone; rotating the JWT secret changes **both** the anon and service-role keys, signs out all users, and requires updating `NEXT_PUBLIC_SUPABASE_ANON_KEY` in both Vercel projects and rebuilding them. Plan a maintenance window.

**Sequence (low downtime):**
1. Create the new key (do not paste it into chat, tickets or logs).
2. Update Vercel with `--project` on every command (the CLI fails silently without it): `cin7core-feeder` (Production, Preview all branches, and the branch-specific entry), and `newquip-customer-portal` (Production). List afterwards to confirm each entry's age changed.
3. Deploy the **fixed** portal first, then redeploy Production Toolbox (owner approval), then any Preview branches in use.
4. Verify the new key (read-only): Toolbox pages load for each role; portal link page shows a document (use a revoked/expired link: it should say so, not "unavailable"); the cron routes still authenticate.
5. **Revoke the old key** (disable legacy key / roll JWT secret).
6. Verify revocation: from a shell, send one read-only request with the old key taken from your own secure store and print **only the HTTP status** (expect 401). Never echo the key.
7. Record the time of each step in the incident log.

**Other credentials in the object:** none besides the key (section 2). `SUPABASE_URL` and the other variables are not secret. No other rotation is required by this incident.

## 6. Stored-data sanitisation (nothing run yet)
Order: **rotate and revoke first** (so the value left in backups is dead), then sanitise. Take or confirm a Supabase backup/PITR point beforehand.
```sql
-- Preconditions (read-only): exactly one affected row.
select count(*) from activity_log
 where id = '700289d9-3e64-4a2c-ae30-86d193e8b526' and jsonb_typeof(detail->'environment') = 'object';   -- expect 1

begin;
update activity_log
   set detail = (detail - 'environment')
                || jsonb_build_object('environment', 'preview',
                                       'sanitised', jsonb_build_object('at', now(), 'reason', 'credential disclosure incident 2026-10-31', 'approved_by', '<owner email>'))
 where id = '700289d9-3e64-4a2c-ae30-86d193e8b526'
   and jsonb_typeof(detail->'environment') = 'object';          -- expect UPDATE 1, nothing else
commit;

-- Verification (read-only):
select (detail ? 'environment') as has_env, jsonb_typeof(detail->'environment') as env_type,
       detail ? 'sanitised' as marked, detail->>'documentHash' is not null as evidence_kept
  from activity_log where id = '700289d9-3e64-4a2c-ae30-86d193e8b526';   -- env_type = string, marked, evidence_kept
```
`activity_log` has no immutability trigger, so this update is permitted; it touches one row, keeps the quote id, response id, link id, document id and hash, revision, origin hint and timestamps, and records that and why it was sanitised. The old value will remain in database backups/WAL until they age out; this is acceptable only because the key will already be revoked. A second scan afterwards: `select count(*) from activity_log where created_at >= '2026-10-30' and detail ? 'environment' and jsonb_typeof(detail->'environment') = 'object';` expect 0.

## 7. Verification and incident-review checklist
- [ ] Fix commit on the branch; exact-head CI green; the incident code fails the new tests (shown).
- [ ] Portal redeployed from the fixed commit; a post-deploy check that no new response has been submitted without owner presence.
- [ ] New key live in all consumers; old key returns 401; every consumer works.
- [ ] Row sanitised; scan returns 0; backups noted.
- [ ] Next controlled test response (owner-run, on the fixed portal) produces `detail.environment = "preview"` and no other environment data.
- [ ] Review who could read the row (4 members) and record that no read was evidenced in gateway logs.
- [ ] Lessons: never pass `process.env` across a module boundary; keep the guard and the static test; consider a dedicated portal credential (section 8.3); revoke excess table privileges on `activity_log`.

## 8. P1 release blockers from the same review
1. **Production approvals cron consuming Preview notifications.** Fixed in this branch by removing `/api/approvals-deliver` from `vercel.json` and making the route a no-op when no email provider is configured or the approvals kill switch is on (so it can never burn attempts). Production email stays off. Re-enable only after notifications carry the environment that created them: add `origin_env text not null` to `approval_notifications`, `approval_requests` and `newquip_quote_sends` (migration, owner approval), set at enqueue from the deployment environment, and make delivery, reminders and retries select only rows whose `origin_env` equals the running environment. (Today the 12 old FAILED notifications stay as they are.)
2. **Quotation-send retry.** Fixed in this branch: a retry from Production is refused when the send was prepared in Preview (`[PREVIEW]` subject, or any suppressed address) and otherwise requires every address to be a Cin7 contact of the selected customer or an approved alternative with its recorded reason; the check runs before the retry claim, so a refusal changes nothing. The durable fix is the `origin_env` column above.
3. **Least-privilege portal credential (design; not built).** The portal needs only: resolve a link (read `newquip_response_links` by id plus the quote/document it names), read one document file, record one response and its audit/notification rows, increment attempts. Proposed: a dedicated Postgres role `newquip_portal` (no login, no table privileges beyond the three `SECURITY DEFINER` functions `portal_resolve_link`, `portal_read_document`, `portal_submit_response`, each with a pinned `search_path`, validating the token hash inside the function, returning only the customer document model), plus a storage policy limited to the quotation-documents bucket (read). The portal then authenticates with a key for that role (a custom-role JWT signed by the project secret, or a pooled login role) instead of `service_role`, so a portal bug cannot reach any other table. Needs one migration and a portal change; owner approval and its own review.
4. Production email sending is **not** enabled by any of this.

## 9. Actions requiring explicit owner approval
1. Push the fix commit to `feature/newquip-completion` (changes PR #126's head; PR #127's base moves but its diff does not).
2. Revoke the live preview response link (database write).
3. Deploy the fixed portal to its Production target.
4. Create the new Supabase key and update the Vercel environments; redeploy Production Toolbox.
5. Revoke the old key.
6. Run the sanitising `UPDATE` (a hosted database write).
7. Any migration (`origin_env`, privilege hardening, portal role).
