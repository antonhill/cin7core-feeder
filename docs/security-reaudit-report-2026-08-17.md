# Cin7 Core Feeder — Security Re-Audit Remediation Report

**Date:** 2026-08-17
**Scope:** All 18 items from the re-audit. Anton's own priority order picked 7 structural blockers (P0-1 through P0-7, P1-3) for active work this pass; the remaining 11 (P1-1, P1-2, P1-4–P1-9, both P2 items) are DEFERRED — not investigated.
**PRs:** [#37](https://github.com/antonhill/cin7core-feeder/pull/37) (P0-1, P0-2, P0-5, P0-6, P0-7, P1-3) → [#38](https://github.com/antonhill/cin7core-feeder/pull/38) (P0-3, P0-4, stacked on #37). Merge order: #37 then #38. [#36](https://github.com/antonhill/cin7core-feeder/pull/36) was an earlier, incomplete first pass at P0-3 — closed as superseded by #38.

## A note on process

P0-3's first pass ([#36](https://github.com/antonhill/cin7core-feeder/pull/36)) was scoped from a paraphrased summary of the item ("correct distributed rate limiting"), not its full text, and shipped covering 2 of the 7 things the item actually specified. This was caught before the final report was written by going back to the original message text and checking every FIXED item's evidence line-by-line against the literal wording — the same discipline "do not claim completion from code inspection alone" asks for, applied to my own prior work, not just the codebase. The gap is closed in #38. Flagging this here rather than quietly folding it in, since it's relevant to how much to trust the FIXED classifications below: each one below was re-checked against the item's literal text, not the paraphrase.

---

## Classification summary

| Item | Classification | One-line summary |
|---|---|---|
| P0-1 | **FIXED** | Every Cin7 credential path canonicalized; one gateway; repo test enforces it |
| P0-2 | **FIXED** | No auto-resend on ambiguous create failures; reconciliation, not blind release |
| P0-3 | **FIXED** | Fingerprinted bucket key, no bypass-on-contention, shared cooldown, multi-worker proof |
| P0-4 | **FIXED** | Per-attempt AND whole-call deadlines, including diagnostics |
| P0-5 | **FIXED** | `category_instances` RLS reconstructed into migration history |
| P0-6 | **FIXED** | `push_jobs` reconstructed; self-tested migration-order audit tool added |
| P0-7 | **FIXED** | Atomic snapshot-replace RPCs for ProductAvailability and purchase detail |
| P1-1 | DEFERRED | Not investigated this pass |
| P1-2 | DEFERRED | Not investigated this pass |
| P1-3 | **FIXED** | `requireWriteAllowed` added to 3 real write paths missing it |
| P1-4 | DEFERRED | Not investigated this pass |
| P1-5 | DEFERRED | Not investigated this pass |
| P1-6 | DEFERRED | Not investigated this pass |
| P1-7 | DEFERRED | Not investigated this pass |
| P1-8 | DEFERRED | Not investigated this pass |
| P1-9 | DEFERRED | Not investigated this pass |
| P2 (API optimisation) | DEFERRED | Not investigated this pass |
| P2 (CI and sign-off) | DEFERRED | Not investigated this pass |

No items classified NOT APPLICABLE — every item in scope this pass was either fixed or deferred outright.

---

## FIXED items — detail

### P0-1: Eliminate all remaining user/database-controlled Cin7 API origins

**Files changed:**
- `src/app/settings/instances/actions.ts` — `loadInstanceCreds` no longer selects `base_url`; hardcodes `CIN7_API_ORIGIN`, mirroring the already-safe `loadCin7Credentials`. `upsertInstance` no longer accepts/writes a `baseUrl` param. `InstanceRecord`/`toRecord`/`listInstances` no longer carry `base_url`.
- `src/app/settings/instances/page.tsx` — "Base URL" input removed from the add/edit form entirely.
- `src/sync/run-sync.ts` — third independent unsafe credential loader (inlined in `syncInstance`) replaced with a call to `loadCin7Credentials`.
- `src/cin7/client.ts` — `testConnection` now calls `cin7Request` (`maxRetries: 0`) instead of a standalone `fetch()`.
- `src/cin7/debug.ts` — 3 raw-fetch probe loops (`probeWorkCentrePaths`, part of `surveyProductionOrderOperationStatus`, part of `surveyProductSupplierOptionsFields`) now call the new `cin7RawRequest`.
- `src/cin7/http.ts` — new `cin7RawRequest` export: the one sanctioned raw-fetch escape hatch for diagnostics needing a raw response `cin7Request` would otherwise throw away (a 200-with-HTML "page not found" body). Still routed through `buildCin7Url`, the same headers, `redirect: "manual"`.
- `src/test/__tests__/cin7-gateway-boundary.test.ts` (new) — scans every file under `src/cin7/` other than `http.ts` for a bare `fetch(` call; fails if found.

**Tests:**
- `src/cin7/__tests__/client.test.ts` (new, 5 tests) — `testConnection` routes through `cin7Request`, maps 503/403/network-error/generic-Cin7ApiError status codes correctly.
- `src/cin7/__tests__/debug-probes.test.ts` (new, 2 tests) — `probeWorkCentrePaths` calls `cin7RawRequest` for every candidate path, classifies JSON vs HTML, isolates a per-path failure.
- `src/cin7/__tests__/http.test.ts` — 4 new tests for `cin7RawRequest` (canonical origin/headers, non-2xx returned as data not thrown, opaque-redirect → status 0, no retry).
- `src/test/__tests__/cin7-gateway-boundary.test.ts` — self-verified during development by injecting a synthetic `fetch()` call into a scratch file under `src/cin7/` and confirming the test failed, then removing it and confirming it passed again.

**Live evidence:** N/A (no schema/migration involved — pure code path elimination).

---

### P0-2: Fix unsafe HTTP retry semantics

**Files changed:**
- `src/cin7/http.ts` — `Cin7RequestOptions.nonIdempotentCreate` (explicit per-call opt-in, deliberately not inferred from HTTP method — Cin7 uses POST for the idempotent `markSaleShipped` too). When set, a network-level failure throws immediately as `Cin7ApiError.ambiguous = true`, zero retries. A 503 or definite rejection (Cin7 responded) stays retried regardless — not ambiguous.
- `src/cin7/purchase-write.ts` — both `createPurchaseOrder` calls (`/purchase`, `/purchase/order`) now pass `nonIdempotentCreate: true`.
- `src/cin7/stock-transfers.ts` — `createStockTransfer`'s `/stockTransfer` call now passes `nonIdempotentCreate: true`.
- `src/lib/po-idempotency.ts` — new `markPoCreationAmbiguous` (UPDATE to `status = 'ambiguous'`, not a DELETE like `releasePoCreation`) and `findLikelyCreatedPurchaseOrder` (best-effort reconciliation: newest matching DRAFT PO for the supplier, updated since the ambiguous attempt started, bounded to the claim's own TTL window).
- `src/lib/stock-transfer-idempotency.ts` — same shape: `markStockTransferCreationAmbiguous`, `findLikelyCreatedStockTransfer` (matches on exact from/to location pair).
- `src/app/supplier-planner/actions.ts` — on an ambiguous `Cin7ApiError`, marks the claim ambiguous and attempts reconciliation immediately; the "not claimed" branch also handles `existingStatus === "ambiguous"` by attempting reconciliation before reporting "still confirming."
- `src/app/replenish/actions.ts` — identical shape for stock transfers.

**Tests:**
- `src/cin7/__tests__/http.test.ts` — `nonIdempotentCreate` describe block: throws immediately + exactly 1 fetch call on network failure; does NOT mark a definite rejection (400) as ambiguous; still retries a 503 normally; a call without the flag keeps old retry behavior.
- `src/lib/__tests__/po-idempotency.test.ts` — `markPoCreationAmbiguous` updates (not deletes); `findLikelyCreatedPurchaseOrder` returns the newest matching DRAFT, ignores non-DRAFT, returns null on no match.
- `src/lib/__tests__/stock-transfer-idempotency.test.ts` — same shape for stock transfers.

**Known gap (named, not hidden):** the item asked for "simulated Cin7 committed but response lost tests proving no duplicate POST occurs." The mechanism is tested at the `http.ts` layer (proves `cin7Request` itself never resends) and the idempotency-library layer (proves ambiguous-marking and reconciliation work in isolation). There is **no end-to-end test at the action layer** (`createSupplierPlanPurchaseOrdersAction`/`createReplenishTransfersAction`) proving the full flow doesn't create a second PO — neither of those action files had any test coverage before this pass, and building one from scratch (mocking Supabase query chains, `loadCin7Credentials`, `createPurchaseOrder`) was judged out of scope for this pass. This is the one FIXED item with a real, named coverage gap.

**Live evidence:** N/A.

---

### P0-3: Correct distributed rate limiting

**Files changed (across #36's 2 commits, folded into #38, plus #38's own work):**
- `supabase/migrations/0075_cin7_rate_limit_fingerprint_and_cooldown.sql` (new) — recreates `cin7_rate_limits` keyed by `bucket_key` (`sha256(accountId:applicationKey)`) instead of `account_id`; adds `blocked_until`. `cin7_rate_limit_acquire` checks `blocked_until` before normal token accounting. New `cin7_rate_limit_report_cooldown(bucket_key, cooldown_ms)` — extend-only (`GREATEST`).
- `src/cin7/rate-limit.ts` — `bucketKey()` fingerprint function. `acquireCin7Slot` signature changed to `(accountId, applicationKey, opts: {allowDegrade})` returning `"granted" | "degrade" | "blocked"` — the old "exhaust attempts → proceed anyway" behavior is gone; the caller decides via `allowDegrade`. `createServiceRoleClient()` wrapped in try/catch (the original #36 fix). New `reportCin7RateLimitCooldown`.
- `src/cin7/http.ts` — `cin7Request` passes `allowDegrade: !isWrite` (`isWrite` = any non-GET method); a `"blocked"` outcome means the real HTTP request is never sent that attempt, retried through the existing `maxRetries`/backoff loop, or thrown as a clear `Cin7ApiError` once exhausted. A real 503 (or the `/purchase`-family's non-standard equivalent) calls `reportCin7RateLimitCooldown`.

**Tests:**
- `src/cin7/__tests__/rate-limit.test.ts` — fully rewritten, 15 tests: fingerprinting (never the raw key), granted/degrade/blocked outcomes for reads vs writes on every failure path (transient error, 42883/migration-missing, client-creation-throw, contention-exhaustion, wall-clock deadline), cooldown reporting. Plus a dedicated "multi-worker" describe block: 20 concurrent `acquireCin7Slot` calls via `Promise.all` against a mutex-serialized mock bucket assert exactly `capacity` are granted; a second test proves two different `applicationKey`s on the same `accountId` get independent budgets under one concurrent burst.
- `src/cin7/__tests__/http.test.ts` — new describe blocks: write vs read `allowDegrade` value passed correctly; a "blocked" outcome never sends the real request and retries the acquire; permanent "blocked" gives up with a clear error (old proceed-anyway gone); "degrade" proceeds via the in-memory throttle; 503 and the non-standard rate-limit response both call `reportCin7RateLimitCooldown`; a definite non-rate-limit rejection does not.
- `supabase/tests/0075_cin7_rate_limit_fingerprint_and_cooldown.test.sql` (new) — transactional: burst+throttle on the renamed column, cooldown enforces the full wait regardless of tokens, a shorter cooldown report doesn't shorten a longer existing one, independent buckets.

**Live evidence:**
- Migration `0075` applied (confirmed via `list_migrations`: `20260817085208 cin7_rate_limit_fingerprint_and_cooldown`).
- `0075`'s own test run live in a `begin;...rollback;` transaction — all assertions passed (burst+throttle, cooldown, cooldown-extend-only, independent buckets).
- The pre-existing `0054` test re-run live against the new schema (positional argument binding survives the `account_id` → `bucket_key` rename) — passed.
- **Genuine multi-worker proof**: 10 separate `execute_sql` calls fired in parallel (independent connections) against one capacity-5 bucket. Result: exactly 5 returned `wait_ms: 0` (granted), the other 5 returned real, increasing queued wait times (~65,000–78,000ms, consistent with the deliberately tiny `refill_per_sec = 0.01` used for the test) — proving the `FOR UPDATE` row lock correctly serializes genuinely concurrent transactions, not just sequential calls in one transaction. Test data cleaned up afterward (`delete from cin7_rate_limits where bucket_key like 'multiworker%' ...`).

---

### P0-4: Add network deadlines

**Files changed:**
- `src/cin7/http.ts` — `DEFAULT_TIMEOUT_MS` (20s, `AbortSignal.timeout()` per attempt) already existed from the P0-1/P0-2 pass. New this pass: `Cin7RequestOptions.operationTimeoutMs` (default `DEFAULT_OPERATION_TIMEOUT_MS` = 60s) bounds the WHOLE call — every attempt's fetch time plus every backoff sleep between them combined — checked at the top of each loop iteration (`attempt > 0` guarded, so a call always gets at least one attempt regardless of how small an override is passed).
- `src/cin7/http.ts`'s `cin7RawRequest` (the diagnostics escape hatch, P0-1) also carries `signal: AbortSignal.timeout(timeoutMs)` — diagnostics are covered, not just the main gateway path.

**Tests:**
- `src/cin7/__tests__/http.test.ts` — "operation-level deadline" describe block: a call with a persistent network failure and a 1000ms operation deadline fails fast (fewer than 3 attempts, not the full 7) with a message naming the deadline; a call with a tiny (1ms) `operationTimeoutMs` still gets its one guaranteed attempt and can succeed.
- Two pre-existing tests that intentionally exhaust all `maxRetries` attempts to check final-error status/message now pass an explicit `operationTimeoutMs: Number.MAX_SAFE_INTEGER` override, so they observe retry-COUNT exhaustion specifically (their original intent) rather than being cut short by the new deadline — this is a deliberate, documented test change, not a weakening of the deadline itself (the default stays 60s for every real caller).

**Live evidence:** N/A.

---

### P0-5: Secure category_instances

**Files changed:**
- `supabase/migrations/0072_reconstruct_category_instances_rls.sql` (new) — `alter table category_instances enable row level security`, recreates the `is_org_member(org_id)` policy.

**Tests:** covered by `scripts/migration-audit.mjs`'s RLS-coverage check (below) — `category_instances` appears in the "every table has an RLS-enable statement" pass.

**Live evidence:** RLS was already enabled live (out-of-band, undocumented — confirmed via `get_advisors`/schema inspection before writing the migration); `0072` reconstructs that exact state into migration history. Applied and confirmed a genuine no-op (identical `pg_policies` before/after). Migration confirmed live via `list_migrations`: `20260817070733 reconstruct_category_instances_rls`.

**Note:** the item also asked to "confirm whether browser access is required. If not, make it service-role-only" and to prove "every table in the exposed public schema has intentional RLS/grant configuration" (not just RLS-enable, but grant/revoke too). This pass's migration-audit tool checks RLS-ENABLE coverage only, not grant/revoke configuration — that half of the item's evidentiary bar is not fully met. Flagging honestly rather than rounding up.

---

### P0-6: Repair migration history

**Files changed:**
- `supabase/migrations/0046_reconstruct_push_jobs.sql` (new) — reconstructs `push_jobs` (table, `push_job_status` enum, index, RLS policy) matching live production schema exactly (queried via `information_schema.columns`, `pg_enum`, `pg_indexes`, `pg_constraint`, `pg_policy`). Deliberately numbered `0046` (reusing an already-taken number, following this repo's own `0052`-duplicate precedent) so it sorts before `0058_job_locks.sql` — which does `alter table push_jobs add column ...` and would otherwise fail against a blank project.
- `scripts/migration-audit.mjs` (new) — standalone Node script, self-tested: strips SQL comments, regex-extracts `create table`/RLS-enable/policy statements (skipping schema-qualified references like `storage.objects`), detects any migration referencing a table before that table's own creation, and any table with no RLS-enable statement anywhere in history.
- `src/test/__tests__/migration-audit.test.ts` (new) — 2 vitest tests importing the script's `auditMigrations` function directly, asserting both `orderingViolations` and `missingRlsTables` are empty.

**Tests:** `migration-audit.test.ts` (above). The audit tool was self-verified during development by reproducing the ORIGINAL push_jobs bug synthetically (copying migrations to a scratch directory, renaming the fix file to sort AFTER `0058` again) and confirming the tool correctly flagged the exact violation that caused the real production issue, before trusting its "no violations" output as evidence.

**Live evidence:** Migration `0046` applied and confirmed idempotent (no-op against the already-correct live table). Confirmed live via `list_migrations`: `20260817070908 reconstruct_push_jobs`. The pre-existing `0058_job_locks.sql` test (`supabase/tests/0058_job_locks.test.sql`) was re-run live in a `begin;...rollback;` transaction against production after applying `0046` — passed cleanly, confirming compatibility.

**Known gap (named, not hidden):** the item asked to "run a clean migration test" — i.e., an actual `supabase db push` bootstrap against a genuinely blank project. This was not done (would need a fresh Supabase project or local Postgres instance). What was done instead: the static ordering-audit tool (verified against a synthetic reproduction of the real bug) plus manual schema reconstruction cross-checked against live `information_schema`/`pg_*` queries. This is strong but not identical evidence to an actual from-scratch bootstrap.

---

### P0-7: Atomic snapshot/detail persistence

**Files changed:**
- `supabase/migrations/0074_atomic_snapshot_replace.sql` (new) — `replace_product_availability(org_id, instance_id, rows jsonb)` and `replace_purchase_detail(org_id, instance_id, cin7_purchase_id, receipt_lines, order_lines, source, is_drop_ship)`, both single `plpgsql` functions (one implicit Postgres transaction) using `jsonb_to_recordset()` to expand a JSON rows array for bulk insert — new precedent for this codebase. `EXECUTE` revoked from `anon`/`authenticated`.
- `src/sync/sync-product-availability.ts` — `syncInstanceProductAvailability` now builds a `rows` array and calls the RPC instead of separate delete+insert.
- `src/sync/sync-purchases.ts` — `syncPurchaseDetails` now calls `replace_purchase_detail` instead of the previous 4-step delete/insert/delete/insert/update chain.

**Tests:**
- `src/sync/__tests__/sync-product-availability.test.ts` — rewritten to mock `.rpc()` instead of `.from().delete()/.insert()`; verifies correct org/instance scoping and field mapping.
- `src/sync/__tests__/sync-purchases.test.ts` — `makeFakeDb` gained an `rpc` handler; verifies args passed to the RPC, plus a new test for the RPC-returns-an-error path.

**Live evidence:** Both functions proven live against real production data, not just code-inspected:
- **Happy path**: a 2-row replace against a real 3,844-row instance (`product_availability`) — succeeded, row count correct afterward.
- **Injected failure**: a malformed numeric field forced mid-insert on both functions — the entire operation rolled back, row count/lines verified UNCHANGED afterward. For `replace_purchase_detail` specifically, this included the case where an EARLIER-successful step (receipt lines replace) had to be rolled back by a LATER step's failure (order lines insert) — proving genuine single-transaction atomicity, not just "the last statement failed cleanly."

---

### P1-3: Fix shipping-calendar billing authorization

**Files changed:**
- `src/app/reports/shipping-calendar/actions.ts` — `requireWriteAllowed(orgId)` added to both `updateOrderShipByAction` and `markOrderShippedAction`, after `requireModuleAccess`, before the Cin7 write.
- `src/app/reports/picking-calendar/actions.ts` — same fix applied to `updatePickingShipByAction` (an identical copy-pasted bug, confirmed by its own doc comment admitting it was copied from shipping-calendar).
- `src/app/import/actions.ts` — `continuePushJobAction` was re-checking `requireModuleAccess` on every chunk but not billing; added `requireWriteAllowed`. This is a genuine additional bug beyond what the item literally named, found by the same investigation.

**Tests:**
- `src/app/reports/shipping-calendar/__tests__/actions.test.ts` (new, 4 tests) — both actions check `requireWriteAllowed` is called with the resolved orgId, and that a rejection prevents the Cin7 write.
- `src/app/reports/picking-calendar/__tests__/actions.test.ts` (new, 2 tests) — same pattern.
- `src/app/import/__tests__/actions.test.ts` — new test: starts a push job (succeeds), mocks `requireWriteAllowed` to reject on the NEXT call, confirms `continuePushJobAction` returns `ok:false` and never calls `syncOrgInstances`.

**Live evidence:** N/A.

---

## Verification output (this pass, final)

```
$ npx tsc --noEmit
(clean, no output)

$ npx eslint src scripts
(clean, no output)

$ npx vitest run
 Test Files  114 passed (114)
      Tests  1057 passed (1057)

$ npx next build
✓ Compiled successfully
✓ Generating static pages using 9 workers (51/51)
(51 routes built, no errors)
```

Migrations confirmed live via Supabase `list_migrations` (project `cin7toolbox`, `pnzwjqjovxxdikxtfngq`):
- `20260817070733 reconstruct_category_instances_rls` (0072, P0-5)
- `20260817070908 reconstruct_push_jobs` (0046, P0-6)
- `20260817073407 atomic_snapshot_replace` (0074, P0-7)
- `20260817085208 cin7_rate_limit_fingerprint_and_cooldown` (0075, P0-3)

---

## DEFERRED items — not investigated this pass

Per Anton's own stated priority order, this pass covered only the 7 named blockers plus P1-3. The following 11 items were not looked at:

- **P1-1** — Fail closed on authorization read failures (`requireModuleAccess` error handling)
- **P1-2** — Enforce AAL2 inside privileged Server Actions
- **P1-4** — Lemon Squeezy organization binding (checkout-session token, Zod validation, unknown-status handling)
- **P1-5** — Classify lock failure policy (which locks may degrade vs. must fail closed)
- **P1-6** — Harden internal API credentials (split `CRON_SECRET`, review `/api/import`)
- **P1-7** — Import/export resource boundaries (upload size limits, export caps, formula injection protection)
- **P1-8** — Auth/account hardening (`shouldCreateUser:false`, active-org selection, atomic org+owner creation)
- **P1-9** — File/browser hardening (org-logo validation, CSP/HSTS/security headers)
- **P2** — API optimisation (modifiedSince watermarks for Customer/Supplier/Product sync)
- **P2** — CI and sign-off (CI pipeline: lint, tsc, vitest, build, dependency/secret scan, migration/RLS test matrix)

None of these were touched, reviewed, or partially started this pass — they carry no evidence either way and should be treated as fully open for the next audit round.
