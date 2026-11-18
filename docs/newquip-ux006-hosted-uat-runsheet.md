# NewQuip UX-006 hosted three-role UAT: run sheet

Status: docs only. Nothing here changes code, a database, a hosted user or a permission. It builds on `docs/newquip-uat-multirole-procedure.md` (#184): **how roles are decided, the capability matrix and the account facts are in that file and are not repeated here.** Read its sections 1 to 3 first.

Accounts are referred to by role only. **No password, login code, token, key or email address appears in this document, and none may be written into the evidence column, a screenshot name, a chat or a log.**

Run this against the Vercel Preview of the **final PR head** (the integration branch `integration/newquip-ux006-review`, draft PR #180, "DO NOT MERGE"). Production is never used.

## 0. What the owner has to do (the short version)

1. Decide the run date and tell the three testers (Rep, Estimator, Manager). Each tester signs in **themselves**, on their own device or in their own browser profile. Nobody shares a password, a login code or a screen with credentials on it.
2. Before the run, check every row of section 2 in the Vercel dashboard (Preview scope of the project) and send the coordinator the answers (value present / absent, never the value of a secret).
3. Confirm the disposable-data rule (section 1) and the named test customer.
4. Be the **observer** with the Administrator account (read-only, can see cost), as in #184.
5. Approve (or decline) separately: the Rep-isolation migration (step 15), and any run of the hosted D-12 database check beyond the screens (section 5).
6. After the run, send the coordinator the evidence table (screenshots by file name, quotation references, times). The coordinator then runs the read-only SELECT queries in section 6.

## 1. Rules for the run

| Rule | Detail |
|---|---|
| Accounts (by role) | One Rep, one Estimator, one Manager (each holds exactly one explicit functional role), plus the Administrator-owner as observer. The same four accounts as #184. |
| Browser profiles | One browser profile (or private window) per account. Never two accounts in one profile. Use a fresh profile if a previous session of another account may still be cached. |
| Signing in | Each tester passes Vercel deployment protection, then the app login with their own email code. MFA applies only where an account already has a verified factor (the owner, per #184). Codes are received by the tester and typed by the tester. The owner/coordinator never asks for, receives or relays a code. |
| Recording | Screenshots and screen recordings are allowed **only of the app content**. Before recording, close the mail client, password manager and any dev-tools panel showing storage, cookies or network headers. If a recording or screenshot shows a code, token or key, delete it and do not share it. Name screenshots `S<step>-<role>.png`. |
| Disposable data | Everything is created in the NewQuip POC organisation only. Use one clearly named customer-quotation pair: quotation site/project name `ZZ UAT <yyyy-mm-dd> DO NOT USE`, and a second one `ZZ UAT <yyyy-mm-dd> B DO NOT USE` for step 12. Select an existing Cin7 customer snapshot (read-only); **no Cin7 customer is created or changed.** The quotations are permanent once approved (the baseline is frozen); nothing else may be built on them. |
| Out of scope | Do **not** send the quotation to a customer, record customer acceptance, create a Project, or use anything that writes to Cin7 or Xero. Stop at Stage 4 (look, do not click), exactly as #184. |
| Notifications | Internal notifications go only to the controlled list described in section 2 (rows 5 and 6). If any notification row ends in a state other than the expected one in section 6, stop the run and tell the coordinator. |
| `previewTools` | The whole-quote testing utility appears only on a Preview. Its presence is part of the check (row 13). **Do not use it** during the run: it bypasses the real journey. |

## 2. Environment flags to verify BEFORE the run

Where: Vercel dashboard, project `cin7core-feeder`, **Settings, Environment Variables**, filtered to the **Preview** environment (and to the branch `integration/newquip-ux006-review` if branch-scoped overrides exist). Also open the deployment page for the exact Preview and read **Environment: Preview** and the commit SHA, which must equal the final PR head. Report presence/absence and the value of non-secret flags. **Never copy a secret value.**

| # | Flag | Expected value | How to verify (Vercel dashboard path) | What happens if wrong |
|---|---|---|---|---|
| 1 | `VERCEL_ENV` (set by Vercel, not by you) | `preview` | Deployment page, "Environment: Preview". | If it is `production`, the restricted email policy, the Preview-only tools and the Cin7 write gate all behave as Production. **Stop; do not run.** |
| 2 | `NEWQUIP_DEMO_MODE_ENABLED` | Absent, or anything other than exactly `true` | Settings, Environment Variables, Preview. | `true` on a Preview lets the owner act as the other identities (Demo Mode). The run would then not prove real three-role separation, and audit rows would carry the owner. Demo Mode must be OFF for this run. |
| 3 | `NEWQUIP_DEMO_OWNER_EMAIL` | Absent | Same. | Only used with row 2; remove with it to keep impersonation impossible. |
| 4 | `NEWQUIP_CIN7_WRITES_ENABLED` | Absent (or anything other than exactly `true`) | Same. | Exactly `true` on a Preview wired to the required Supabase project enables Cin7 Sale creation and claim posting. They are not part of this run but would be one click away. |
| 5 | `RESEND_API_KEY` and `RESEND_FROM_EMAIL` | **Absent for this run** (strongest control), or present only if the owner accepts row 6 | Same. | If present: on a Preview, mail still goes only to the exact Preview allowlist (section below), with a `[PREVIEW]` subject. If absent: nothing leaves; notifications are recorded as not sent and the in-app notification still works. A customer address is never on the allowlist, so customer email delivery is OFF in both cases. |
| 6 | Preview email allowlist (a fixed list in `src/lib/approvals/email-policy.ts`, not an env var) | The list contains only mailboxes of the controlled test accounts and the owner | Ask the coordinator to read the list in the repo; the owner confirms each entry is a mailbox they control. | A recipient outside the list is SUPPRESSED, never redirected. If a named approver in the approval policy is not on the list, that person gets no email (their in-app notification still exists). |
| 7 | `NEWQUIP_PRODUCTION_EMAIL_ENABLED` | Absent | Same, all environments. | Only affects Production, but Preview and Production share one database and one notification queue: a stray `true` could release queued email when the same data is read by Production. Keep absent. |
| 8 | `NEWQUIP_PUBLIC_PORTAL_URL`, `NEWQUIP_INTERNAL_APP_URL`, `NEWQUIP_LINK_ENVIRONMENT` | Absent on this Preview | Same. | Set values cause customer-facing links to be generated pointing at the portal. No quotation is sent in this run, but absence proves none can be. |
| 9 | `NEXT_PUBLIC_NEWQUIP_APPROVALS_DISABLED` | Absent, or not `1` | Same. | `1` is the approvals kill switch; the Approvals screens and the staged approval path would be switched off, so steps 9 to 12 could not run. |
| 10 | `NEXT_PUBLIC_SITE_URL` | Absent, or the exact Preview URL | Same. | A Production URL here makes approval links in notifications point at Production. |
| 11 | `SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL` | The project the owner intends to test on | Same (read only the project ref, the first label of the host; never the keys). | A different project means the data, roles and RLS under test are not the ones the owner believes. State plainly which project (Preview and Production share one database in the current setup, so disposable data in the POC organisation only). |
| 12 | Strict roles (`approval_settings.roles_enforced`) | Whatever #184 recorded (off); each tester holds exactly one explicit role | App, Approvals, Roles page `/approvals/roles` (owner, read only). Not an env var. | With strict mode off and an account holding no explicit role, that account would be Rep + Estimator (+ Manager for an admin) and the separation would not show. Each tester's single role must show on the Roles page. |
| 13 | `previewTools` appears | Visible on the Preview only | Open any quotation as the Rep: the Preview testing utility is present. | Not present on a Preview means the deployment is not what is believed (row 1). Present on a Production URL is a defect: stop and report. |
| 14 | Other secrets (`ENCRYPTION_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`) | Present (needed for the app to work) | Report only "present". | Absent: the app errors. Never read or copy the values. |

## 3. Preconditions

| Check | Who | Pass |
|---|---|---|
| Final head SHA of PR #180 is deployed to the Preview | Coordinator | Deployment page SHA equals the head the coordinator reports. |
| Six CI checks green on that exact SHA | Coordinator | `gh pr checks 180`. |
| Rows 1 to 13 of section 2 confirmed | Owner | Answers sent to the coordinator. |
| Each tester can receive their own login code | Each tester | Requested and received (as in #184). |
| Migration 0120 and the held migrations | Owner | State plainly which migrations the Preview database has. Rep isolation (held 0118/0119) is inactive unless the owner has approved and applied it: this decides which result is expected in step 15. |

## 4. The three-role script

Evidence column: screenshot file name, quotation reference (`NQ-Q-....`), local time. Expected results are the intended behaviour of this build. A result that differs is a finding: write down exactly what was seen, do not retry until it passes.

| Step | Role | Do | Expected | Evidence |
|---|---|---|---|---|
| 1 | Rep | New quotation `ZZ UAT <date> DO NOT USE`. Stage 1: select the test Cin7 customer and the quotation contact. Fill the Rep fields. Save draft. | The first Rep field is visible above the fold on a laptop. No cost, GP, margin or "landed cost + 20%" wording anywhere. No Cost step. | S1-rep, ref, time |
| 2 | Rep | Leave the Estimator-owned items open (product choices and prices). Reach the price-confirmation step, record the customer confirmation and **Submit**. | Submit is allowed with Estimator items open. State "Submitted - awaiting the Estimator". Rep fields remain editable only as the workflow allows. | S2-rep |
| 3 | Estimator | Open the quotation. Stage 2 opens with its first control visible. Map the products that have a library mapping; type a manual price for the LED line **without mapping it**. | Cost and margin visible. The Stage 2 Final review shows the visible, non-blocking notice "N line(s) has/have a typed price but no library mapping (...): the Manager cannot approve until they are mapped". | S3-est |
| 4 | Estimator | Change a charge (for example Delivery) so the **total changes**, and Save. | The quotation returns to the Rep as a new revision (S1b). | S4-est, revision |
| 5 | Rep | Reload the quotation (a fresh load). | Banner: "The total changed from R <previous> to R <new>; the customer's confirmation was withdrawn. Reconfirm the new amount with the customer and submit again (step 5)." | S5-rep |
| 6 | Rep | Reconfirm the new amount and submit again. | Back in Estimator review. | S6-rep |
| 7 | Estimator | Record the accepted-incomplete-cost exception (authorised) and **sign off**, leaving the LED line unmapped. | Sign-off is allowed (its gating is unchanged). The visible notice from step 3 is still shown. | S7-est |
| 8 | Manager | Open Stage 3. | The "Before you decide" list shows "Costing accepted incomplete by <Estimator> on <date>: <reason>" with status "Accepted incomplete" (not "Costing is complete: Met") and an unmet row "Mapping unresolved: <LED line> - these need an active library mapping; the Manager exception covers only M75 / penning systems". **Approve is DISABLED with that reason. No exception button.** | S8-mgr |
| 9 | Manager | Return the quotation **to the Estimator** with a written reason. | Recorded. Quote stays in Estimator review. | S9-mgr |
| 10 | Estimator, Rep | Estimator opens the quotation. Rep opens it. | Estimator sees, on whichever stage they land on, a compact "Returned to the Estimator" line; opened, it shows who, when and the reason, with a button to the Estimator review. **Rep sees only "With the Estimator for review."** | S10-est, S10-rep |
| 11 | Estimator, Manager | Estimator maps the LED line in the library, re-signs off. Manager opens Stage 3. | The mapping row is gone; the exception block "Approval exception required" lists only the M75 and penning systems. Plain Approve is disabled; the single primary action is "Approve with recorded exception". The Manager enters a reason, ticks the box and approves. State final. Approvals entry shows "Accepted exception: 2 unmapped Estimator-priced systems (...)" with the reason; the Stage 6 baseline summary shows the exception and the accepted-incomplete costing. | S11-mgr, S11-approvals, S11-stage6 |
| 12 | Estimator, Manager | **D-12 hosted check, on quotation B** (a second disposable quotation taken to Manager review with a current Estimator sign-off, all items mapped so a plain approval is possible). The Estimator then **edits content without changing the total** (for example the assumptions text) and saves. | Estimator sign-off is cleared; the quotation stays in Estimator review; the customer confirmation is kept. On the Approvals page: the earlier Manager request is shown **Superseded** and a new Estimator-stage request is **Pending**. The Manager can no longer approve the old content (the entry is not pending). The Estimator signs off again; a Manager-stage request opens; the Manager approves. | S12-est, S12-approvals, ref B |
| 13 | Rep, Estimator, Manager | Wrong-role attempts through the UI: the Rep looks for sign-off and approve; the Estimator for approve; the Manager for Rep-owned fields and the Estimator cost fields. | Each control is disabled with a stated reason, or absent. The Rep never sees cost. | S13-rep, S13-est, S13-mgr |
| 14 | Coordinator (not the owner) | Direct wrong-role calls are exercised by automated tests, not by hand on the hosted site: `single-role-authz.test.ts`, `authorise-before-mutate.test.ts` (an unauthorised request causes no database change). | Both pass on the final head (CI). **No hosted replay of server actions is asked of the testers** (it needs internal identifiers and invites mistakes). | CI run link |
| 15 | Rep | **Only after Rep-isolation migration approval.** Direct database access test with the Rep's own session; see below. | **Before** the isolation migration is applied to the Preview database: record the result as the baseline finding (it is expected that a Rep can currently read the table; that is the finding). **After** it is applied: the read is denied or returns no draft/cost data. | Status code and row count only |

### Step 15 detail (Rep direct database access)

Run by the **Rep, in their own browser session**, on the app origin, in the developer console. It uses the Rep's own session and the public (anon) key that the app already ships to every browser. Do not print or copy the session token, and do not paste the console output if it contains one. If the app keeps the session in cookies rather than the browser storage key below, **skip the step and say so**; do not search for the token.

```js
// Replace <ref> with the project ref from section 2 row 11 and <anon> with the app's public anon key (it is not a secret).
const ref = "<ref>", anon = "<anon>";
const raw = localStorage.getItem(`sb-${ref}-auth-token`);
if (!raw) { console.log("session not in localStorage: skip"); }
else {
  const token = JSON.parse(raw).access_token;               // never log this
  const r = await fetch(`https://${ref}.supabase.co/rest/v1/newquip_quotes?select=draft&limit=1`,
    { headers: { apikey: anon, Authorization: `Bearer ${token}` } });
  const body = await r.json().catch(() => null);
  console.log(r.status, Array.isArray(body) ? `rows=${body.length}` : "no rows array");   // report ONLY these two facts
}
```

Report the status code and the row count, nothing else. Equivalent: `supabase.from('newquip_quotes').select('draft')`. A returned row that contains an `estimator` or cost field for a Rep is a P1 finding.

## 5. Hosted database check for D-12

Step 12 above exercises the real staged approval functions on the hosted database through the app, with real sessions. The same sequence is also a SQL test in the clean-bootstrap CI job (`supabase/tests/0112_d12_estimator_edit_after_signoff.test.sql`), which runs the real `approval_submit_staged` and `approval_decide_staged` functions on a throw-away database. **Nothing is run against the hosted database by the coordinator or by that test.**

## 6. Read-only SQL for the evidence (SELECT only, run by the coordinator after the run)

Run in the Supabase SQL editor or via a read-only MCP session. SELECT only; no ids, emails or secrets are copied into reports (use the quotation reference).

```sql
-- A. The quotations and where they ended up
select quote_ref, state, revision, customer_confirmed_cents is not null as confirmed, estimator_signoff_hash is not null as signed_off,
       baseline_hash is not null as sealed, jsonb_array_length(coalesce(accepted_baseline->'exceptions','[]'::jsonb)) as baseline_exceptions
from newquip_quotes where site_name like 'ZZ UAT %' order by created_at;

-- B. The approval trail per quotation (stages, statuses, supersession)
select doc_ref, revision, stage, status, return_destination, admin_override, submitted_at, closed_at
from approval_requests where doc_type = 'QUOTE' and doc_ref in (select quote_ref from newquip_quotes where site_name like 'ZZ UAT %') order by doc_ref, revision;

select doc_ref, action, from_status, to_status, stage, destination, created_at
from approval_events where doc_type = 'QUOTE' and doc_ref in (select quote_ref from newquip_quotes where site_name like 'ZZ UAT %') order by doc_ref, created_at;

-- C. Return records, exception and sign-off audit rows (no free text beyond the recorded reasons)
select detail->>'quoteId' as quote, action, summary, created_at
from activity_log
where action in ('newquip.quote_return_recorded','newquip.quote_return_voided','newquip.quote_confirmation_invalidated','newquip.baseline_exception_accepted','newquip.quote_estimator_signed_off','newquip.quote_manager_approved')
  and (detail->>'quoteId') in (select id::text from newquip_quotes where site_name like 'ZZ UAT %') order by created_at;

-- D. Notifications: nothing may have gone anywhere unexpected
select channel, status, left(coalesce(last_error,''), 60) as note, count(*) from approval_notifications
where request_id in (select id from approval_requests where doc_ref in (select quote_ref from newquip_quotes where site_name like 'ZZ UAT %'))
group by 1,2,3 order by 1,2;

-- E. No project, Sale or Cin7 side effect
select count(*) as projects_for_uat from projects where originating_quote_ref in (select quote_ref from newquip_quotes where site_name like 'ZZ UAT %');

-- F. Roles in force (roles only; no emails are reported)
select role, count(*) from org_functional_roles group by role order by role;
select roles_enforced from approval_settings;
```

Expected: A shows quotation 1 final with one baseline exception and quotation B final with none; B shows the superseded Manager request and the later Estimator and Manager requests in order; C shows the return records (AMOUNT_CHANGED, then the Manager's RETURN to the Estimator) before the state changes, and exactly one `newquip.baseline_exception_accepted`; D shows only IN_APP rows plus EMAIL rows that are SUPPRESSED, FAILED (no provider configured) or addressed to the controlled list; E is `0`.

## 7. Stopping rules

Stop the run and tell the coordinator, without trying to continue, if: the Preview is not the final head; any flag in section 2 differs from expected; a Cin7 write, a customer-addressed email or a Project appears anywhere; any tester sees a credential or code in a recording; a Rep sees cost or margin data.

## 8. What I (the coordinator) cannot do

- **Sign in as the Rep, Estimator or Manager.** I have no sessions, passwords or login codes for them, and I must not ask for them. Only the three testers can perform steps 1 to 13 and 15.
- **Read or change Vercel environment settings.** Section 2 needs the owner (or someone with dashboard access) to read the Preview environment variables and report presence/absence. I can read the deployment SHA and CI status through the API, not the secrets.
- **Apply any migration or change the hosted database.** The Rep-isolation migration (held 0118/0119) and any other held migration need the owner's explicit approval and a separate step. Until then step 15 only records the baseline finding.
- **Run the D-12 SQL test against the hosted database.** It runs in CI on a throw-away database; the hosted check is step 12 through the app.
- **Verify email delivery outcomes inside real mailboxes.** I can read the notification table (query D) but not what a mailbox received. The owner confirms that no unexpected mail arrived.
- **Use Demo Mode as a substitute.** It is off for this run and impersonation would not prove separation.
- **Replay server actions or call internal endpoints on the hosted site** to attempt wrong-role actions by hand; that is covered by the automated tests named in step 14.
