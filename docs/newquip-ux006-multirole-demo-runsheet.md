# NewQuip multi-role demonstration: hosted UAT setup and presenter run sheet

## Presenter quick guide (one page): demo quotation NQ-Q-0003

**URL (open it directly, do not use a stale deployment link):** `https://cin7core-feeder-git-feature-newquip-ux006-final-baa0e2-spark18.vercel.app`
**Quotation page (plain URL, no `?stage=` / `?step=`):** `<URL>/newquip-grower/cbfc2385-6684-4667-944c-3d9549221ab1` (NQ-Q-0003, site "ZZ UAT DEMO 2 Site", customer "ZZ UAT Demo Farm (Pty) Ltd", state REP_DRAFT).
Nothing in this demo sends a customer email or writes to Cin7 or Xero (all off on this Preview). Do not use the "Testing utility (Preview only)".

**Preconditions (owner, before the demo)**
1. Branch Auth SMTP: the Supabase branch `uat-ux006` inherited SMTP credentials that the mail server rejects (auth log `535 Authentication credentials invalid`), so no 6-digit login code is emailed until the owner sets the SMTP password in the branch's Authentication > SMTP settings (branch Auth settings are per branch and independent of Production; do not touch Production). Test by requesting a code for one account before the audience arrives.
2. You can sign in to Vercel as the `spark18` team owner account in all three browser profiles (section 1A). Vercel Authentication stays ON.

**Three profiles (one cookie jar per role)**
| Window | Role | Browser | Vercel login | App sign-in |
|---|---|---|---|---|
| A | Rep | Chrome profile "NQ Rep" | owner's Vercel account | Rep mailbox: emailed 6-digit code |
| B | Estimator | Safari | same Vercel account | Estimator mailbox: code |
| C | Manager | Chrome profile "NQ Manager" | same Vercel account | Manager mailbox: code |

In each profile: open the URL, you land on the Vercel login page (this is a separate login from the app), sign in to Vercel, you are returned to the app's `/login`, enter the role's email, press Send code, type the 6-digit code from that mailbox. Check the header shows the right account before you continue.

**Golden rule: the app never refreshes itself. At every handover press reload (Cmd+R) in the window you switch to, then act.** The first load of a quotation can take up to 20 seconds ("Loading the quotation").

**Steps**
1. **Rep (A)**: open the quotation URL. Steps 1 to 4 are complete. Step 5: tick the confirmation, Submit to Estimator. Say: the amount is indicative; no cost or margin is shown to the Rep. Expect: state Estimator review.
2. **Estimator (B)**, Cmd+R: Stage 2 mappings. "Confirm source-backed mappings"; choose door product NQ2114; enter manual prices with a reason for mat 450, cup drinker 650, slats 380, door 4 200; Save draft. Expect: the total changes and the quotation returns to the Rep (revision 2).
3. **Rep (A)**, Cmd+R: read the "total changed, reconfirm" banner, tick, Submit again. Expect: Estimator review, revision 2.
4. **Estimator (B)**, Cmd+R: "Cin7 cost capture and FX rates": add a manual estimate per SKU (Unit cost, Reason, Save): tank 18 000, feeder 6 500, mat 300, cup 120, pipe 60, plate 40, bracket 50, bolt 3, nut 2, washer 1, slats 270, LED 600, door 3 000 (several minutes: narrate, or do it off-screen beforehand). Then Final review, Mark reviewed & continue, Sign off for Manager approval. Say: these are labelled UAT working figures; live Cin7 cost capture is not tested here.
5. **Manager (C)**, Cmd+R: review costs and margins; read "Approval exception required" (M75 and penning are deliberately unmapped); enter a written reason, tick, "Approve with recorded exception". Expect: Manager approved (final). Press Cmd+R in Rep (A) and Estimator (B): both show Approved.

**Recovery**: a stale or greyed button means reload, do not click. A Vercel login page means that profile's Vercel cookie expired: sign in to Vercel again. The app login page means that role's app session expired: request a new code. A wedged quotation: the Manager returns it; otherwise ask the coordinator for a fresh seeded quotation. Never "fix" by disabling Vercel protection.

---

# Detailed reference

Status: **hosted three-role workflow verified end to end on an isolated Preview and an isolated Supabase branch database (2026-11-04). Stopped at the owner acceptance gate.** Builds on `docs/newquip-uat-multirole-procedure.md` (roles, capability matrix), `docs/newquip-ux006-hosted-uat-runsheet.md` (flag list) and `docs/newquip-uat-branch-setup.md` (what was set up and how to tear it down). No credential, key, token, session or login code appears here.

## 0. OUTSTANDING INTEGRATION GATES (not part of this acceptance run)

| Gate | Status |
|---|---|
| **Live Cin7 customer lookup** (searching and selecting a customer from Cin7 on a NEW quotation) | **NOT TESTED / OPEN. Never to be read as a pass.** The run uses a pre-seeded, sanitised UAT customer snapshot instead (section 2). |
| Cin7 cost capture (latest supplier cost) | NOT TESTED / OPEN (no Cin7 credentials exist on the branch). Manual cost estimates were used. |
| Cin7 / Xero writes, customer emails, customer portal | OFF and not testable here, by design. |

## 1. The single Preview URL

`https://cin7core-feeder-git-feature-newquip-ux006-final-baa0e2-spark18.vercel.app` (stable branch alias of `feature/newquip-ux006-final-candidate`, PR #197). It is wired ONLY to the Supabase branch `wevhibjvinmdvuuyurql` (client bundle contains that ref and not the production ref; section 6).

**Vercel deployment protection is ON and stays ON (Vercel Authentication, "all deployments except custom domains": it covers this branch alias and every Preview). Do not disable it.** Only members of the `spark18` Vercel team can pass it; today that is one member, the owner (role OWNER, GitHub-linked account). An unauthenticated request answers 302 to `vercel.com/sso-api`.

### 1A. Passing Vercel protection in three independent browser profiles

Vercel login is a SEPARATE login from the app login: it grants access to the site, the app then asks for its own email code. Repeat in each profile (each profile has its own cookies, so each needs its own Vercel sign-in):
1. Open the Preview URL (type or paste it directly into the address bar).
2. The browser is redirected to `vercel.com` (the Vercel login page). If the profile is already signed in to Vercel it redirects straight back (step 5).
3. Sign in with the owner's `spark18` account using the method offered on that page (GitHub for the linked `antonhill` account, or the account's email).
4. Vercel may show a "Continue to" / authorise access page for the deployment: accept it.
5. You are redirected back to the app and land on the app `/login`. The Vercel cookie is set on the Preview host; do the app sign-in (emailed code) next.
Chrome profiles: no special steps. Safari: the flow uses full-page redirects (no embedded frame), so cross-site tracking prevention should not block it; if it loops or the app login page never appears, first retry by opening the URL directly in a new tab after signing in to vercel.com in that same Safari window; allowing cross-site tracking or cookies for `vercel.com` is a fallback that is UNVERIFIED here. The Vercel cookie lifetime (believed to be about a day) was not verified: sign in again if the Vercel login page reappears mid-demo. A teammate who is not a `spark18` member cannot pass; adding one is an owner decision (Vercel team settings), not part of this guide.

## 2. UAT fixtures (all labelled UAT)

* Organisation `UAT ZZ Demo Org`; three accounts, one functional role each (Rep, Estimator, Manager); no administrator; Demo Mode and impersonation off.
* Customer **`ZZ UAT Demo Farm (Pty) Ltd`**, contact `Demo Contact`, email on a non-deliverable `.invalid` domain. **The customer was pre-seeded as a customer snapshot (the same two rows the app's selection would store) because the live Cin7 lookup is impossible without Cin7 credentials. The Rep step 1 "Customer & contact" therefore already shows the customer as chosen. This is a fixture, not evidence that Cin7 selection works (gate in section 0).**
* **Start the demonstration from quotation `NQ-Q-0003` (site "ZZ UAT DEMO 2 Site"): fresh REP_DRAFT, customer chosen, no cost exception pre-recorded.** `NQ-Q-0001` is the verified, approved run (history; it carried a synthetic pre-recorded "costing accepted incomplete by fixture@nq" note from the golden test draft, which `NQ-Q-0003` does not have). `NQ-Q-0002` is a probe quotation in Estimator review (history; ignore).
* LED line: package `led_light` is mapped to the test SKU `ZZ-UAT-LED-SKU`; M75 and penning are deliberately unmapped (Manager exception).

## 3. Account and browser setup

| Window | Role | Browser profile |
|---|---|---|
| A | Rep | Chrome profile "NQ Rep" |
| B | Estimator | Safari (or Chrome profile "NQ Estimator") |
| C | Manager | Chrome profile "NQ Manager" |

One jar per role (the auth cookie has the same name for every user on one origin). In each: open the URL, pass Vercel protection, sign in as that role, check the header shows the right account. **Sign-in delivery of the login code: see section 4 (it does NOT work today).**

## 4. Login codes: NOT deliverable until the owner sets the branch SMTP password

The app signs in with an emailed 6-digit code sent by Supabase Auth itself (`signInWithOtp`). Requesting a code on the UAT branch fails because the branch's inherited custom SMTP settings are rejected by the mail server (Supabase auth log: `535 "Authentication credentials invalid"`, surfaced to the app as "Error sending magic link email"). Branch Auth settings (SMTP included) are configured per branch and are independent of Production; Production login is not affected.

**Owner action:** in the Supabase dashboard open the branch `uat-ux006` (ref `wevhibjvinmdvuuyurql`), Authentication > SMTP, set the SMTP password (or a working sender), save, then request a code for each of the three accounts to confirm delivery. Alternative (deliberate owner decision only): the coordinator mints a session per role for the presenter's browsers. Nothing here was changed on the branch.

## 5. Verified result of the full workflow (real Supabase sessions, hosted Preview, branch database)

Three persistent, independent Chrome profiles, each given its cookie once; every switch a fresh page load (no auto-refresh). Times are UTC (SAST minus 2h) on 2026-11-04, quotation `NQ-Q-0001`.

| # | Step | Result | Time |
|---|---|---|---|
| 1 | Rep: customer already chosen, steps 1-4 complete, submit with 4 Estimator items open | State ESTIMATOR_REVIEW, Estimator-stage request PENDING. Rep page: no margin/markup/landed-cost wording or fields (only the word "costing" in a sentence) | 06:38:26 |
| 2 | Estimator: confirm source-backed mappings (incl. LED package), choose door product, enter 4 manual quotation prices with reasons, Save | Total changed R 6 429 828,80 to R 10 211 028,80: returned to Rep as revision 2, request WITHDRAWN, confirmation withdrawn | 06:41:11 |
| 3 | Rep: fresh load shows the banner "The total changed... Reconfirm", reconfirm, resubmit | ESTIMATOR_REVIEW rev 2, new request PENDING | 06:42:05 |
| 4 | Estimator: costing. Cin7 capture impossible, so **13 manual cost estimates** (labelled UAT working figures), Mark reviewed, Sign off | Editing after submission superseded the pending request (correct); sign-off recorded, Manager request PENDING | 06:57:03 |
| 5 | Manager: reviews totals, margin (indicative, price-list basis), pricing exceptions; "Approve with recorded exception" for M75 and penning with a written reason | MANAGER_APPROVED_FINAL, baseline sealed, `accepted_baseline.exceptions` length 1 (covering both systems), approved by the Manager account | 07:01:01 |

Approval history: SUBMITTED(rep), WITHDRAWN(estimator), RESUBMITTED(rep), SUPERSEDED(estimator), RESUBMITTED/APPROVED/SUBMITTED(estimator), APPROVED(manager). Notifications: 8 in-app SENT, 8 email rows FAILED "not configured", 0 email SENT; 0 customer sends; 0 `cin7_instances` rows (no Cin7 call possible). 524 browser requests, all HTTP 200: no login redirect, no MFA or other auth challenge across the run.

Not exercised in this run (covered by CI tests, not by the hosted run): Manager return to Estimator, the "Mapping unresolved" Approve block, a second quotation for the D-12 edit-after-sign-off check, and a hosted replay of a wrong-role mutation. A Rep replay of captured Estimator cost actions was refused ("Costs are internal...") and a replay of the mapping-read action returned no cost fields; none changed the database. A genuine wrong-role mutating replay was not achieved.

## 6. Production isolation (verified)

* Preview client bundle: contains the branch ref, 0 occurrences of the production ref; unauthenticated routes redirect to `/login`.
* The three branch sessions are rejected by production Auth (`/auth/v1/user` HTTP 401 each; HTTP 200 on the branch) and by production REST (401).
* Production holds 5 organisations, 23 quotations, 24 users; the branch holds 1 organisation, 3 quotations, 3 users, and the Rep's quotation list in the hosted app shows exactly the 3 branch quotations. The same three mailbox addresses exist as separate users in production: different identities, different tokens.
* Database-level Rep isolation (0122) stays enforced after the workflow: 64 policies, no `authenticated` grants on `newquip_quotes` or `approval_requests`, and the direct-access probes for the three real users repeated after the workflow return the same denials as before (403/42501 on quotes, approvals, costs, roles, mappings, activity writes; 200 on control tables).

## 7. The 14 environment settings (actual vs expected)

Scope of every override: Preview, git branch `feature/newquip-ux006-final-candidate` only. "Other" = other branches' overrides (do not apply here).

| # | Flag | Expected | Actual: Production / general Preview / this branch | Verdict |
|---|---|---|---|---|
| 1 | `VERCEL_ENV` | preview | deployment target Preview | PASS |
| 2 | `NEWQUIP_DEMO_MODE_ENABLED` | absent | absent / absent / absent (set only on `feature/newquip-completion`) | PASS |
| 3 | `NEWQUIP_DEMO_OWNER_EMAIL` | absent | absent / absent / absent (other branch only) | PASS |
| 4 | `NEWQUIP_CIN7_WRITES_ENABLED` | absent | absent / absent / absent (other branch only); also no Cin7 instance row | PASS |
| 5 | `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | no email can leave | key present for general Preview, **overridden here with an invalid placeholder**; from-address absent here; observed: 0 emails sent, all recorded as not configured | PASS |
| 6 | Preview email allowlist (code) | only controlled mailboxes | 5 fixed mailboxes in `src/lib/approvals/email-policy.ts` (testing, rep, estimator, manager, owner); owner to confirm each is theirs | OWNER TO CONFIRM |
| 7 | `NEWQUIP_PRODUCTION_EMAIL_ENABLED` | absent | absent everywhere | PASS |
| 8 | `NEWQUIP_PUBLIC_PORTAL_URL` / `NEWQUIP_INTERNAL_APP_URL` / `NEWQUIP_LINK_ENVIRONMENT` | absent here | portal URL set on Production and the other branch only; the other two absent everywhere; absent here; 0 customer sends | PASS |
| 9 | `NEXT_PUBLIC_NEWQUIP_APPROVALS_DISABLED` | absent | absent everywhere | PASS |
| 10 | `NEXT_PUBLIC_SITE_URL` | absent or the Preview URL | set on the other branch only; absent here (links use the branch alias) | PASS |
| 11 | `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL` | the UAT project | production values for general Preview/Production; **overridden here with the branch** (plus anon and service-role keys); bundle shows only the branch ref | PASS |
| 12 | Strict roles | each user has one role | no `approval_settings` row (strict off); each account holds exactly one functional role | PASS |
| 13 | Preview testing utility | visible on Preview | "Testing utility (Preview only)" present on the page | PASS (do not use it) |
| 14 | Secrets | present, not production's | `ENCRYPTION_KEY`, `CRON_SECRET`, `SYNC_SHARED_SECRET` new random values; LemonSqueezy x5 inert placeholders; service-role key = branch | PASS |

Xero: the application reads no Xero variable and none exists.

## 8. Presenter script (start from NQ-Q-0003)

Golden rules: the app never refreshes itself, so press reload in the window you switch to; open the plain quotation URL (no `?stage=`/`?step=`); save before switching. **The hosted app is slow through a protected Preview: allow up to 20 seconds for the first load of a quotation ("Loading the quotation").**

1. **Rep**: open NQ-Q-0003. Steps 1 to 4 are complete. Step 5: tick the confirmation, Submit to Estimator. Say: the amount is indicative; no cost or margin is visible.
2. **Estimator** (reload): Stage 2. Press "Confirm source-backed mappings"; select door product NQ2114; enter manual prices with reasons for mat 450, cup drinker 650, slats 380, door 4 200; Save draft. The total changes and the quotation returns to the Rep.
3. **Rep** (reload): read the banner, tick, Submit again.
4. **Estimator** (reload): open "Cin7 cost capture and FX rates" and add a manual estimate per SKU (Unit cost, Reason, Save): tank 18 000, feeder 6 500, mat 300, cup 120, pipe 60, plate 40, bracket 50, bolt 3, nut 2, washer 1, slats 270, LED 600, door 3 000. (This takes several minutes: narrate, or pre-agree to do it off-screen.) Then Final review, Mark reviewed & continue, Sign off for Manager approval.
5. **Manager** (reload): review costs and margins; read "Approval exception required" (M75, penning); enter a reason, tick, "Approve with recorded exception". Reload Rep and Estimator: both show Approved.

Recovery: stale button, reload, do not click. Login page in one window: that profile's session expired; re-establish it per section 4. Wedged quotation: Manager returns it, or start from a fresh seeded UAT quotation (the coordinator seeds one).

## 9. Teardown (documented only; not performed)

See `docs/newquip-uat-branch-setup.md` section 6. Deleting the Supabase branch and its data needs a separate owner authorisation.
