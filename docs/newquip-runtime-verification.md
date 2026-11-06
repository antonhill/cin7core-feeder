# NewQuip: production-mode runtime verification of the changed server-action modules

Scope: `src/app/approvals/actions.ts` and `src/app/projects/variation-billing-actions.ts` (both `"use server"`), as built by `next build` and served by `next start` (Next.js 16.4.3), head `a2dd772`. Local fixtures only: no hosted Supabase, no Cin7, no Xero, no email, no writes.

## Method

1. `next build` with dummy local env (`NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_URL` pointing at `127.0.0.1:54399`; no real key is used, `.env.local` is not loaded in the worktree). Cin7 writes flag false.
2. A throwaway Node fixture server on that port stands in for Supabase: `/auth/v1/.well-known/jwks.json` (ES256 key generated per run, so the middleware's local `getClaims()` verification is the real code path), `/auth/v1/user`, and a read-only PostgREST subset (`eq.`, `in.(...)`, `is.null`, single-object `Accept`). ANY write (POST/PATCH/DELETE/rpc) is refused with 403 and logged. Table data is dumped from the repo's own `FakeDb` after building a project, an APPROVED variation with its billing project, a Cin7 Sale link and three invoice postings (RECONCILED + CREATED on the variation's billing project, RECONCILED on the original project).
3. The production server is called over HTTP exactly as the browser does: `POST` with `Next-Action: <id>` (ids read from the client chunks' `createServerReference(id, ..., "name")`) and a signed session cookie, for three fixture users (owner, ordinary member, member whose allow-list excludes the module) and for no cookie.

## Result (41 of 41 checks; 4 of 4 failure-injection checks)

| Area | Observed in the production server |
|---|---|
| Module load | every exported action of both modules that the build registers answers with a handled `{ok, ...}` (no 500, no module-load failure): 17 of the 19 exported actions (13 approvals + 6 variation-billing; the other two are listed under Limits) |
| Not signed in | 307 to `/login` (middleware) |
| Module not allowed | projects: 307 to `/?blocked=%2Fprojects` (middleware gate); approvals: `{ok:false, error:"You don't have access to this feature."}` |
| Not an owner/admin | start billing: "Only an org owner or admin can start variation billing."; amend schedule: "...can amend a variation billing schedule."; approval settings: "Only a manager can change approval settings." |
| Loading | billing state for the owner and for an ordinary member: `ok:true` with the variation's own Sale number (`SO-V1`) and reconciliation `{invoices:2, reconciled:1, awaiting:1, uncertain:0}`; the original project's own posting is NOT counted; approvals dashboard `ok:true` with `awaitingMeIds` (array) for owner and member (`isManager` false for the member) |
| Errors | unknown project: "Project not found."; a billing project id passed as the base: "Load the BASE project; this is a variation billing project."; frozen schedule save: "A APPROVED variation's schedule is frozen..."; malformed arguments return handled `ok:false` (or a handled `ok:true` with defaults for the dashboard), never an unhandled 500 |
| Failure injection | forced 500 on the reconciliation read: billing state still `ok:true`, `reconciliationLookupFailed:true`, no status invented, Sale number still present; forced 500 on the Sale-link read: `saleLookupFailed:true`, reconciliation still correct |
| Writes | none reached a database: 4 write attempts (an admin's test-email/notification calls) were refused by the fixture server and handled; 0 calls to any other endpoint |

## Limits (stated plainly)

- Fixture data and a fixture identity, not the hosted database, real RLS, a real Supabase session or MFA. It proves the built modules load and respond correctly in a production server; it does not replace authenticated UAT on the Preview.
- `submitDocumentForApprovalAction` and `markNotificationReadAction` are exported but referenced by nothing, and are absent from this build's server-reference manifest, so they cannot be invoked over HTTP. They are covered by unit tests only (this predates this wave).
- Negative controls run: adding `export const X = 1` to `variation-billing-actions.ts` makes `next build` itself FAIL in this Next version ("Only async functions are allowed to be exported in a 'use server' file"); a type-only re-export (`export type { T } from`) builds and runs fine here because it is erased. The earlier production outages predate this Next version's build-time check; keep the rule, and keep running a request check after touching an actions file.
- The harness scripts are not committed (scratch tooling), so a reviewer cannot re-run the counts without rebuilding them from the method above. It was last run on the build of the head named at the top.
