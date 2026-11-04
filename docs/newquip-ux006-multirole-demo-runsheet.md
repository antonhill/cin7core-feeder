# NewQuip multi-role demonstration: setup and presenter run sheet

Status: **ready for owner testing once the owner actions in section 1 are done.** No application change is needed: the existing session architecture supports three simultaneous sessions (section 2). This sheet builds on `docs/newquip-uat-multirole-procedure.md` (role resolution, capability matrix) and `docs/newquip-ux006-hosted-uat-runsheet.md` (env-flag checklist, evidence queries). It contains no credentials, no email addresses and no secrets; keep it that way.

## 0. What was tested, and what was not

| Evidence | Level | Result |
|---|---|---|
| Three independent persistent browser contexts (separate cookie jars), one disposable quotation, the full 15 owner steps through each role's real UI, 25 window switches, reloads, stale-button probe, wrong-context POST probes | **2: real Chrome, production build, real server actions and role code, fixture login and FakeDb** | 41 of 43 checks pass, 1 blocked (flow order, see 5.7), 1 unexplained header-selector miss in the script. 0 redirects to /login, 0 extra auth challenges, 0 console errors, 8 emails all internal and `[PREVIEW]`-prefixed, 0 Cin7 write attempts. |
| Real Supabase sign-in, session refresh/expiry, MFA, Safari, the hosted database and RLS | **3/4: NOT TESTED** | Needs the owner (section 1). |

The rehearsal proves the **application** behaves correctly with three independent cookie jars. It does not prove the hosted authentication.

## 1. Owner actions still required

1. **Provide the isolated UAT environment.** Preview and Production share one Supabase database in the current setup (`docs/newquip-ux006-hosted-uat-runsheet.md`, rows 7 and 11). Either (a) create a Supabase **branch database** and a Vercel Preview pointed at it (own Supabase URL and keys), or (b) accept running on the shared database with disposable data in the POC organisation only. Creating a branch database is billable and is not done without your say-so.
2. **Verify the 14 env flags** in the hosted run sheet, section 0 (customer email OFF, Cin7 writes OFF, Demo Mode and impersonation OFF, internal notifications to a controlled recipient list).
3. **Be able to receive the login codes** for the three role accounts (Rep, Estimator, Manager). Sign-in is a 6-digit email code typed into the login page (`signInWithOtp`, `shouldCreateUser: false`, no link, no redirect), so only existing accounts can sign in and the Vercel/Supabase redirect allow-list is not involved. If you cannot read those three inboxes, forward access to them to yourself first.
4. **Vercel deployment protection:** a protected Preview first asks for a Vercel login in **each** browser/profile (including Safari). Sign in to Vercel with your own team account in all three, or have deployment protection relaxed for the UAT Preview (your decision).
5. **Check the Supabase Auth session settings** in the dashboard (Authentication > Sessions): confirm there is no short time-box or inactivity timeout that would end a session mid-demo. The application itself has none: sessions are cookie sessions refreshed on every request by `src/middleware.ts` (token rotation) and no code signs a user out. "Single session per user" is harmless here because each role is a different user.
6. **Confirm no MFA is enrolled** on the three role accounts. As of 2026-11-03 (read-only check) the Rep, Estimator and Manager accounts are `member` role with no verified factor, so they get no MFA challenge: MFA is only forced for super-admins and org owners/admins on a paying plan. If a factor has since been enrolled, that account gets one `/mfa-challenge` at sign-in (once per session) and you need its authenticator.
7. **Pick the demonstration customer** in Cin7 (a designated test customer with a contact that has an email address). The customer search is a read-only Cin7 lookup; no Cin7 write happens in this flow. Nothing is posted, invoiced or emailed to a customer.
8. **Map the LED line in the library** (or tell me the intended SKU) before the demo: otherwise the Manager approval is correctly refused (the typed-price catalogue line is not waivable). M75 and penning need no mapping: they are covered by the Manager exception in step 14.

## 2. Why three sessions already work (no build needed)

* Sign-in creates a Supabase cookie session in **that browser's own cookie jar**. The auth cookie has the same name for every user on the same origin, so **two roles in one browser profile overwrite each other**. That is why you need three jars.
* A browser **profile** is a separate jar (Chrome profiles), and **Safari** is a separate jar from Chrome. Do not use a second tab or window of the same profile, and do not use Incognito windows of the same Chrome profile for two roles (they share one incognito jar).
* The server re-derives the user and their roles from the session on **every** action (`authoriseActor`). Nothing is shared between jars, so authorisation stays strictly bound to the signed-in user. There is no impersonation, "act as" or role switch in this procedure.
* Database-level isolation (migration 0122, PR #196) is separate and **not yet applied**; until it is, the Rep's cost redaction is application-layer only (see the Rep-isolation design doc).

## 3. One-time setup (do this before the audience arrives)

| Window | Role | Browser | Profile name | Window title / colour |
|---|---|---|---|---|
| A | **Rep** | Chrome | "NQ Rep" (create via the profile menu > Add) | name the profile "NQ Rep", choose a blue theme colour |
| B | **Estimator** | Safari | (default) | pin the tab, title the window via the page |
| C | **Manager** | Chrome | "NQ Manager" (a second dedicated profile) | name "NQ Manager", green theme colour |

1. In each browser/profile open the UAT URL, pass Vercel protection if shown (1.4), and sign in with **that role's** account: enter the account's email, then the code from its inbox. **Sign in all three well before the demo**; the codes are short-lived but the sessions then persist.
2. Check each window: the header shows the right account, the quote list loads. Rep: "New Grower quote" is available. Estimator and Manager: the list loads but no "New" action is used.
3. Arrange the three windows side by side or use macOS Spaces (Ctrl+Left/Right) so one keystroke switches role. Do not use fast user switching, VPN changes or "clear cookies" tools during the demo.
4. Create nothing yet. The disposable quotation is created live in step 1 (name it `ZZ UAT DEMO <date> DO NOT USE`).

## 4. Golden rules for the presenter

1. **The app never refreshes by itself.** No polling, no live sync (verified: zero background requests, no websocket). **Press ⌘R in the window you switch TO, every time**, before you speak about it.
2. **Never leave a window on a `?stage=` or `?step=` URL.** Those are pinned on reload and hide the new state. Use the plain quote URL `/newquip-grower/<id>`.
3. **Save the Rep draft before switching** ("All changes saved" chip). Reloading with unsaved edits raises the browser's "Leave site?" prompt and discards them.
4. If you see a stale-looking button, **reload; do not click**. A stale Approve or Sign-off is refused by the server with no state change (tested), but it looks bad.
5. Quote lists are also stale until reloaded: reload the list after the Rep creates the quotation.

## 5. The 15-step presenter script

Navigation: **Rep** `/newquip-grower` > New Grower quote > the quote opens at `/newquip-grower/<id>`. **Estimator and Manager** `/newquip-grower` > ⌘R > click the quote row; the Estimator lands on Stage 2 (mapping), the Manager on Stage 3. No `?stage=` is needed.

| # | Window | Do | Say / show | Expected |
|---|---|---|---|---|
| 1 | Rep | New Grower quote; search the Cin7 customer; choose the contact | "One customer identity, from Cin7." | Step 1 Complete; "Quotation will be sent to <contact email>" |
| 2 | Rep | Site name, measurements, "Load recommended configuration", Review, tick the confirmation, **Submit to Estimator** | "I can submit with product mappings still open. The amount is indicative." | State: Estimator review; caption "This total is indicative while N lines await the Estimator" |
| 3 | Rep | Look at the screen | "The Rep sees no costs, margins or markup." | No cost/margin text anywhere (checked in the UI and in 99 responses) |
| 4 | Estimator | **Switch to Safari; ⌘R the list** | "Already signed in, no login." | Quote row visible |
| 5 | Estimator | Open the row | "It lands on my work: mappings." | Stage 2 step 1 under "Yours to resolve" |
| 6 | Estimator | Confirm the source-backed mappings; enter the Estimator-priced lines; Save | "I resolve mappings and pricing." | If the total changes the quote **returns to the Rep at once** (next step) |
| 7 | Estimator | (narrate) | "Because the customer-facing amount changed, the confirmation is withdrawn and it goes back to the Rep to reconfirm. Costing is completed after the Rep resubmits." | Estimator's page now shows the Rep owns the quote. **Costing cannot be finished before this return** (tested) |
| 8 | Rep | **Switch back; do not touch; show it is stale; then ⌘R** | "The app does not auto-refresh; one reload." | After reload: Stage 1 "Returned", banner "The total changed from R x to R y; the customer's confirmation was withdrawn. Reconfirm..." |
| 9 | Rep | Tick, **Submit to Estimator** at the new amount | "Reconfirm the revised amount." | State: Estimator review |
| 10 | Estimator | **Switch; ⌘R** | "Back in my existing session." | Stage 2 "Awaiting your review", Costs step |
| 11 | Estimator | Costing (Cin7 cost capture or the accepted-incomplete exception if costs are not capturable), **Mark reviewed & continue**, **Sign off for Manager approval** | "Review and sign-off." | Sign-off enabled only after the mark; Manager request opens |
| 12 | Manager | **Switch to the second Chrome profile; ⌘R the list; open the row** | "Already signed in as Manager." | Lands on Stage 3 |
| 13 | Manager | Review quotation, costs and margins | "The Manager sees costs and margins; the Rep did not." | Indicative margin, Stage 2 costs read-only |
| 14 | Manager | Read the "Approval exception required" block; enter a reason (10+ characters, no costs), tick, **Approve with recorded exception** | "M75 and penning are Estimator-priced systems with no Cin7 SKU. I record why." | Plain Approve disabled; exception lists only M75 and penning; if an unmapped catalogue line is listed under "Mapping unresolved" it blocks until mapped |
| 15 | Manager | (result) | "Approved and frozen." | State: Approved; baseline shows the recorded exception; the Rep and Estimator see "Approved" after ⌘R |

Optional proofs (each takes under a minute): from the Rep window try to open Stage 2's Costs (read-only, no controls); from the Rep or Estimator window the "Approve with recorded exception" control is disabled; do not demonstrate raw POST replays live.

## 6. Recovery procedure

| Symptom | Fix |
|---|---|
| A window is on the login page | That profile's session expired: sign in again in **that profile only** with the emailed code (do not touch the others). The quotation and its state are server-side and unaffected. |
| A window shows an old state or a stale button | ⌘R. If it still shows an old stage, remove `?stage=`/`?step=` from the URL and go to `/newquip-grower/<id>`. |
| "Leave site?" prompt on reload | Choose Stay, click **Save draft**, wait for "All changes saved", then reload. |
| The quote is not in the Estimator/Manager list | ⌘R the list; if absent, confirm the Rep actually submitted (state "Estimator review"). |
| A server refusal appears ("changed after ... reviewed", "waiting for manager approval") | Someone else acted. Reload; the form may reset (the exception reason/tick is bound to the exact version and must be re-entered). |
| Approve stays disabled with "Mapping unresolved" | An unmapped catalogue product (e.g. the LED line) blocks approval: map it in the library or remove the line; the exception cannot cover it. |
| The quotation is wedged | Manager: "Return to Estimator" or "Return to Rep" with a reason; or abandon it and create a fresh `ZZ UAT DEMO` quotation (they are disposable). |
| A role's account cannot sign in | Check the inbox for the code; codes expire quickly, request a new one. Do not create accounts or change roles during the demo. |

## 7. Acceptance criteria status

| # | Criterion | Status |
|---|---|---|
| 1 | Rep, Estimator and Manager simultaneously authenticated | **PASS at level 2** (three independent contexts, cookie set once, never re-set). Hosted: needs owner (section 1). |
| 2 | All three access the appropriate parts of the same quotation | **PASS at level 2** |
| 3 | The 15 steps complete without logging out or changing accounts | **PASS at level 2** (step 7 narration note) |
| 4 | State changes persist and are visible to the next role | **PASS** after a reload (no auto-refresh) |
| 5 | Role permissions remain enforced | **PASS at level 2** (wrong-context POSTs refused, zero writes) |
| 6 | No unexpected authentication prompts | **PASS at level 2**; hosted: BLOCKED until the owner runs it |
| 7 | Repeatable by one presenter | **READY**; needs the owner's UAT environment and sign-ins |

## 8. What I (the coordinator) cannot do

I cannot sign in as any of the three accounts, receive their email codes, pass Vercel protection, create the Supabase branch database or edit Vercel environment variables (my Vercel connection is not authorised for this project). Everything that needs those is listed in section 1; nothing in this document was verified against the hosted authentication.
