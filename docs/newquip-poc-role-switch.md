# NewQuip POC role switch (Shirnel) and Estimator-only René

Status: implemented on `feature/newquip-poc-role-switch`, based on the candidate branch. No migration. Not merged, not deployed.

## What it is
One real person, holding several **explicitly assigned** process roles (Rep / Estimator / Manager), chooses which ONE she acts as. The session, the identity and the
role assignments are her own. It is **not impersonation and not a super-admin bypass**: the choice can only *narrow* what she may do, and the server re-derives
everything on every request.

## Who gets the switch
All of: the NewQuip test organisation, an email on the server-side allowlist `NEWQUIP_ROLE_SWITCH_EMAILS` (exact emails, comma separated; **unset = nobody**), and at
least two explicit assignments among Rep / Estimator / Manager. So:
- **Shirnel**: add her exact email to the allowlist (Preview environment variable) and assign her REP, ESTIMATOR and MANAGER in the existing roles screen.
- **René**: assign ESTIMATOR only. No toggle, no Rep or Manager power, whatever the allowlist says.
- **Production default**: the allowlist is empty, so nobody can switch and separation of duties is unchanged. Removing her email (or a role) ends it at once.

## Behaviour
- Prominent three-way toggle with the active role named ("Acting as Estimator"), on every NewQuip page. A switch fully reloads the page, so nothing from the previous role stays on screen.
- Default before any choice, and whenever the choice expires (12 h) or is invalid: **Rep** (least privilege).
- **Rep mode**: no supplier costs, margins, markups, rates or reviewer data (cost visibility is false server-side, even if she is also an organisation admin).
- **Estimator mode**: pricing controls and cost visibility; cannot approve. **Manager mode**: verification and approval; costs visible.
- Organisation admin tier counts only in Manager mode for a switch user (templates, mappings, approvals queue, legacy approval paths).
- The choice is an HMAC-signed, expiring cookie bound to her user id and organisation. Forged, expired, other-user, other-org and no-longer-held selections are ignored.
- Every switch is audited (`newquip.role_switched`: real identity, from, to). Every NewQuip action audit record for a switch user carries `effectiveRole` next to her real email.

## Separation of duties (not weakened)
The existing rule "you prepared or originated this submission, so you cannot approve it" still applies to her real identity across modes. Consequences for the trial:
- She can submit as Rep, then **cannot** sign it off or approve it herself in another mode. Someone else (René as Estimator; Sean or another Manager) must do the later stages of what she submitted.
- As Estimator she can sign off a submission someone else handed off; as Manager she can approve one she did not originate.
- With the NQ-008B hardening (PR #212): she cannot independently verify a supplier cost she entered, even as Manager (independence is per person).
If the owner wants her to be able to run one quotation end to end alone for the POC, that is a **separate, explicit decision** (a POC-only relaxation for allowlisted users). It is deliberately not built.

## Server-side limits to know
The staged-approval database functions (migration 0112) still check the person's full set of assignments; the application narrows by active role first, so the narrowing is enforced in the server application layer, not the database.

## Tests
`role-switch.test.ts` (14: eligibility, René, allowlist, per-mode permissions and cost visibility, admin tier, forgery, audit, separation of duties), `active-role.test.ts`, `active-role-token.test.ts`, `role-switcher.ui.test.tsx`.
