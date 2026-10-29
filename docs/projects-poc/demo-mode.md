# NewQuip Demo Mode (owner-only, Preview-only)

Lets the OWNER demonstrate Rep -> Estimator -> Manager on the NewQuip quotation approval workflow without signing in as each test user. Default OFF.

## Activating (Preview only)
Set on the Vercel project, scoped to the `feature/newquip-completion` Preview branch, then redeploy (Preview variables are read at build/run of that deployment):

```
vercel env add NEWQUIP_DEMO_MODE_ENABLED preview feature/newquip-completion --project cin7core-feeder --scope spark18   # value: true
vercel env add NEWQUIP_DEMO_OWNER_EMAIL  preview feature/newquip-completion --project cin7core-feeder --scope spark18   # value: testing@sparkconsulting.co.za
```
Sign in once as `testing@sparkconsulting.co.za`; a dark bar "Demo Mode" appears with an **Act as** selector (Owner / Rep / Estimator / Manager). While a test identity is active the bar turns red and names it, with **Exit Demo Mode**. To switch off: remove `NEWQUIP_DEMO_MODE_ENABLED` and redeploy (a live context then stops working immediately; Exit is always available).

## What it does
- The server issues a signed (HMAC, key derived from `ENCRYPTION_KEY`), HttpOnly, 30-minute cookie that names only a SLOT. The account behind each slot is fixed in code: `rep@`, `estimator@`, `manager@sparkconsulting.co.za`. Nothing the browser sends (email, user id, role, organisation) is ever used as authority. "Owner" is the absence of a context.
- It never replaces the real session. The quotation actions (`/newquip-grower` workflow, the approvals dashboard and notifications) ask the server "who is acting?"; every permission, role (functional roles incl. strict roles), cost-visibility and separation-of-duties check then evaluates the EFFECTIVE test user, using that user's own organisation tier and module access. The effective Rep cannot sign off or approve their own quotation, and the owner's powers do not leak into the effective identity.
- The gate is evaluated on every use: Vercel environment is `preview`, `NEWQUIP_DEMO_MODE_ENABLED=true`, `NEWQUIP_DEMO_OWNER_EMAIL` equals the fixed owner account, the signed-in user IS that account, and the organisation is the NewQuip test organisation. Production, local and unknown environments refuse, even with a validly signed cookie.
- Everything else DENIES while a demo identity is active: `requireModuleAccess` (unless an action is explicitly scoped), `requireOrgAdmin` and `requireSuperAdmin` refuse, as do switching organisation, role/policy administration, cost capture, templates, mappings writes, approval settings and email delivery. Cin7 writes are never performed as an impersonated user (the Cin7-writing paths go through `requireModuleWrite`, which never allows demo).

## Audit
- The approval history (append-only) records the EFFECTIVE user as the actor with an actor name of the form `DEMO · estimator@… (Estimator) · impersonated by testing@…`; the timeline shows a DEMO / IMPERSONATED badge, stage, return destination and the SAST time of the UTC timestamp.
- Every submit, decision (with reason and override flag) and reassignment also writes an `activity_log` row whose actor is the REAL owner and whose detail holds: `demo: true`, `marker: DEMO/IMPERSONATED`, effective user and id, selected role, actual owner and id, document reference and revision, stage, action, reason, and the exact UTC time. Selecting and exiting are logged too.

## Prerequisite for the demonstration
The three test accounts are plain `member`s in the NewQuip organisation. Until the owner assigns functional roles on `/approvals/roles` (rep: Rep, estimator: Estimator, manager: Manager) the manager account cannot give final approval, because the tier fallback gives members only rep + estimator. Roles are not altered by Demo Mode.

## Limitations
- The audit record of a demo action is the immutable actor name plus `activity_log` (no new table, so no migration). A dedicated demo-audit table would be a hardening option.
- Pages other than the quotation workflow and approvals (projects, claims, templates, administration) are not impersonated: their actions refuse while a test identity is active. Exit Demo Mode to use them.
- A logged-out owner session or an expired cookie simply ends the demo context. The cookie is bound to the owner's user id, so another user cannot reuse it.
