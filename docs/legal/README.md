# Legal document drafts — read this first

**Status: DRAFT. Not legal advice. Do not send to a client or publish until a
qualified attorney (South African, POPIA-focused) has reviewed and signed off.**

This folder contains draft starting points for three documents Anton asked for
as part of client-readiness hardening (Task #33):

- [`privacy-policy.md`](privacy-policy.md) — public-facing, explains what
  personal information the app processes and why.
- [`data-processing-agreement.md`](data-processing-agreement.md) — the
  contract between Spark Consulting (as operator) and a client (as the entity
  whose Cin7 data, including any customer/personal information in it, is
  processed).
- [`subprocessors.md`](subprocessors.md) — the list of third parties who
  process data on Spark Consulting's behalf, referenced by both documents
  above.

## What these are grounded in

Every technical claim in these drafts was checked against this repo's actual
code and infrastructure as of 2026-07-07, not assumed:

- **Hosting**: Vercel (app/serverless functions).
- **Database**: Supabase (Postgres), project region `eu-west-1` (Ireland) —
  see the Supabase dashboard for the authoritative region if this ever
  changes.
- **Multi-tenant isolation**: every table has Postgres Row-Level Security
  scoped to `is_org_member(org_id)` — one org's data is never queryable by
  another org's session (`supabase/migrations/`, verified directly, see
  `docs/PROJECT-NOTES.md`).
- **Cin7 credentials at rest**: encrypted with AES-256-GCM
  (`src/cin7/crypto.ts`) before being stored; decrypted only in-memory,
  server-side, when calling the Cin7 API.
- **Auth**: Supabase Auth, one-time 6-digit email code (not password-based).
  No self-serve signup — accounts are created by Anton via `/admin`.
- **Audit trail**: `activity_log` table records every live write this app
  makes back to a client's Cin7 instance (who, when, what) — see
  `src/lib/activity-log.ts`.
- **Sub-processors identified**: Vercel Inc., Supabase Inc. (and its
  underlying cloud provider for the `eu-west-1` region — confirm current
  provider on Supabase's own subprocessor page before publishing, as this can
  change without this repo being touched). Cin7 Core itself is **not**
  modeled as a subprocessor here — it's the client's own pre-existing system
  of record; this app reads from and writes to a Cin7 account the client
  already owns and controls, it doesn't receive data from Cin7 on Spark's
  behalf.

## Open questions flagged, not resolved

These drafts do **not** invent answers to things that aren't actually decided
in the product or business today. Before finalizing, decide and fill in:

1. **Data retention / deletion.** There's no automated retention or
   deletion policy in the codebase today — data (including the
   `activity_log`, imported CSV rows, and cached sales/report data) persists
   indefinitely until manually deleted. Decide a real retention period (or
   "until contract termination + N days") and either implement it or state
   the manual process honestly.
2. **Sub-processor list completeness.** Confirm whether any other services
   are in play (email delivery for OTP codes — check which provider Supabase
   Auth's SMTP is configured to use; error/monitoring tooling if any is
   added later).
3. **Governing law / dispute resolution / liability caps** in the DPA —
   these are commercial/legal judgment calls, deliberately left as
   placeholders below.
4. **GDPR applicability.** Spark Consulting and its clients are South
   African; POPIA is the primary framework. GDPR only becomes relevant if a
   specific client's own Cin7 data includes personal information of EU/UK
   data subjects (e.g. an EU customer or supplier contact). The drafts note
   this as conditional rather than assuming it applies.
