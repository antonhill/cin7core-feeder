# Cin7 Core Feeder — Security Final Closure Matrix

**Status:** `SECURITY SIGN-OFF COMPLETE` — all 7 frozen blockers below are `PROVEN CLOSED` as of 2026-08-18, following an adversarial verification pass (§A2) that found and fixed 2 real gaps the initial implementation missed. Implementation, tests, live verification, and evidence are recorded inline against each blocker in Section C. The original investigation (§6 below, and its own "Status" line) is preserved verbatim as the historical record of how each blocker was found — do not read §6's per-item text as still-open; the closure evidence in Section C is authoritative for current state.
**Date:** 2026-08-18 (investigation), updated 2026-08-18 (closure — same day, sequential passes: 12-agent investigation → Anton's decisions D1–D5 → this implementation)
**Method:** Twelve independent, parallel, read-only investigation passes (one per inventory in §6 below), each instructed to re-derive its surface from current `main` and live Supabase state rather than trust any prior round's classification. This mirrors the methodology that already found real gaps in rounds 2 and 3 of `docs/security-reaudit-report-2026-08-17.md` — the difference this time is scope: every inventory here is deliberately exhaustive (whole-repo greps, live `pg_policies`/grants queries, full lifecycle tracing), not scoped to the paths a prior audit happened to name.
**Purpose:** Replace "FIXED after fixing the examples an audit named" with a finite, enumerated, testable definition of done for security sign-off. The investigation phase (§6) implemented nothing — it defined what implementation had to close. The closure phase (Section C's status lines) is that implementation, frozen to exactly the seven blockers found, per Anton's explicit "execute PR-A through PR-F, run the acceptance checklist, and then stop" instruction.
**Closure PR:** [#57](https://github.com/antonhill/cin7core-feeder/pull/57) — not yet merged (awaiting Anton's explicit merge instruction, per this engagement's standing rule).

---

## A2. Adversarial verification pass (2026-08-18)

After the initial 7-blocker implementation (both commits on PR #57) went CI-green, Anton asked for one final adversarial verification against this exact frozen matrix — not another open-ended hunt. Eight independent agents ran in parallel, one per blocker plus one holistic scope/regression check, each explicitly instructed to be a skeptic (default assumption: the claim might be wrong) and to independently re-derive the fix from actual code/live DB state rather than trust the closure matrix's own claims. Every agent worked against the exact PR #57 branch content, not a paraphrase.

**5 of 7 blockers survived unchanged: CONFIRMED CLOSED.** Blockers 1, 2, 4, 5, and 7. Blocker 1 was confirmed via mutation testing (the fix was reverted, tests were shown to fail, then the revert itself was reverted). Blockers 4 and 5 were independently re-verified live against production (fresh `pg_policies`/RPC-definition queries, not a re-read of the earlier verification). Blocker 5's verifier also honestly flagged one narrower residual edge case (a process crash in the split-second *before* `settlePoCreation` is even called, vs. the settle call itself failing) — correctly assessed as not overturning the verdict, since it doesn't widen the original gap, and filed as hardening, not a blocker. The scope/regression check found zero undisclosed scope creep across all 34 files and zero regressions (full suite, `tsc`, `eslint`, and `next build` all independently re-run and confirmed clean).

**2 of 7 blockers were REFUTED — real gaps, now fixed (third commit on PR #57):**

- **Blocker 3, for 3 of its 4 write-capable diagnostic actions.** The lower-level `src/cin7/debug.ts` helpers (`testSaleShipByWriteBack`, `testProductSupplierLink`, and `testCreatePurchaseOrder`'s `tryPurchaseRequest`/`tryPurchaseOrderLines`) already catch the real Cin7 write's failure internally and return normally instead of throwing — so the audit-logging wrapper, which only branched on whether the *call itself* threw, logged `outcome: "success"` even when the underlying write had actually failed or was genuinely ambiguous. This was worse than the original gap (silence): it was a false record. Only `debugPushOneCustomerAndSupplier` (which calls `pushCustomer`/`pushSupplier` directly, unwrapped) was already correct. **Fix:** each wrapper now inspects the real result (`result.putSucceeded` / `result.attempts.some(...)` ) instead of the call's throw/no-throw behavior; `CreatePurchaseOrderAttempt` gained an `ambiguous?: boolean` field (set from `Cin7ApiError.ambiguous`) so the create path can still report a genuine ambiguous outcome accurately. New tests cover all 3 previously-untested wrappers, including a test asserting the exact false-success scenario the verification found no longer occurs.
- **Blocker 6's permanent regression guard**, not the underlying fix (the POST-handler deletion itself was independently re-confirmed complete — zero live exploit remains). The original `internal-tenant-scoping-route.test.ts` matched only the literal `body.orgId` shape of the deleted code; the verifier constructed 3 syntactically-different reintroductions of the identical vulnerability (destructuring `const { orgId } = await req.json()`, a differently-named whole-body variable, a differently-suffixed property name like `targetOrgId`) and confirmed none were flagged. **Fix:** replaced the single regex with a multi-step scan — every whole-body variable assigned from `req.json()`/`request.json()` is tracked, then any property access off it whose name merely *contains* an org-id shape (case-insensitive) is flagged; destructuring assignments are matched directly. A new test proves all 3 constructed bypasses, plus the original vulnerable shape and a query-string variant, are now caught, alongside a negative control. Explicitly documented, not silently glossed over: a tenant id derived *indirectly* (e.g. via a DB lookup keyed by a differently-named body field) still can't be caught by a text-level scan — that shape needs human review, which this guard's own doc comment now says outright.

Both findings were classified per the frozen-scope rule before being touched: each is evidence that an existing blocker's own closure claim was incomplete, not a newly-discovered, independent vulnerability — so both were fixed in place as part of closing the existing blocker, not proposed as an 8th blocker. Re-verification after the fix: `tsc`/`eslint` clean, full suite 1266/1266 passing (up from 1260 — the new tests), production build clean. Both fixes committed as a third commit on PR #57 branch `security/final-closure-seven-blockers`.

---

## A. Executive summary

### Why repeated rounds happened

Three rounds of remediation on this codebase, plus a P1-7 follow-up, all shipped real, verified fixes — and every round still left sibling gaps a later, deeper pass found. The pattern is visible directly in this repo's own history:

- Round 1 added non-idempotent-POST retry protection to Purchase Order and Stock Transfer creation. Round 3 found six more Cin7 create calls (customers, suppliers, products, work centres, references, production BOM) with the identical unprotected-retry shape.
- Round 1 fixed RLS on exactly one table (`category_instances`) found missing it entirely. Round 3 found four *more* tables where RLS existed but the policy's role check was wrong (`is_org_member` where the design intended `is_org_admin`) — and **this investigation just found a fifth: `category_instances` itself**, the very table round 1 "fixed," still carries an `is_org_member`-gated ALL policy that its own policy name (`"org admins manage category_instances"`) contradicts. The original fix closed "RLS is enabled," not "RLS matches intent."
- Round 3 built `requirePrivilegedOrgAdmin` specifically to close a gap where AAL2 (2FA) enforcement depended only on middleware page-gating, not the Server Action itself. This investigation found that guard **fails open on a Supabase read error** — the identical class of bug P1-1 (round 2) fixed in a different guard, reintroduced in the very guard built to fix a different, unrelated hole.
- Round 3's own report explicitly named four side-findings it investigated but did not fix (diagnostics authorization, `/api/sync*` routes, audit-log coverage, credential encryption) and filed them as "not urgent." This investigation re-examined all four against current code and found two of them are not optional hardening — they are live, reachable authorization and forensic-trail gaps that meet this framework's own definition of a sign-off blocker (§4 of the originating brief).

The common root cause across every one of these: a fix was verified against the paths an audit happened to enumerate, and "FIXED" was declared once those paths were closed, without a structural guarantee that no sibling path existed. None of the individual fixes were wrong. The *closure criterion* was incomplete — "the examples are fixed" was accepted as evidence for "the property holds everywhere."

### What this investigation changes

Every inventory below enumerates a complete surface (whole-repo greps, live DB state, full lifecycle traces — not a re-read of the prior report's file list) and proposes a **permanent, CI-enforced invariant** for its class, not just a one-time fix. Seven findings meet the sign-off-blocker bar. Two of them (`category_instances`, PO/Stock-Transfer claim TTL-reclaim) are newly discovered by this pass and were never named in any prior round. The rest are reclassifications of items the prior report filed as "side-findings, not urgent" — this investigation argues explicitly, per finding, why the "no real callers" or "hardening only" framing undersold the risk.

**No code was fixed. No FIXED label was assigned. This document uses only: `PROVEN CLOSED` (an inventory found nothing to fix), `OPEN — SIGN-OFF BLOCKER`, `OPEN — HARDENING`, `ACCEPTED RISK`, `NEEDS ANTON DECISION`, `NOT APPLICABLE`.**

### Confidence and scale

29 Cin7-network paths, 20 Cin7 POST/PUT-as-create call sites, 28 privileged/diagnostic Server Actions, 10 org-resolution paths, 60 tables + 34 functions (100% of the public schema, queried live), 145 service-role call sites, 7 lock/claim mechanisms, 15 internal API route×method handlers, 31 diagnostic actions, 24 Cin7-write-and-credential-change paths, 27 import/export/large-payload paths, and the full credential-encryption lifecycle were each independently enumerated. Five of twelve inventories (gateway, POST classification, active-org, service-role, import/export) came back **`PROVEN CLOSED`** — genuinely nothing found beyond hardening-tier gaps. Seven blockers were found across the other seven inventories.

---

## C. Security blockers (finite numbered list)

Only these seven items meet the brief's own bar for a sign-off blocker (§4A: unauthorized access, privileged-authorization bypass, MFA bypass, duplicate Cin7 transactions, fail-open controls, DB role-boundary bypass). Each is independently reproducible from the citation given.

### Blocker 1 — `requirePrivilegedOrgAdmin` fails open on a Supabase read error

**File:** `src/lib/require-privileged.ts` (~lines 51–59). Both `db.from("super_admins")...` and `db.from("organizations")...` destructure only `{ data }`, never checking `error`. On any DB read failure (RLS misconfiguration, dropped connection, transient error), both come back falsy → `isSuperAdmin = false`, `orgCanWrite = false` → the guarding `if (isSuperAdmin || orgCanWrite) await requireAal2(action)` is skipped entirely, and the privileged action proceeds with **zero AAL2 (2FA) check**. Affects all 8 `requirePrivilegedOrgAdmin` call sites: `listInstances`/`upsertInstance`/`deleteInstance` (Cin7 credentials), `getCheckoutUrlAction`/`getManageSubscriptionUrlAction` (billing), `inviteTeamMemberAction`/`removeTeamMemberAction`/`setTeamMemberModulesAction` (team/role management). This is the identical bug class P1-1 (round 2) fixed in `requireModuleAccess` — reintroduced in the guard round 3 built specifically to close a different AAL2 gap. `requirePrivilegedSuperAdmin` is unaffected (no side DB reads of its own).

**STATUS: PROVEN CLOSED (2026-08-18).**
- **Implementation:** `src/lib/require-privileged.ts` — both reads now destructure `error` and `throw new Error(...)` immediately on a truthy value, before either `isSuperAdmin`/`orgCanWrite` is computed. `src/middleware.ts` — audited its 3 equivalent reads (`super_admins`, impersonated-org lookup, `org_members`); confirmed the actual security boundary (`requireAal2`, called from `require-privileged.ts`) checks the live session's AAL directly via Supabase auth and does not depend on any middleware read, so middleware's own reads were hardened to `console.error`-log on failure (observability) rather than adding a second fail-closed redirect, which would risk a redirect loop on `/` (reasoned through explicitly in code comments).
- **Migration:** none (pure application code).
- **Tests:** `src/lib/__tests__/require-privileged.test.ts` — 4 new fault-injection tests: `super_admins` read error throws (never proceeds unchecked); `organizations` read error throws; a `super_admins` error can never be silently treated as "is a super-admin"; AAL2 still passes normally once both reads succeed (no over-correction). 16/16 tests passing in this file.
- **Live evidence:** N/A (pure application-code change, no schema).
- **CI:** PR #57 — see PR for final result.
- **Permanent regression guard:** the 4 fault-injection tests above, kept in CI indefinitely.

### Blocker 2 — Diagnostic surface gated by `requireOrgAdmin`, not `requireSuperAdmin`

**File:** `src/app/settings/instances/actions.ts`, chokepoint `loadInstanceCreds`. 27 of 31 `debug*`-prefixed Server Actions (surface grew by one — `debugProbeUpdatedSinceFiltering` — since round 3's "26 of 30" count) are reachable by any ordinary customer org's own admin, despite being documented everywhere (code comments, the `settings/diagnostics` page gate) as super-admin-only tooling. At least three return raw PII directly to that org admin: `debugFindCustomerSupplierExamples` (customer+supplier name/email/phone/address), `debugFetchCustomerByName` (full raw Cin7 customer record), `debugSurveySaleFulfillmentFields` (full raw sale detail including customer/ship-to and line amounts). Per this report's own P1-2 finding, a Server Action is reachable independent of whether its gating page was ever rendered — `debugProbeUpdatedSinceFiltering` proves this directly: it has no button anywhere in the diagnostics UI and is only reachable as a raw POST.

**STATUS: PROVEN CLOSED (2026-08-18).**
- **Implementation:** `src/app/settings/instances/actions.ts` — all 31 `debug*`-prefixed exports now call `requirePrivilegedSuperAdmin(<action description>)` as the first statement in their own body (mechanically applied and individually reviewed), instead of relying on `loadInstanceCreds`'s internal `requireOrgAdmin` call. The 4 write-capable actions that previously had a bare `requireSuperAdmin()` "defense in depth" call were upgraded to `requirePrivilegedSuperAdmin` (adding AAL2). The 2 actions that needed `orgId` directly (`debugCheckCustomerReferenceFields`/`debugCheckSupplierReferenceFields`) now get it via `requireCurrentOrg()` alongside the new guard call. `loadInstanceCreds` itself is unchanged (still `requireOrgAdmin`) since it's also the legitimate chokepoint for `testInstanceConnection`, an ordinary org-admin feature, not a diagnostic.
- **Migration:** none.
- **Tests:** `src/app/settings/instances/__tests__/actions.test.ts` (new file, none existed before) — a static per-function scan asserting all 31 `debug*` exports call `requirePrivilegedSuperAdmin(` in their own body, and that the guard appears before any `requireOrgAdmin(` call in the same body where one exists (i.e., org-admin is never checked first). 45/45 tests passing in this file (shared with Blocker 3's behavioral tests, see below).
- **Live evidence:** N/A.
- **CI:** PR #57.
- **Permanent regression guard:** the static scan test above — a newly-added `debug*` action without the guard fails this test immediately.

### Blocker 3 — Zero audit logging on the diagnostic surface, including genuine Cin7 writes

**File:** `src/app/settings/instances/actions.ts`. None of the 31 diagnostic actions call `logActivity`, including the 4 that perform real writes into a customer's live Cin7 account: `debugTestSaleShipByWriteBack` (writes a sale's ShipBy field back), `debugTestProductSupplierLink` (writes a product record), `debugTestCreatePurchaseOrder` (creates a real DRAFT Purchase Order — the same path round 3 already flagged as having no reconciliation, now additionally found to have no audit trail either), `debugPushOneCustomerAndSupplier` (pushes real customer/supplier PII into Cin7). A compromised or malicious super-admin session's diagnostic writes into a customer's account leave zero record anywhere in this application. Extends to `upsertInstance`/`deleteInstance` (Cin7 credential create/update/delete) — also uncalled by `logActivity` despite being the single most security-sensitive write surface in the app.

**STATUS: PROVEN CLOSED (2026-08-18) — including a real gap found and fixed by adversarial verification (see §A2).**
- **Implementation:** `src/app/settings/instances/actions.ts` — new shared `logPrivilegedWrite` helper wraps `logActivity` with a mandatory `outcome: "success" | "failed" | "ambiguous"` field. All 4 write-capable diagnostic actions now log on every path. `upsertInstance` (both create and update paths) and `deleteInstance` now log success/failure, deliberately never including the raw or rotated Application Key in the logged `detail` — only whether a key rotation happened (boolean).
- **Adversarial-verification finding (2026-08-18, fixed same day):** the initial implementation branched the logged outcome on whether the *wrapper call itself* threw — but `testSaleShipByWriteBack`, `testProductSupplierLink`, and `testCreatePurchaseOrder`'s internal helpers (`src/cin7/debug.ts`) already catch the real Cin7 write's failure and return normally instead of throwing. Result: 3 of the 4 write-capable actions logged `outcome: "success"` even when the underlying write had actually failed or was genuinely ambiguous — a false record, worse than the original silence. Only `debugPushOneCustomerAndSupplier` was already correct (it calls `pushCustomer`/`pushSupplier` directly, unwrapped). **Fixed:** each wrapper now inspects the real result (`result.putSucceeded`, `result.attempts.some(a => a.succeeded)`) instead of throw/no-throw; `CreatePurchaseOrderAttempt` (debug.ts) gained an `ambiguous?: boolean` field, set from `Cin7ApiError.ambiguous` in `tryPurchaseRequest`/`tryPurchaseOrderLines`, so the create path can still report a genuine ambiguous outcome accurately.
- **Migration:** none.
- **Tests:** `src/app/settings/instances/__tests__/actions.test.ts` — behavioral tests for all 6 write paths, rewritten for `debugTestCreatePurchaseOrder` to mock the real `{attempts: [...]}` resolved shape (not a rejection, which the real function never does) across success/ambiguous/failed cases, plus a dedicated test asserting the exact false-success scenario the verification found no longer occurs; new tests added for `debugTestSaleShipByWriteBack` and `debugTestProductSupplierLink` (previously untested), each proving a real-but-caught failure logs `"failed"`, not `"success"`. `upsertInstance`/`deleteInstance`/`debugPushOneCustomerAndSupplier` tests unchanged (those 3 were already correct). 50/50 tests passing in this file.
- **Live evidence:** N/A.
- **CI:** PR #57 (3rd commit).
- **Permanent regression guard:** the behavioral test suite above, kept in CI.

### Blocker 4 — `category_instances` RLS policy contradicts its own name and documented intent

**Live-verified via `pg_policies` on project `pnzwjqjovxxdikxtfngq`.** The table's only write policy is named `"org admins manage category_instances"` but its actual `USING`/`WITH CHECK` clause calls `is_org_member(org_id)`, not `is_org_admin(org_id)` — an internal contradiction baked into the policy definition itself. Both real application callers (`syncInstanceSales`, `getReportFilterOptions`) always use a service-role client, so RLS is the *only* thing standing between an ordinary member's own session token and full read/write access to this table — and today it stands between nothing. This is the exact table round 1's `0072_reconstruct_category_instances_rls.sql` "fixed" (its own comment states the table "has no legitimate reason to reach this table at all" for *any* client role), and the exact bug class round 3's `0078` migration fixed on four *other* tables. It slipped through three rounds because no prior pass checked a policy's own qual text against its own name.

**STATUS: PROVEN CLOSED (2026-08-18) — Anton's decision D4 (service-role-only) implemented.**
- **Implementation:** the table's only policy was dropped entirely — zero client-facing policies remain, RLS stays enabled (deny-by-default with no matching policy), service-role bypasses RLS as before so both real callers are unaffected.
- **Migration:** `supabase/migrations/0079_category_instances_service_role_only.sql` — `drop policy if exists "org admins manage category_instances" on category_instances;`. Applied live via `apply_migration` (recorded as `20260818094622 category_instances_service_role_only`).
- **Tests:** `supabase/tests/0079_category_instances_service_role_only.test.sql` (new) — seeds an org with an admin, a member, and a cross-org admin from a second org; proves all three get zero SELECT/UPDATE/DELETE/INSERT access; proves the service-role path still reads and writes correctly.
- **Live evidence:** (1) the fix was live-verified in a `begin;...rollback;` transaction *before* being applied for real — member/admin/cross-org all denied, service-role unaffected; (2) applied for real via `apply_migration`; (3) post-apply, live-re-queried `pg_policies` (0 policies), `pg_class.relrowsecurity` (`true`), and `information_schema.role_table_grants` for `anon` (0 rows — inherited from round 3's `0078` blanket revoke) — all match intent exactly; (4) the exact checked-in test file (not just an equivalent inline query) was re-run against the real post-migration production state and passed.
- **CI:** PR #57.
- **Permanent regression guard:** the checked-in SQL test above, run by the `migration-and-security-tests` CI job on every PR against a freshly-bootstrapped database; also covered generically (not just for this one table) by the new §6.5 RLS policy-name-vs-intent invariant (see regression guardrail #6 below), which would have caught this exact bug on its own.

### Blocker 5 — PO / Stock Transfer creation-claim TTL-expiry reclaim ignores claim status

**Files:** `supabase/migrations/0055` (`po_creation_claim`), `0056` (`stock_transfer_creation_claim`). Both RPCs reclaim a claim purely on `created_at` age past the 15-minute TTL — `pending`, `ambiguous`, and `completed` are all reclaimed identically. Round 3's P1-5 fix made the *acquisition* path fail closed on a guard-RPC error, but never addressed this separate failure mode: if a network failure leaves a claim `ambiguous` (Cin7 may have already committed the create) and nobody retries within the TTL window, the next attempt gets `claimed: true` directly with **zero reconciliation** — `findLikelyCreatedPurchaseOrder`/`findLikelyCreatedStockTransfer` only ever run while the claim is still live, never on a freshly-reclaimed one. A user who closes the tab after an ambiguous failure and returns the next day to reorder the identical items will silently create a duplicate Purchase Order or Stock Transfer in the customer's live Cin7 account. Untested: both existing regression tests (`0055`/`0056` `.test.sql`) only exercise `completed`-claim expiry, never `ambiguous`.

**STATUS: PROVEN CLOSED (2026-08-18) — Anton's decision D5 (reconcile before reclaim) implemented.**
- **Implementation — SQL:** both RPCs now check `if v_status = 'ambiguous' then return query select false, v_status, ...;` *before* the TTL-age comparison, so an ambiguous claim keeps returning `existing_status: 'ambiguous'` regardless of age — forcing the caller's already-correct reconciliation branch (`findLikelyCreatedPurchaseOrder`/`findLikelyCreatedStockTransfer`) to run every time. `pending` and `completed` claims are unaffected — they still reclaim by age exactly as before (the intentional "allow a later reorder" behavior for `completed`, and "never attempted" semantics for `pending`).
- **Implementation — app-layer Scenario D (settle-persistence-failure):** `settlePoCreation`/`settleStockTransferCreation` changed from `Promise<void>` to `Promise<boolean>`, returning whether the settle write itself succeeded. `src/app/supplier-planner/actions.ts`/`src/app/replenish/actions.ts`'s main create-success path now calls `markPoCreationAmbiguous`/`markStockTransferCreationAmbiguous` as a fallback when settle returns `false` — closing the gap where Cin7 confirms success but the DB write recording that fact fails, which previously left the claim silently stranded at `pending` (indistinguishable from "never attempted") rather than `ambiguous`.
- **Migration:** `supabase/migrations/0080_claim_ambiguous_never_age_reclaims.sql` — `create or replace function` for both RPCs. Applied live (recorded as a new migration on project `pnzwjqjovxxdikxtfngq`).
- **Tests:** `supabase/tests/0080_claim_ambiguous_never_age_reclaims.test.sql` (new) — for both PO and Stock Transfer claims: an expired ambiguous claim is never reclaimed; a still-live ambiguous claim also blocks (unchanged); an expired pending claim still reclaims (unchanged); an expired completed claim still reclaims (unchanged, "allow a later reorder" preserved). `src/lib/__tests__/po-idempotency.test.ts`/`stock-transfer-idempotency.test.ts` — new tests for `settlePoCreation`/`settleStockTransferCreation` returning `true`/`false`. `src/app/supplier-planner/__tests__/actions.test.ts`/`replenish/__tests__/actions.test.ts` (new files, none existed before) — Scenario D test proving a settle failure calls the ambiguous-fallback (and does NOT when settle succeeds).
- **Live evidence:** (1) both RPC fixes live-verified in a `begin;...rollback;` transaction before applying — ambiguous-past-TTL never reclaims, pending/completed-past-TTL still reclaim, still-live ambiguous still blocks, for both PO and Stock Transfer; (2) applied for real via `apply_migration`; (3) the exact checked-in test file re-run against the real post-migration production state and passed.
- **CI:** PR #57.
- **Permanent regression guard:** the checked-in SQL test above, run by the `migration-and-security-tests` CI job on every PR.

### Blocker 6 — `/api/sync*` POST handlers trust a body-supplied `orgId` behind a shared secret

**Files:** `src/app/api/sync/route.ts`, `sync-sales`, `sync-purchases`, `sync-assembly-builds`, `sync-product-availability`, `sync-production-runs` (all 6). Every POST handler reads `orgId` directly from `request.json()` after only a static `CRON_SECRET` bearer-token check (`assertInternalAuth`), then performs real Cin7-triggering writes scoped to that org via a service-role client. This is the exact shape round 2 judged "strictly more dangerous" and deleted outright for `/api/import`. Anyone who obtains the one static `CRON_SECRET` string (log leak, CI env compromise, Vercel project-settings leak) can act as service-role against **any** org by changing the JSON body — no session, no membership, no MFA. Confirmed still present on current `main`; confirmed zero legitimate callers for any POST handler (only the GET cron entries are configured in `vercel.json`); 4 of 6 already have a redundant session-scoped Server Action replacement. Zero legitimate callers means zero cost to closing this — that argues for higher priority, not lower.

**STATUS: PROVEN CLOSED (2026-08-18) — Anton's decision D2 (delete all six) implemented; regression guard hardened by adversarial verification (see §A2).**
- **Implementation:** the exported `POST` handler was removed entirely from all 6 route files. `GET` (the real Vercel Cron entry point) and `maxDuration` are unchanged. No replacement Server Actions were built for `sync-purchases`/`sync-assembly-builds` (explicitly out of scope per D2). The deletion itself was independently re-confirmed complete by adversarial verification — zero live exploit remains, zero orphaned callers anywhere in the repo.
- **Adversarial-verification finding (2026-08-18, fixed same day):** the *deletion* was never in question, but the initial permanent regression guard (`internal-tenant-scoping-route.test.ts`) only matched the literal `body.orgId` shape of the deleted code. The verifier constructed 3 syntactically-different reintroductions of the identical vulnerability class — `const { orgId } = await req.json()` (destructuring), a differently-named whole-body variable, and a differently-suffixed property name (`targetOrgId`) — and confirmed none were flagged, meaning the guard's own claim ("the permanent guard against a future internal route reintroducing the same shape") was overstated. **Fixed:** replaced the single regex with a multi-step scan (`readsOrgIdFromRequest`) — tracks every whole-body variable assigned from `req.json()`/`request.json()`, then flags any property access off it whose name merely *contains* an org-id shape case-insensitively, plus direct destructuring. Documented, not silently glossed over: a tenant id derived *indirectly* (via a DB lookup keyed by a differently-named field) still can't be caught by a text-level scan — that needs human review.
- **Migration:** none (pure route-file change).
- **Tests:** `src/test/__tests__/internal-tenant-scoping-route.test.ts` — confirms all 6 routes' `POST` export is gone while `GET` remains; the hardened scan; confirms known-safe routes correctly don't trip it; new test proving all 3 constructed bypasses (plus the original vulnerable shape and a query-string variant) are now caught, with a negative control. 5/5 tests passing.
- **Live evidence:** N/A (no schema/data change). Repo-wide search confirmed zero remaining callers of any of the 6 removed POST endpoints. `vercel.json`'s cron entries (GET-only by design) are unaffected.
- **CI:** PR #57 (3rd commit).
- **Permanent regression guard:** the hardened scan above — a future route reintroducing this vulnerability class (shared secret + request-body-derived tenant identifier, any naming shape + service-role client, no session guard) fails CI immediately.

### Blocker 7 — PO / Stock Transfer creation actions skip audit logging on a fully-failed batch

**Files:** `src/app/supplier-planner/actions.ts`, `src/app/replenish/actions.ts`. Both call `logActivity` only `if (created.length)` — a batch where every attempt fails or comes back ambiguous produces **zero** `activity_log` row. This directly undermines the P0-2 ambiguous-create mechanism's own purpose: if Cin7 actually committed the object despite the ambiguous response, that object is now permanently untraceable in the app's own audit trail, and if a later retry succeeds, only the (possibly duplicate) second object is ever logged.

**STATUS: PROVEN CLOSED (2026-08-18).**
- **Implementation:** the `if (created.length)` gate is removed — `logActivity` now runs unconditionally at the end of every batch. Each `FailedPurchaseOrder`/`FailedTransfer` entry gained an optional `kind?: "failed" | "ambiguous" | "blocked"` field, set at every push site (ambiguous-reconciliation-not-found → `"ambiguous"`; guard-unavailable/concurrent-claim → `"blocked"`; definite Cin7 rejection → `"failed"`). The logged `detail` now reports `requested`/`created`/`reconciled`/`failed`/`ambiguous`/`blocked` counts plus the full per-group detail arrays, and the summary string names each non-zero category.
- **Migration:** none.
- **Tests:** `src/app/supplier-planner/__tests__/actions.test.ts`/`src/app/replenish/__tests__/actions.test.ts` (new files) — a 100%-failed batch still logs exactly once with `created: 0`; an ambiguous outcome is counted separately from a definite failure; a guard-unavailable outcome is counted as `blocked`, not `failed`; a successful batch still logs correctly (no regression).
- **Live evidence:** N/A.
- **CI:** PR #57.
- **Permanent regression guard:** the behavioral test suite above, kept in CI.

---

## D. Hardening backlog (does not block sign-off)

Defense-in-depth and consistency items with no live authorization or data-integrity consequence today.

| # | Item | Source | Why not a blocker |
|---|---|---|---|
| H1 | `cin7RawRequest` never reports a 503 to the shared rate-limiter cooldown | 6.1 | Diagnostics-only; asymmetry with `cin7Request`, not itself exploitable |
| H2 | `cin7RawRequest` has no explicit whole-operation deadline | 6.1 | Safe today only because it never retries (implicit, not enforced) — a future edit adding retry without a deadline would reopen P0-4's class of bug |
| H3 | `debug.ts`'s `testCreatePurchaseOrder` has `nonIdempotentCreate` set but zero regression test and no reconciliation | 6.2 | Mitigated by `requireSuperAdmin` gate + DRAFT-only writes (though Blocker 3 shows the gate itself has no audit trail) |
| H4 | `markSaleShipped`'s idempotency is asserted by design comment, never live-verified or tested; `updateSaleShipBy`/`testProductSupplierLink` have no regression test | 6.2 | Correctly classified today, just undertested |
| H5 | Ordinary-member Cin7-writing actions (Supplier Planner, Replenish, Bulk Pricing, Data Audit, Reorder Points, catalog push) were never evaluated for an admin/AAL2 gate beyond module+billing | 6.3 | Likely intentional (member-facing tools by design) but never an explicit decision — see Decision D1 |
| H6 | No CI enforcement against a new `createServiceRoleClient()` call site shipping without a preceding guard | 6.6 | 145 current call sites are clean; this is a proliferation-prevention gap, not a current hole |
| H7 | 3 Cin7-write report actions manually chain `requireModuleAccess`+`requireWriteAllowed` instead of the named `requireModuleWrite()` composite | 6.6 | Functionally identical today; drift risk on future guard changes |
| H8 | 5 internal-helper RPCs (`recompute_*_hash` ×4, `record_ship_by_change_pending`) retain default `anon`/`authenticated` EXECUTE grants | 6.5 | Not exploitable — target-table RLS blocks any effect |
| H9 | Every `report_*` RPC and `is_org_admin`/`is_org_member`/9 trigger functions retain `anon` EXECUTE | 6.5 | Harmless (both helpers evaluate false for null `auth.uid()`) but an unclosed instance of the "anon gets nothing" principle round 3's `0078` established for tables |
| H10 | Sync pipeline (product/customer/supplier/BOM push) audit-logs an aggregate count only, no per-record target | 6.10 | Coarse granularity, not a live vulnerability — the underlying pushes are correctly authorized and reconciled |
| H11 | Shipment-status-change actions produce no `activity_log` entry at all | 6.10 | Write path is already correctly authorized; this is a traceability/support gap |
| H12 | Data Audit tier logs field names changed but not before/after values | 6.10 | Cosmetic completeness gap against a literal policy reading |
| H13 | 7 single-shot report RPCs have no explicit application-level row cap, relying implicitly on PostgREST's default max-rows | 6.11 | No code-level backstop if that platform default ever changes |
| H14 | 7 bulk-write JSON-array actions have no explicit array-length cap of their own | 6.11 | Safe today only because the array is always client-computed from a prior server-scoped fetch |
| H15 | Credential encryption has no key version/keyId/AAD/rotation support | 6.12 | AES-256-GCM confirmed sound; nonce reuse and wrong-key-decrypt behavior both live-verified safe; missing AAD requires DB write access (already full compromise) to matter |
| H16 | `cin7-gateway-boundary.test.ts` only scans `src/cin7/` for a literal `fetch(` token | 6.1 | Doesn't cover the whole repo or catch an aliased import/new HTTP client/wrapper function — concrete widening proposed in §6.1 |

---

## E. Product / operational backlog (no security consequence)

| # | Item | Source |
|---|---|---|
| P1 | An org admin can degrade their own org's live sync by repeatedly triggering multi-call diagnostic probes (quota is per-credential-keyed, not cross-tenant) | 6.9 |
| P2 | `/api/delete-expired-trials` and `/api/notify-ship-by-changes` share the `CRON_SECRET`-only auth primitive but take no client-controlled scope parameter — flagged for completeness, not a vulnerability | 6.8 |
| P3 | `uploadOrgLogo` (super-admin) deliberately left without AAL2 — already a documented, reviewed exception | 6.3, 6.6 |
| P4 | `debug.ts` mixes ~26 read-only probes with 1 genuine-write tool in one 2000+-line file with no module-level distinction between them | 6.1 |

---

## F. Decisions required from Anton

Only genuine product/risk calls — everything else in this document has a single defensible remediation path.

**D1 — Do the ordinary-member Cin7-writing action families (Supplier Planner PO creation, Replenish transfers, Bulk Pricing, Data Audit apply/merge, Reorder Points, catalog push) need an admin-role and/or AAL2 gate beyond today's module+billing gate?** These perform real, high-impact Cin7 writes but were built as member-facing tools by design. Relates to H5 — not currently a blocker, but the decision should be explicit rather than inherited silently.

**D2 — For the 6 `/api/sync*` POST handlers (Blocker 6): delete outright, or keep with real authorization added?** 4 of 6 (`sync`, `sync-sales`, `sync-product-availability`, `sync-production-runs`) already have a redundant session-scoped Server Action replacement — deleting their POST handler is a pure attack-surface reduction with no functionality lost. `sync-purchases` and `sync-assembly-builds` have no replacement today; if on-demand triggering of those two is still wanted, a session-scoped Server Action needs building first (small, same shape as the other 4), or those two POST handlers are deleted too and that capability is simply not offered on-demand (the recurring cron still covers them).

**D3 — Audit-log closure strategy per divergence (Blockers 3, 7, and Hardening H10–H12): close the gap (Option A) or narrow the privacy policy's "every write" wording (Option B)?** The investigation's recommendation, item by item: diagnostics writes, credential changes, and the 100%-failed-batch gap (Blockers 3 and 7) → **Option A**, cheap and closes a real forensic-trail hole. Shipment-status changes (H11) → Option A preferred if cheap, Option B acceptable as an interim. Sync-pipeline aggregate-only logging (H10) → **Option B now** (narrow the wording immediately, cheap), **Option A later** as its own larger follow-up (would need every push call site to report per-SKU outcome). Needs sign-off on scope and sequencing before implementation.

**D4 — For `category_instances` (Blocker 4): recreate the policy as `is_org_admin`-gated (matching the fix pattern already applied to the 4 other tables in migration `0078`), or move to zero-policies/service-role-only, matching what the table's *own* original fixing migration's comment says was actually intended?** Both are one-line SQL changes. The choice determines whether any client role gets direct table access to this table going forward at all.

**D5 — For PO/Stock Transfer claim TTL-expiry (Blocker 5): should an `ambiguous` claim simply never auto-reclaim (requiring a background reconciliation sweep or manual clear), or should the reclaim path itself call the existing `findLikelyCreatedPurchaseOrder`/`findLikelyCreatedStockTransfer` reconciliation before allowing a retry?** The first is a smaller SQL-only change with a UX cost (a claim could stay stuck until manually cleared); the second closes the gap without ever blocking a legitimate retry, at the cost of adding a reconciliation call to the RPC-adjacent app code path.

---

## G. Proposed final remediation plan (not implemented — grouping only)

Smallest sensible PR set, each independently shippable and independently CI-verifiable:

**PR-A — Guard fail-open fix + regression backstops.** Blocker 1 (`requirePrivilegedOrgAdmin` error handling — mirrors the exact P1-1 fix pattern already in the codebase). Bundle H6 (service-role allowlist test) and H16 (widen the gateway boundary scan) since both are cheap, no-product-code-change regression-test additions with no dependency on any Anton decision.

**PR-B — Diagnostics authorization + audit trail.** Blockers 2 and 3 together (both touch the same 31 `debug*` actions and the same `settings/instances/actions.ts` file): every `debug*` action calls `requireSuperAdmin`/`requirePrivilegedSuperAdmin` directly instead of inheriting `loadInstanceCreds`'s `requireOrgAdmin`; the 4 write-capable diagnostic actions plus `upsertInstance`/`deleteInstance` gain `logActivity` calls. No Anton decision needed — both are structural fixes matching the app's own existing conventions.

**PR-C — `category_instances` RLS correction.** Blocker 4. One migration (shape depends on Decision D4), following the exact `expect_no_effect` regression-test pattern migration `0078` already established. Blocked on D4.

**PR-D — Write-integrity claim reconciliation on reclaim.** Blocker 5. SQL + adjacent app-layer change to the PO/Stock Transfer claim RPCs (shape depends on Decision D5), new "ambiguous-then-TTL-expiry-then-reclaim" regression test on both claim tables. Blocked on D5.

**PR-E — `/api/sync*` route closure.** Blocker 6. Shape depends on Decision D2 — likely delete 4 POST handlers outright, and either delete or replace the remaining 2.

**PR-F — Audit-log completion.** Blocker 7 (unconditional `logActivity` on PO/Transfer batches) — small, no Anton decision needed, can ship standalone or bundled with PR-B. Privacy-policy wording narrowing (part of Decision D3) travels with whichever PR closes the sync-pipeline logging question, or ships as its own docs-only change if Option B is chosen there.

**PR-G (optional, explicitly non-blocking — may ship after sign-off or be deferred indefinitely).** H1–H4, H7–H9, H13–H15's proposed regression tests and small consistency fixes (nonce-reuse property test, RPC anon-grant cleanup, `requireModuleWrite` consistency, report-RPC/bulk-write caps). None of these gate `SECURITY SIGN-OFF COMPLETE`.

---

## H. Final acceptance checklist

Objective yes/no. Once every line is checked, `SECURITY SIGN-OFF COMPLETE` may be declared without another open-ended remediation round.

- [x] Blocker 1 — `requirePrivilegedOrgAdmin` throws (does not silently proceed) on any Supabase read error; a fault-injection test proves AAL2 is still enforced when either underlying read errors.
- [x] Blocker 2 — every `debug*`-prefixed Server Action calls `requireSuperAdmin`/`requirePrivilegedSuperAdmin` directly; the proposed static-scan test (every `debug*` export must call the guard textually, not inherit it) is in CI and passes.
- [x] Blocker 3 — the 4 write-capable diagnostic actions and `upsertInstance`/`deleteInstance` call `logActivity`; a test asserts each does.
- [x] Blocker 4 — `category_instances`'s live RLS policy matches Anton's D4 decision; verified live against production plus a permanent regression test.
- [x] Blocker 5 — PO/Stock Transfer claim TTL-expiry reclaim matches Anton's D5 decision; a new ambiguous-then-expiry regression test exists for both claim tables and passes.
- [x] Blocker 6 — all 6 `/api/sync*` POST handlers are either deleted or rewritten to require real session/org-membership authorization, per Anton's D2 decision. (Deleted.)
- [x] Blocker 7 — PO/Stock Transfer creation actions log unconditionally regardless of batch outcome; a test asserts a 100%-failed batch still produces an `activity_log` row.
- [x] Every closure test above passes locally (`tsc`, `eslint`, `vitest run` — 1266/1266 across 132 files after the adversarial-verification fixes (§A2), `next build`) — see PR #57 for the full CI pipeline result (install/lint/typecheck/test/build, dependency scan, secret scan, migration+RLS test matrix).
- [x] `docs/security-final-closure-matrix.md` is updated: each closed blocker's status line moves from `OPEN — SIGN-OFF BLOCKER` to `PROVEN CLOSED` with a citation to its evidence (test file, live-verification transcript, or PR) — see Section C above.
- [x] `docs/security-reaudit-report-2026-08-17.md` gets a short round-4 entry cross-referencing this closure matrix rather than re-narrating it.
- [x] No new finding was silently folded into scope during implementation — the only issue encountered mid-implementation (the two `.tsx`/`import/actions.ts` files initially missed by the service-role-allowlist grep) was a snapshot-completeness correction to a *new regression guard being built*, not a new security finding; it did not touch the 7-blocker scope.

**All boxes checked. `SECURITY SIGN-OFF COMPLETE` — see PR [#57](https://github.com/antonhill/cin7core-feeder/pull/57) for the actual diff and CI run, not yet merged pending Anton's explicit instruction.**

### Verification output (final closure, post-adversarial-verification)

```
$ npx tsc --noEmit
(clean, no output)

$ npx eslint src
(clean, no output)

$ npx vitest run
 Test Files  132 passed (132)
      Tests  1266 passed (1266)

$ npm run build
✓ Compiled successfully
(all 50 routes built, no errors)
```

Local verification above re-run after the 2 adversarial-verification fixes (§A2) landed as a 3rd commit on PR #57 — all clean. First-commit CI run (all jobs green, before the adversarial-verification fixes): PR [#57](https://github.com/antonhill/cin7core-feeder/pull/57) — [run #32126551216](https://github.com/antonhill/cin7core-feeder/actions/runs/32126551216)
- `Install, lint, typecheck, test, build`: success
- `Dependency vulnerability scan`: success
- `Secret scan`: success
- `Clean migration bootstrap + RLS/security test matrix`: success (confirms `0079`, `0080`, `0081` all pass against a freshly-bootstrapped database, not just the live production instance)
- `Vercel Preview Comments`: success

The 3rd commit (adversarial-verification fixes) triggers its own fresh CI run on the same PR — see PR #57 directly for its result.

Migrations confirmed live via Supabase `list_migrations` (project `cin7toolbox`, `pnzwjqjovxxdikxtfngq`):
- `20260818094622 category_instances_service_role_only` (0079, Blocker 4)
- a new entry for `claim_ambiguous_never_age_reclaims` (0080, Blocker 5)

PR [#57](https://github.com/antonhill/cin7core-feeder/pull/57) open against `main`, not yet merged.

---

## B. Complete closure matrices

### Security closure register (9-field entries, one per blocker)

| Field | Blocker 1 — AAL2 fail-open | Blocker 2 — diagnostics role | Blocker 3 — diagnostics unlogged | Blocker 4 — `category_instances` RLS | Blocker 5 — claim TTL-reclaim | Blocker 6 — `/api/sync*` | Blocker 7 — batch audit gap |
|---|---|---|---|---|---|---|---|
| **Property** | Every privileged action requiring AAL2 must actually enforce it, even on a guard-dependency read error | Super-admin-only diagnostics must be unreachable below super-admin privilege | Every real Cin7/credential write from the diagnostic surface must be attributable | Every table's live RLS policy must match its own documented/named intent | A write-integrity claim must never blindly retry an operation whose outcome is unknown | No shared machine secret may select an arbitrary tenant for a privileged write | Every Cin7 create attempt, successful or not, must be traceable |
| **Complete surface** | 8 `requirePrivilegedOrgAdmin` call sites (§6.3) | 31 `debug*` actions (§6.9) | Same 31 + `upsertInstance`/`deleteInstance` (§6.9, §6.10) | 60 tables, live-queried (§6.5) | `po_creation_claims`, `stock_transfer_creation_claims` (§6.7) | 6 route files × POST (§6.8) | `supplier-planner`/`replenish` actions.ts (§6.10) |
| **Current gaps** | Both DB reads in the guard ignore `error` | 27 of 31 gated by `requireOrgAdmin` | 0 of 31 log; credential CRUD unlogged | 1 of 60 tables (policy text vs. name mismatch) | Both RPCs reclaim by age only, ignoring status | All 6 trust body `orgId` post-secret-check | `logActivity` gated on `created.length` |
| **Already safe** | `requirePrivilegedSuperAdmin` (no side reads); the other 7 privileged guards (§6.3) | 4 write-capable actions correctly double-gated with `requireSuperAdmin` already | N/A | 59 of 60 tables verified matching intent | Acquisition-failure path (round 3 fix) is sound | GET handlers (rotation, no client input) | Success-containing batches are logged correctly |
| **Required remediation** | Capture and throw on `error` from both reads (mirrors `requireModuleAccess`'s P1-1 fix) | Replace the shared `requireOrgAdmin` inheritance with a direct `requireSuperAdmin`/`requirePrivilegedSuperAdmin` call per action | Add `logActivity` to 4 write actions + 2 credential actions | Recreate policy per Decision D4 | Branch expiry logic per Decision D5 | Delete or re-gate per Decision D2 | Move `logActivity` outside the `if (created.length)` guard |
| **Blocking classification** | ~~SIGN-OFF BLOCKER~~ → **PROVEN CLOSED** | ~~SIGN-OFF BLOCKER~~ → **PROVEN CLOSED** | ~~SIGN-OFF BLOCKER~~ → **PROVEN CLOSED** | ~~SIGN-OFF BLOCKER~~ → **PROVEN CLOSED** | ~~SIGN-OFF BLOCKER~~ → **PROVEN CLOSED** | ~~SIGN-OFF BLOCKER~~ → **PROVEN CLOSED** | ~~SIGN-OFF BLOCKER~~ → **PROVEN CLOSED** |
| **Closure test** | Fault-injection test: DB read throws → AAL2 still enforced — **done, 4 tests, passing** | Static scan: every `debug*` export calls `requireSuperAdmin` textually — **done, passing** | Test: each of the 6 actions calls `logActivity` — **done, passing** | Live `pg_policies` re-query + regression test — **done, live-verified pre/post-apply** | New ambiguous-then-expiry test on both claim tables — **done, live-verified pre/post-apply** | Route test — **done, POST handlers confirmed removed, GET confirmed intact** | Test: 100%-failed batch still produces an `activity_log` row — **done, passing** |
| **Permanent regression guard** | 4 fault-injection tests in `require-privileged.test.ts`, kept in CI | `settings/instances/actions.test.ts`'s static scan, kept in CI | Same test file's behavioral suite, kept in CI | `0079_category_instances_service_role_only.test.sql` + the new generic `0081_rls_policy_name_intent_check.test.sql`, both in the `migration-and-security-tests` CI job | `0080_claim_ambiguous_never_age_reclaims.test.sql`, in the same CI job | `internal-tenant-scoping-route.test.ts` (generic, not `/api/sync*`-specific), kept in CI | `supplier-planner`/`replenish` `actions.test.ts` behavioral suites, kept in CI |
| **Decision needed** | None | None | None | D4 — **answered: service-role-only** | D5 — **answered: reconcile before reclaim** | D2 — **answered: delete all six** | None (D3 — **answered: Option A**, implemented) |

### Status of all 12 inventories

Status as found at investigation time (2026-08-18, before implementation). Every blocker named below is now **PROVEN CLOSED** — see Section C for closure evidence; this table is left as the historical investigation record, not re-labeled, per "do not rewrite historical rounds."

| # | Inventory | Status (at investigation) | Blockers found | Blocker status now |
|---|---|---|---|---|
| 6.1 | Cin7 network gateway | **PROVEN CLOSED** | 0 (2 hardening) | — |
| 6.2 | Every Cin7 POST | **PROVEN CLOSED** | 0 (2 hardening) | — |
| 6.3 | Privileged Server Actions | OPEN | Blocker 1, contributes to Blocker 2 | **CLOSED** |
| 6.4 | Active-org resolution | **PROVEN CLOSED** | 0 | — |
| 6.5 | RLS / DB permission matrix | OPEN | Blocker 4 | **CLOSED** |
| 6.6 | Service-role usage | **PROVEN CLOSED** | 0 (2 hardening) | — |
| 6.7 | Write-integrity locks/claims | OPEN | Blocker 5 | **CLOSED** |
| 6.8 | Internal API routes | OPEN | Blocker 6 | **CLOSED** |
| 6.9 | Diagnostic surface | OPEN | Blockers 2, 3 | **CLOSED** |
| 6.10 | Cin7 write audit coverage | OPEN | Blocker 3 (shared), Blocker 7 | **CLOSED** |
| 6.11 | Import/export boundary (P1-7 verification) | **PROVEN CLOSED** | 0 (2 hardening) — P1-7 confirmed complete | — |
| 6.12 | Credential encryption lifecycle | **ACCEPTED RISK / HARDENING** | 0 — confirmed no live exploit | — |

---

### §6.1 — Cin7 network gateway (PROVEN CLOSED)

29 distinct Cin7-network-capable code paths enumerated (2 gateway functions in `src/cin7/http.ts` + 27 caller modules across `src/cin7/` and `src/audit/`). Every path funnels through `cin7Request` or `cin7RawRequest` — confirmed via repo-wide grep for `fetch(`, axios/got/undici/XMLHttpRequest, and via the fact every file importing either gateway function traces back to only these two. No file outside `src/cin7/http.ts` calls `fetch` directly anywhere in the repo (route handlers, `src/audit/`, `scripts/`, or elsewhere).

**Gaps (hardening only):** `cin7RawRequest` doesn't report 503s to the shared cooldown (H1); has no explicit whole-operation deadline, safe today only because it never retries (H2).

**Proposed invariant:** widen `cin7-gateway-boundary.test.ts` from `src/cin7/` to the whole `src/` tree, and add a companion check that the two literal Cin7 auth header names (`api-auth-accountid`, `api-auth-applicationkey`) appear only inside `http.ts`'s two functions — this catches a wrapper-function or aliased-fetch bypass the token-level scan alone would miss.

### §6.2 — Every Cin7 POST (PROVEN CLOSED)

20 POST/PUT-as-create call sites enumerated across `src/cin7/*.ts` and `src/audit/*.ts`. All 20 correctly classified: 8 `NON_IDEMPOTENT_CREATE` (all carry `nonIdempotentCreate: true`), 2 `RECONCILE_BEFORE_RETRY` (PO/Stock Transfer, gold-standard — full claim table + reconciliation), 9 `VERIFIED_SAFE_POST_UPDATE`, 1 `IDEMPOTENT_POST` (assumption undertested — see H4).

**Gaps (hardening only):** `debug.ts`'s diagnostic PO-create has the flag but zero regression test and no reconciliation (H3, mitigated by the super-admin gate — though Blocker 3 shows that gate itself is unlogged); `markSaleShipped`/`updateSaleShipBy`/`testProductSupplierLink` lack regression tests locking in their classification (H4).

**Proposed invariant:** a checked-in `docs/cin7-post-classification.json` allowlist plus a static test that fails the build on any `cin7Request` call site with `method: "POST"`/PUT-as-create not already in the allowlist, and fails if an allowlisted `nonIdempotentCreate: true` claim doesn't match the actual source line.

### §6.3 — Privileged Server Actions (OPEN — Blocker 1)

28 privileged/diagnostic-adjacent actions enumerated across every `actions.ts`/`src/actions/*.ts` file. The 13 sites round 3 upgraded to `requirePrivilegedOrgAdmin`/`requirePrivilegedSuperAdmin` are all still correctly wired — but the guard itself has Blocker 1's fail-open bug. `requirePrivilegedSuperAdmin` call sites (org admin/member/module management, impersonation) are unaffected. Deliberately-unguarded actions (`uploadOrgLogo`, `clearImpersonatedOrgAction`, read-only listers) are correctly, explicitly documented exceptions.

**New surface found beyond the 13 originally-fixed sites:** the diagnostic chokepoint (`loadInstanceCreds`, feeds into Blocker 2) and 7 families of ordinary-member Cin7-writing actions never evaluated for an admin/AAL2 bar (H5, Decision D1).

**Proposed invariant:** `privileged-action-inventory.test.ts` — glob every `actions.ts`/`src/actions/*.ts` export, flag any touching credentials/membership/org state or a Cin7 write, assert it calls an allow-listed guard or carries a documented exemption comment.

### §6.4 — Active-org resolution (PROVEN CLOSED)

10 org-resolution paths enumerated. Exactly one authoritative rule (`resolveActiveOrgId` in `src/lib/active-org-resolution.ts`) is used directly or transitively by every session-scoped security decision: middleware, `requireCurrentOrg`, `getCurrentUserInfo`, and every guard built on top of them. The one intentionally-independent path (super-admin impersonation, `org-switch.ts`) re-verifies its own precondition (super-admin + AAL2) on every use rather than trusting a cookie, and is correctly justified. No second instance of middleware's original `.limit(1)` bug was found anywhere else in the codebase — every other `.limit(1)`/`.single()` hit against `org_members` or job tables was individually audited and confirmed to be an idempotency check or "most recent row" lookup downstream of an already-resolved `orgId`, not a competing active-org resolution.

**Proposed invariant:** a repo-scan test flagging any file other than the canonical module querying `org_members` with `.limit(1)`/`.single()`.

### §6.5 — RLS and DB permission intent matrix (OPEN — Blocker 4)

60 tables and 34 functions enumerated — 100% of the `public` schema, queried live against `pg_policies`/`information_schema.role_table_grants`/`pg_proc`, not read from migration files alone (migration-file drift from live state is independently documented elsewhere in this repo's own history). `anon` has zero table-level grants anywhere (confirmed matching the `0078` revoke). 59 of 60 tables match documented intent. **`category_instances` does not — see Blocker 4.**

Full table and RPC matrices (as returned by the investigation) are preserved in the session transcript for this investigation; the single actionable row is Blocker 4 above. Hardening gaps: 5 internal-helper RPCs and every `report_*`/`is_org_*`/trigger function retain a default `anon`/`authenticated` EXECUTE grant, not currently exploitable (H8, H9).

**Proposed invariant:** (1) a policy-name-vs-qual literal-text check — any policy name matching `/\badmin/i` must have `is_org_admin(` in its qual, not merely `is_org_member(` — would have caught Blocker 4 directly; (2) a checked-in `supabase/permission-intent.yaml` diffed against live state in the existing `migration-and-security-tests` CI job on every PR; (3) generalize the `expect_no_effect` seed-and-assert pattern (from `0078`'s own test) into one parametrized test iterating every table in the intent file.

### §6.6 — Service-role usage (PROVEN CLOSED)

145 `createServiceRoleClient()` call sites enumerated across ~70 files — confirmed exhaustive via a separate grep for the `SUPABASE_SERVICE_ROLE_KEY` env var itself (referenced nowhere outside the one named helper; no bypass construction pattern exists anywhere in the repo). Every call site traced: either it *is* an authorization guard (needs the service role to read tables with no client-facing RLS), or it is preceded by a real guard call, or its tenant scope is fully server-derived (cron/webhook) rather than client-trusted. No Severity-A finding — no service-role path accepts client-trusted tenant scope without a preceding authorization check.

**Gaps (hardening only):** no CI enforcement against a *future* unguarded call site (H6); 3 report actions bypass the named `requireModuleWrite()` composite in favor of manually chaining its two constituent checks (H7).

**Proposed invariant:** a repo-scan test diffing `createServiceRoleClient(` call sites against a checked-in allowlist snapshot (`scripts/service-role-allowlist.json`), failing the build on any new, unreviewed site.

### §6.7 — Write-integrity lock/claim inventory (OPEN — Blocker 5)

7 lock/claim/dedup mechanisms enumerated (PO claim, Stock Transfer claim, `sync_locks`, `sync_route_locks`, `push_jobs`/`pull_jobs` chunk lock, plus 2 correctly-out-of-scope notification-debounce tables). No undiscovered mechanism guarding a Cin7 write exists beyond what round 3 already named — **the gap is not in the census, it's in the lifecycle.** `sync_locks` and the job-chunk lock are correctly classified read/cache-coordination (Category A, safe fail-open) because every push they guard has its own independent find-by-identifier check immediately before any create. PO and Stock Transfer claims are correctly classified write-integrity (Category B) — but their TTL-expiry reclaim logic was never re-examined after round 3's acquisition-failure fix, and that's where Blocker 5 lives.

**Proposed invariant:** a required "ambiguous-then-TTL-expiry-then-reclaim" test for every claim table with a non-terminal "unknown outcome" status — seed an ambiguous claim past TTL, call the claim RPC again, assert it does NOT silently return `claimed: true` with no reconciliation.

### §6.8 — Internal API route inventory (OPEN — Blocker 6)

15 route×method handlers enumerated across 9 files. All 6 `/api/sync*` POST handlers confirmed still present and still body-`orgId`-trusting on current `main` — no change since round 3's investigation flagged this as a side-finding. This investigation argues explicitly that "zero real callers" does not downgrade the severity: the risk is a property of what a secret-holder can do, not of who currently calls it, and zero legitimate callers means zero cost to closing it. `/api/delete-expired-trials` and `/api/notify-ship-by-changes` share the same auth primitive but take no client-controlled scope parameter (P2, product/ops only). `/api/webhooks/lemonsqueezy` uses a different, correctly-scoped auth model (per-request HMAC + server-resolved token lookup, confirmed clean).

**Proposed invariant:** a static/regex repo-scan flagging any `route.ts` POST/PUT/PATCH/DELETE handler whose only source of an `orgId`-shaped identifier is `request.json()`/`searchParams` while also constructing a service-role client.

### §6.9 — Diagnostic surface inventory (OPEN — Blockers 2, 3)

31 diagnostic Server Actions/probes enumerated (confirmed current count, up one from round 3's "26 of 30"). 27 under-gated (Blocker 2); zero audit logging on any of them, including the 4 already correctly super-admin-gated write-capable ones (Blocker 3, corroborated independently by §6.10). Quota exhaustion via diagnostics is confirmed bounded to the triggering org's own credential bucket, not cross-tenant (P1, product/ops only). `cin7/debug.ts`'s underlying probe functions take no authorization parameter of their own — safe today purely because nothing else imports them, not because the module itself enforces anything (P4).

**Proposed invariant:** a static test asserting every `debug*`-prefixed export in `settings/instances/actions.ts` calls `requireSuperAdmin(` textually before any call to `loadInstanceCreds`/`requireOrgAdmin`.

### §6.10 — Cin7 write audit inventory (OPEN — Blockers 3 (shared), 7)

24 write paths enumerated (22 Cin7 API writes + 2 credential-change paths). The privacy policy's literal "every write" / "all writes... recorded" claim is confirmed unchanged on current `main`. Divergence found and severity-argued per category: superadmin diagnostic writes and credential changes unlogged → **Blocker 3** (shared with §6.9's independent finding of the same gap); PO/Transfer 100%-failure-batch logging gap → **Blocker 7**, a new finding beyond round 3's own write-up, directly colliding with the P0-2 ambiguous-create mechanism's purpose; sync-pipeline aggregate-only logging → hardening (H10); shipment-status changes unlogged → hardening (H11); Data Audit tier missing before/after values → hardening (H12).

**Recommendation per divergence (Decision D3):** Option A (close the gap) for diagnostics/credentials/failed-batch logging — cheap, closes a real forensic hole. Option B now / Option A later for the sync-pipeline aggregate-only gap — narrowing the wording is cheap and immediate, per-record logging is a larger follow-up.

### §6.11 — Input/export boundary inventory (PROVEN CLOSED — P1-7 verified complete)

27 distinct import/export/large-payload paths independently re-derived (not trusting P1-7's own count). Both CSV-parse call sites funnel through the shared limits; all 14 XLSX export actions funnel through `renderXlsxBase64`; `buildIncludedSalesCsv` is confirmed the *only* human-facing CSV export — every other `toCsv`-based export was directly read and confirmed to be a genuine Cin7 round-trip template (2 explicitly document this in their own code comments); the one genuinely-unbounded pager (`fetchAllRpcRows`) is capped and tested. **No sibling gap P1-7 missed was found.**

**Gaps (hardening only, pre-existing and named in P1-7's own writeup, not something P1-7 missed):** 7 single-shot report RPCs rely implicitly on PostgREST's default max-rows rather than an explicit app-level cap (H13); 7 bulk-write JSON-array actions have no explicit array-length limit of their own (H14).

**Proposed invariant:** repo-scan tests asserting `Papa.parse(`/`new ExcelJS.Workbook(`/`toCsv(` calls only appear at their known, reviewed chokepoints — a new call site outside the allowlist fails the build.

### §6.12 — Credential encryption lifecycle (ACCEPTED RISK / HARDENING)

Independently re-verified, not just re-classified: AES-256-GCM confirmed; IV is a fresh 12-byte CSPRNG value per call with no reuse path found anywhere (live-verified: repeated encryption of the same plaintext produces different ciphertext); wrong-key/tampered decrypt fails loudly via GCM auth-tag rejection (live-verified), never silently. Key never logged, never client-exposed, never echoed by any of the ~25 diagnostic paths (traced all of them). Missing AAD is a real defense-in-depth gap but not independently exploitable — exploiting it would require DB write access, which is already a full-compromise precondition given the app+RLS layers otherwise prevent any cross-row ciphertext mixing. **Call-site count corrected: 5, not the previously-reported 4** (`toRecord()`'s `keyLast4` derivation was not previously counted).

**Verdict: genuinely pure hardening. No present-tense exploitable weakness found.** No rotation capability exists today — a suspected-compromise rotation would require a manual, synchronized cutover script, which is an operational limitation, not an attacker-triggerable weakness.

**Proposed remediation shape (future pass, not scoped for sign-off):** versioned envelope prefix (`v2:<keyId>.<iv>.<tag>.<ciphertext>`), dual-format decrypt fallback, opportunistic re-encryption on next write, AAD bound to `org_id:instance_id` added at the same time. **Proposed regression test now, cheap and independent of that future work:** a property-based test asserting `encrypt()` never reuses an IV across N calls, and a test asserting `decrypt()` always throws (never returns) on ciphertext produced by a different key (H15).
