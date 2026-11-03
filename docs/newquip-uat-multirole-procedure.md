# NewQuip multi-role UAT procedure (UX-006h)

Status: docs + tests only. No production code, database, hosted user or permission was changed. Written against `feature/newquip-completion` at `3bc629a`.
Accounts are referred to by role only. No email addresses, codes or secrets appear here; keep it that way when you fill in the run sheet.

## 1. How roles are decided (all server-side)

Every quotation action re-derives the caller's identity and roles on the server; the browser never supplies a role.

1. `authoriseActor()` (`src/app/newquip-grower/actor.ts:23`; the same sequence is inlined in `actions.ts:53`) checks the NewQuip organisation, then Quotes module access, then resolves who is acting (the real user, or the Demo identity when Demo Mode is live).
2. **Tier**: `requireOrgAdmin` (`actor.ts:31`) passes only for an org owner/admin (or super admin). Anything else, including an error, is "member" (fails closed).
3. **Functional roles**: `resolveRoles` (`role-store.ts:37`) reads the person's `org_functional_roles` rows and calls `effectiveRoles(assigned, adminTier, strict)` (`roles.ts:55`).
   - With **any** explicit assignment, **only** the assigned roles apply. An admin-tier person also gets `ADMINISTRATOR` added.
   - With no assignment and strict mode off, a member is Rep + Estimator and an admin is Rep + Estimator + Manager + Administrator.
4. `toQuoteRoles` (`roles.ts:63`) maps functional roles to the three quotation roles: `REP -> rep`, `ESTIMATOR -> estimator`, `MANAGER -> manager`. **Nothing else maps to a quote role. `ADMINISTRATOR`, `PROJECT_MANAGER` and `PROCUREMENT` map to no quote role.**
5. **Cost visibility** is separate: `canSeeCosts` (`role-store.ts:47`) is true for the admin tier, or for an explicit ESTIMATOR or MANAGER assignment. A Rep-only user is cost-blind.
6. Quotation transitions are then checked by the pure workflow table (`src/newquip/quote/workflow.ts:23-35`). With migration 0112 applied (it is, on the hosted organisation) the Estimator sign-off, manager approval and returns are additionally decided by the staged approval engine (`approval-store.ts:463`, `policy.ts:42`), which requires the stage's own functional role (`policy.ts:51`).

### Why one account cannot show Rep, Estimator and Manager separately

An admin with **no** assignments holds all three quote roles, so every button works for that one account and nothing shows the separation. The moment any role is assigned explicitly, only that role applies. The POC organisation is already in the second shape: four accounts, each with exactly one explicit role (assigned 2026-10-29), strict mode OFF, migrations through 0117 applied, Rep isolation (0118/0119) not active.

### Exactly what the ADMINISTRATOR-owner account can do

The owner is admin tier with one explicit `ADMINISTRATOR` assignment, so `effectiveRoles` = `{ADMINISTRATOR}` and `toQuoteRoles` = **the empty set**.

- It holds **no quote role**. It cannot create or edit a draft, select a customer, send to the Estimator, sign off, approve, return, issue/send a quotation, record acceptance, or create a project. The screen shows these controls disabled with reasons.
- It **can see cost, margin and the Cost step** (admin tier -> `canSeeCosts` true) and sees every quotation (read).
- It can administer roles, templates and policies (`canAdminister`, `roles.ts`), and the Approvals dashboard offers it a **reasoned override** (`policy.ts:56-60`). The quotation screen's actions never pass `override`, so from the quotation screen the owner is refused (test: "the owner (ADMINISTRATOR) cannot approve through the quotation screen...").
- Consequence for UAT: the owner cannot drive a Rep -> Estimator -> Manager run by itself, and is the right account to **observe** (read-only, with cost) while the other three act.

## 2. Capability matrix (the four existing accounts)

Allowed = the action runs. Denied = the server refuses (error returned, nothing written). "Stage" refers to the step rail; confirm labels on screen.

| Action | OWNER (ADMINISTRATOR) | REP | ESTIMATOR | MANAGER | Server check (file:line) |
|---|---|---|---|---|---|
| Start a quotation | Denied | Allowed | Denied | Denied | `actions.ts:147` |
| Edit / Save draft (REP_DRAFT, ESTIMATOR_REVIEW) | Denied | Allowed | Allowed | Denied | `quote-store.ts:103` via `workflow.ts:44` |
| Load Demo Defaults (client-side fill, then Save) | Not shown (needs edit) | Shown | Shown | Not shown | UI gate `[id]/page.tsx:168,297`; the fill is only stored by Save (above) |
| Select / clear customer, choose contact (Stage 1) | Denied | Allowed | Denied | Denied | `customer-actions.ts:36` |
| Map a product (optional elements) | Denied | Denied | Allowed | Allowed | `actions.ts:136,186` |
| Cost step in Stage 2, cost capture, FX, supplier choice | Allowed (read/capture) | Denied | Allowed | Allowed | `cost-actions.ts:44` (`canSeeCosts`) |
| View cost / GP / margin in the quote payload | Yes | **No (redacted)** | Yes | Yes | `actions.ts:98-104`, `margin.ts:223` |
| Send to Estimator (pre-approval price confirmation) | Denied | Allowed | Denied | Denied | `actions.ts:235`, `workflow.ts:23` |
| Estimator sign-off | Denied | Denied | Allowed | Denied | `policy.ts:51` (staged); `workflow.ts:25` |
| Return to Rep (during estimator review) | Denied | Denied | Allowed | Denied | `policy.ts:50`; at manager review only the Manager may return |
| Manager approve (final) | Denied | Denied | Denied | Allowed (after sign-off) | `policy.ts:51`, `workflow.ts:27` |
| Manager return to Estimator / to Rep | Denied | Denied | Denied | Allowed (manager review only) | `policy.ts:50`, `workflow.ts:29` |
| Issue the customer quotation document | Denied | Allowed | Denied | Allowed | `document-actions.ts:70` |
| Send the quotation to the customer (email) | Denied | Allowed | Denied | Denied | `delivery-actions.ts:102` |
| Record / verify customer acceptance (Stage 4) | Denied | Allowed | Denied | Allowed | `delivery-actions.ts:52,128,145` |
| Change company details | Denied | Denied | Denied | Allowed | `document-actions.ts:22` |
| Create a Project from the accepted quote | Denied | Denied | Denied | Allowed | `actions.ts:310`, `roles.ts:22` |
| Acknowledgement "Mark reviewed & continue" (Cost step) | n/a | n/a | n/a | n/a | Client-local convenience only (UX-006b/c branches, not on this base). It stores nothing and is not a sign-off, so it has no server check and grants nothing |

Notes:
- Manager and Estimator cannot approve/sign off their own quotation's other stage; separation of duties (preparer/originator cannot approve) is in `policy.ts:52-59`.
- The Manager account is a **member** tier. It gets cost visibility from its explicit MANAGER assignment, not from the tier.
- The matrix is asserted by `src/lib/approvals/__tests__/four-account-capability.test.ts` and `src/app/newquip-grower/__tests__/single-role-authz.test.ts`.

## 3. Owner procedure: a real Rep -> Estimator -> Manager run

**Use a safe test quotation only.** A throw-away customer and site name, created by the Rep. Do not use a real customer.

### Setup (once)
1. Use **one browser profile (or one private window) per account**: Owner, Rep, Estimator, Manager. Four windows side by side. Never sign two accounts in the same profile.
2. Open the **Preview origin** for `feature/newquip-completion` (the integration Preview URL; ask for it if you do not have it). In each window:
   1. Pass **Vercel deployment protection** first (Vercel login / share link).
   2. Then the app's own login: enter the account's email, then the **email code**.
   3. **MFA**: the middleware only forces the challenge when the account has a *verified* factor (`middleware.ts:111-112`). The owner is MFA-enrolled, so expect the authenticator prompt for the owner only. The three member accounts have no factor and go straight in.
3. Check each window shows the right identity (account menu), and that the NewQuip **Quotes** module is available.

### The run
| Step | Account | Do | Expected |
|---|---|---|---|
| 1 | Rep | New quotation. Stage 1: select the test Cin7 customer and quotation contact. Fill room/equipment data (or Load Demo Defaults), then **Save draft**. | Save works. No cost, GP or margin anywhere (summary, Stage 2, preview). No Cost step. |
| 2 | Rep | Stage 2 until the **Rep group 3 of 3** (price confirmation). Record the customer's pre-approval confirmation and **Send to Estimator**. | Banner/state **Submitted - awaiting the Estimator**. Quote state ESTIMATOR_REVIEW. Draft fields still editable by Rep (it re-opens review if changed). |
| 3 | Rep | Try Estimator sign-off, Manager approval. | Controls disabled with a reason ("Only an Estimator can sign off", "Final approval needs the manager role"). |
| 4 | Estimator | Open the same quotation. Review; open the **Cost step**; capture costs if needed; **Estimator group**: sign off ("I double-checked this quote"). | Cost and margin visible. Sign-off recorded. Cannot approve; cannot send to the customer. A change to the draft after sign-off withdraws it. |
| 5 | Manager | Open it. **Stage 3 manager approval**: approve (or Return to Estimator to test the return, then re-sign as Estimator). | Approve only enabled after the Estimator signed the current content. State -> MANAGER_APPROVED_FINAL, accepted baseline frozen, quote becomes read-only for everyone. |
| 6 | Owner | Open it. | Read-only view with cost and margin. All action buttons disabled (no quote role). Approvals dashboard shows the history with each real actor. |
| 7 | Rep / Manager | **Stage 4 hand-off screen only: look, do not click.** | See sections below. |

### Stop at Stage 4. What must NOT be run during UAT
Stages 4-6 contain actions with outside effects. **Do not run, without a separate written approval:**
- **Send the quotation to the customer** (sends a real email unless the Preview recipient allowlist suppresses it). No customer emails.
- **Issue/Record acceptance, then Create Project**: creates a project and the Cin7 sale path. **No project creation.**
- Anything that writes to **Cin7** or **Xero** (sales, claims, invoices, posting).
Inspecting the screens, their disabled reasons and the empty states is fine.

### Record
Note per step: account, time, screen text, pass/fail. Screenshot each role's screen at steps 1, 2, 4, 5, 6.

## 4. What to check

Separation of duties:
- The account that sent the quote to the Estimator cannot sign it off; the Estimator cannot approve; the Manager cannot sign off in the Estimator's place; the Owner can do none of the three from the quotation screen.
- Every refusal shows a visible reason, and a forced refusal (it is enforced server-side) writes nothing.
- The approvals history names each *real* actor at each stage (one account per stage).

Cost invisibility for the Rep:
- No cost, GP, margin or Cost step on any Rep screen, including after Send to Estimator, in the preview as you change quantities, and on an approved quotation. Browser dev-tools network responses for the Rep contain no `estimatedCost`/margin values (the server withholds them: `actions.ts:98-104`, `margin.ts:223`).
- Estimator, Manager and Owner see them.

## 5. Optional: Demo Mode (needs your *separate* approval; do not enable as part of this procedure)

Demo Mode lets the owner **impersonate** the Rep, Estimator and Manager test identities from one signed-in session (`docs/projects-poc/demo-mode.md`, `src/lib/demo-mode/*`). It is **impersonation**, not three independent sign-ins: the owner is the real actor in the audit log, with the effective user and a DEMO marker in the detail. Use the three-window procedure above when you want to test genuine separate logins, codes and sessions.

It requires **all** of (`src/lib/demo-mode/config.ts:31`, evaluated on every use):
- `VERCEL_ENV` is `preview` (never Production or local);
- `NEWQUIP_DEMO_MODE_ENABLED=true` (default OFF, server-side);
- `NEWQUIP_DEMO_OWNER_EMAIL` set to the configured owner account;
- the signed-in user is that owner account, in the NewQuip organisation;
- the three demo identities exist as organisation members with their functional roles assigned.

Switching it on means adding the two Preview environment variables for the integration branch and redeploying; switching off is removing `NEWQUIP_DEMO_MODE_ENABLED`. This PR does neither.

## 6. What I could not verify

- Whether `NEWQUIP_DEMO_MODE_ENABLED` / `NEWQUIP_DEMO_OWNER_EMAIL` are set on the integration Preview (assumed off). Not needed for the three-window procedure.
- Whether the three member accounts can **receive their login codes** (mailbox access, spam filtering, sender allowlisting). Test this before the session.
- Hosted state: the role assignments, strict mode, migrations and MFA enrolment are taken from the brief; no database was read in this work.
- The exact stage names and Preview URL on the integration deployment.
- The full Stage 4-6 server behaviour against the real hosted database (acceptance needs the 0115/0117 tables; the test harness cannot prove project creation end to end).

## 7. Owner actions if anything is missing

- A member cannot receive a login code: fix the mailbox/sender allowlisting, or add a reachable mailbox for that account (the owner's Auth admin). I did not change any user.
- A role is missing or wrong for one of the four: reassign on the roles page (`/approvals/roles`) as the owner. Do not assign a second role to a test account: that defeats the single-role proof.
- The Manager cannot create a project or issue documents: complete the company details (Manager-only) and confirm 0115/0117 are applied, before any approved project creation run.
- You want one-window demonstrations: approve Demo Mode separately (section 5).
- The Rep can see customers/quotes that belong to other Reps: expected today. Rep isolation (0118/0119) is not active.

## 8. Test evidence (this PR)

Pre-existing negative coverage (not duplicated):
- `actions-authz.test.ts`: every action refuses a non-NewQuip org and denied module access; a plain member cannot approve; fail-closed to member on admin-check error; member sees no cost; tier-based (not functional-role) cases.
- `customer-actions.test.ts`: only a Rep selects/changes/clears the customer (an estimator refused); organisation isolation; approved quotation immutable.
- `delivery-actions.test.ts`: company details Manager-only; issue needs Rep/Manager (Estimator refused); send Rep-only; record response Rep/Manager; Demo role applies; organisation isolation.
- `cost-actions.test.ts`: a member can use no cost action; other org not found.
- `workflow-roles.test.ts`, `project-create-roles.test.ts`, `staged-approvals.test.ts`: pure workflow/role tables, project-create Manager-only, staged separation of duties, administrator override semantics.

New in this PR:
- `src/lib/approvals/__tests__/four-account-capability.test.ts` (18 tests): `effectiveRoles` / `toQuoteRoles` / `canSeeCosts` for the exact four-account shape with the real role store; ADMINISTRATOR maps to no quote role; workflow transition x single-role matrix; staged policy decisions x single-role account; override is admin-only.
- `src/app/newquip-grower/__tests__/single-role-authz.test.ts` (112 tests): the REAL actions with REAL role resolution over seeded `org_functional_roles` (one role per account, member vs owner tier, staged approvals on). Covers every cross-role refusal for save, create, send, sign off, return, approve, return-to-estimator, project creation in each state (REP_DRAFT, awaiting sign-off, awaiting manager, final), with an exact before/after fingerprint of quotes, approval requests, events, notifications and write count, and no email sent; customer, delivery, document and cost actions per single role; Rep never receives cost/margin (payload, preview, quote record) while Estimator, Manager and Owner do; a Rep cannot forge a cost on save; signed-out and non-NewQuip-org callers are refused for every action file; a Manager of another organisation sees "not found"; the allowed Rep -> Estimator -> Manager path succeeds with each single-role account and records the real actor.
- Harness limits: project creation and acceptance need tables the in-memory database does not model end to end, so the Manager is asserted to pass the role gate only (the preconditions are covered in `quote-to-project-boundary.test.ts`); email/Cin7 calls are mocked or absent.

Mutation proof (production files restored immediately, `git status` clean of src changes): removing the project-create role check failed 5 tests; forcing `hasRole = true` in `policy.ts` failed 20; forcing `canViewCommercials = true` failed the Rep redaction test.
