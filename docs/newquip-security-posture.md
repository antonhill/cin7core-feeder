# NewQuip security posture and open commercial-launch requirements

Last updated: 2026-10-31. Facts below are the LAST REPORTED state, not permanent: always verify current GitHub, Vercel and Supabase state before acting. No secret values belong in this file.

## Closed
The 31 Oct 2026 credential incident is **CLOSED** (record: `docs/security-incident-2026-10-31-portal-env-disclosure.md`). Do not repeat the investigation unless new evidence emerges.

## State at last report
* PR #126 `feature/newquip-completion` (head `d83f8c5`) unmerged, draft. PR #128 (security hardening) is merged into it. PR #127 (`feature/newquip-rep-customer-assignments`, `1af7c48`) open, stacked on #126. Migration 0118 not applied. 0114 optional and outstanding.
* Internal Toolbox Production runs the previously approved `09e1aba` (it does NOT yet have PR #126's changes; merging #126 to `main` auto-deploys Production). The corrected public portal is already deployed separately.
* Production NewQuip email: OFF (`NEWQUIP_PRODUCTION_EMAIL_ENABLED` unset). Production Cin7 writes: OFF (Preview-only gate). Strict functional roles: OFF. The Production approvals cron is not scheduled.

## Protections implemented in #126 (tested, not yet in Production Toolbox)
Cin7 writes only on an approved Preview + approved Supabase project + explicit flag, with Cin7 instance verification on Sale creation; Administrator role alone cannot see cost/margin in approval detail; Production email needs an explicit opt-in (provider key alone is not enough); staff acceptance evidence is recognised (no contradictory acceptance/decline); response links cannot be locked out by someone who only knows the id; customer text in staff notifications is sanitised; runtime secret redaction and an explicit-field audit record for the portal.

## Readiness
| Use | Status |
|---|---|
| Single-owner internal demo | Suitable for continued controlled development and testing |
| Multiple Reps | NOT ready until customer-level access enforcement (Slice 1B) is complete |
| External subcontractor Site App | NOT ready: needs individual identities, project assignments and access controls |
| Commercial public customer portal | NOT ready until least-privilege access and the items below are done |
| Production email | Must stay OFF until notification environment isolation and queue review |
| Production Cin7 writes | Must stay OFF unless separately authorised through an approved rollout |
Do not describe NewQuip as fully commercially secure or Production-ready.

## Open requirements (tracked debt, not blockers for the owner-operated demo)
A. **Portal least privilege.** The public portal still holds a broadly privileged Supabase credential. Replace it with narrowly scoped authority (link validation, document retrieval, response submission only), and prove it with negative tests. Use separate credentials for Toolbox and portal.
B. **Rep isolation.** PR #127 adds assignments and atomic reassignment, but existing quotation routes and database read policies are still organisation-wide. Complete Slice 1B (assigned-customer enforcement across lists, details, documents, evidence, responses and API routes; keep Manager/Estimator visibility; test cross-Rep and cross-organisation denial). Merging #127 alone does not make Rep isolation complete.
C. **Acceptance verification separation of duties.** A Rep may currently verify an acceptance they helped prepare. Define and enforce an independent verification policy with audit history.
D. **Notification environment isolation.** Preview and Production share notification records. Before enabling Production email: tag rows with their origin (migration), restrict delivery/retries/reminders by origin, clear stale queued/failed rows, confirm recipient restrictions on every send path, keep the explicit opt-in.
E. **Other commercial hardening (deferred P2s, see `docs/security-release-hardening-2026-10-31.md`):** claim/allocation concurrency; approval-document atomicity; Cin7 invoice-posting instance verification; early-invoicing policy; approvals kill-switch self-approval; remaining release-review P2s.

## Rules for future sessions
1. Keep demo readiness and commercial readiness distinct.
2. Do not reopen resolved incidents without new evidence; do not treat deferred risks as P0/P1 without a demonstrated exploitable path and impact. Do not dismiss risks involving real customer data, privileged credentials or unauthorised external writes.
3. Use independent security review for changes that cross a new public, credential or authorisation boundary.
4. Never persist raw `process.env`, privileged tokens or unrestricted request objects in audit or application records; use explicit allowlisted audit fields (`redactSecrets` is a backstop, not the control).
5. Keep the #126/#127 release dependencies explicit. Never merge, deploy, apply migrations, enable email or start Cin7 writes without owner approval.
6. Keep fixes proportionate to the current stage; do not grow a narrow fix into a security programme.
