# Cin7 Core Feeder — Security Re-Audit Remediation Report

**Date:** 2026-08-17 (round 1), updated 2026-08-17 (round 2), updated 2026-08-17 (round 3), updated 2026-08-18 (P1-7), updated 2026-08-18 (round 4 — final closure)
**Scope:** All 18 items from the re-audit. Round 1 covered Anton's own priority order of 7 structural blockers (P0-1 through P0-7, P1-3). Round 2 covered a further 6 of the remaining 11 deferred items (P1-1, P1-4, P1-6, P1-8, P1-9, P2/CI). Round 3 was a "final sign-off" pass — not new items, but a deeper re-audit of the P0 areas already marked FIXED (looking for gaps a first pass could have missed), plus bringing the 2 remaining highest-severity deferred items (P1-2, P1-5) into scope; it also closed P2 (API optimisation) as not-currently-justified and investigated (without implementing) P1-7 plus 4 further side-findings. P1-7 was then implemented as its own follow-up pass on 2026-08-18. **All 18 original items were resolved** by P1-7. Round 4 was a dedicated closure investigation (12 parallel read-only agents, see `docs/security-final-closure-matrix.md`) covering areas beyond the original 18 — it found 7 sign-off blockers (2 newly discovered, 5 reclassifications of what round 3 had filed as lower-priority side-findings) and closed all 7, per Anton's explicit decisions. Full detail lives in the closure matrix, not re-narrated here — see the round 4 section below for a pointer.
**PRs (round 1):** [#37](https://github.com/antonhill/cin7core-feeder/pull/37) (P0-1, P0-2, P0-5, P0-6, P0-7, P1-3) → [#38](https://github.com/antonhill/cin7core-feeder/pull/38) (P0-3, P0-4, stacked on #37). Merge order: #37 then #38. [#36](https://github.com/antonhill/cin7core-feeder/pull/36) was an earlier, incomplete first pass at P0-3 — closed as superseded by #38.
**PR (round 2):** [#40](https://github.com/antonhill/cin7core-feeder/pull/40) (P1-1, P1-4, P1-6, P1-8, P1-9, P2/CI) — merged `70edefe` on 2026-08-17.
**PR (round 3):** [#55](https://github.com/antonhill/cin7core-feeder/pull/55) (P1-2, P1-5, plus gap-closures on P0-2/P0-3/P0-4/P0-5) — merged `9d4cfb4` on 2026-08-17.
**PR (P1-7):** [#56](https://github.com/antonhill/cin7core-feeder/pull/56) (import/export resource boundaries) — merged `5cdf6ea` on 2026-08-18.
**PR (round 4 — final closure):** [#57](https://github.com/antonhill/cin7core-feeder/pull/57) (7 sign-off blockers — see `docs/security-final-closure-matrix.md`) — open, not yet merged.

## A note on process

P0-3's first pass ([#36](https://github.com/antonhill/cin7core-feeder/pull/36)) was scoped from a paraphrased summary of the item ("correct distributed rate limiting"), not its full text, and shipped covering 2 of the 7 things the item actually specified. This was caught before the final report was written by going back to the original message text and checking every FIXED item's evidence line-by-line against the literal wording — the same discipline "do not claim completion from code inspection alone" asks for, applied to my own prior work, not just the codebase. The gap is closed in #38. Flagging this here rather than quietly folding it in, since it's relevant to how much to trust the FIXED classifications below: each one below was re-checked against the item's literal text, not the paraphrase.

**Round 2's own process note:** learning from the P0-3 mistake above, round 2 started with 10 parallel read-only investigation agents establishing ground truth against each deferred item's literal spec text before any grouping or scoping decision was made, rather than working from a paraphrase. Building the new CI job (P2) then surfaced two real bugs neither code inspection nor isolated live checks had caught — a test-assertion methodology gap in the `0052` RLS regression test, and a stale fixture in the pre-existing `0063` box-label test left behind by a prior round's migration — both detailed under P2 below. Both are further evidence for why this report insists on live/CI verification over code inspection: the bugs were in the *tests*, not the application code, and only running everything end-to-end for the first time found them.

**Round 3's own process note:** Anton's round-3 brief was explicit that this was "not another full remediation pass" — a targeted re-audit of the P0 areas already marked FIXED, checking whether the *complete* affected surface was actually covered the first time, not just one implementation path. It started the same way round 2 did: 12 parallel read-only investigation agents established ground truth against each of the brief's 12 numbered items before any implementation began. Every single P0 area re-examined (non-idempotent creates, quota coordination, operation deadline, RLS policy intent) turned out to have a real, concrete gap — none were "already fully correct." The most severe: the RLS policy-intent audit (item 5) found a **live, directly-exploitable** DB-level bypass on 4 admin-only settings tables, unrelated to anything round 1's P0-5 fix touched. This is the strongest evidence yet in this report's own recurring theme — a single fix, however well-tested in isolation, doesn't prove the *complete* affected surface was covered; only a fresh, literal-text re-audit against the full class of the problem does.

---

## Classification summary

| Item | Classification | One-line summary |
|---|---|---|
| P0-1 | **FIXED** | Every Cin7 credential path canonicalized; one gateway; repo test enforces it |
| P0-2 | **FIXED**, gap closed round 3 | No auto-resend on ambiguous create failures; round 3 found 6 more unprotected creates beyond the original 2 |
| P0-3 | **FIXED**, gap closed round 3 | Fingerprinted bucket key, no bypass-on-contention; round 3 closed an unaccounted-quota blind spot for reads |
| P0-4 | **FIXED**, gap closed round 3 | Per-attempt AND whole-call deadlines; round 3 made every blocking sub-operation clamp to the REMAINING budget |
| P0-5 | **FIXED**, gap closed round 3 | `category_instances` RLS fixed round 1; round 3 found and fixed a live, exploitable bypass on 7 OTHER tables |
| P0-6 | **FIXED** | `push_jobs` reconstructed; self-tested migration-order audit tool added |
| P0-7 | **FIXED** | Atomic snapshot-replace RPCs for ProductAvailability and purchase detail |
| P1-1 | **FIXED** (round 2) | `requireModuleAccess` now fails closed on any of its 3 Supabase read errors |
| P1-2 | **FIXED** (round 3) | Real action-level AAL2 enforcement (`requirePrivilegedOrgAdmin`/`requirePrivilegedSuperAdmin`) across 13 privileged Server Actions; middleware's own active-org resolution bug fixed alongside it |
| P1-3 | **FIXED** (round 1) | `requireWriteAllowed` added to 3 real write paths missing it |
| P1-4 | **FIXED** (round 2) | Lemon Squeezy webhook: checkout-token binding, two-stage Zod validation, unknown-status left untouched instead of defaulting to canceled |
| P1-5 | **FIXED** (round 3, Anton-approved 2026-08-17) | PO claim / Stock Transfer claim / sync_locks flipped to fail-closed per the approved decision table; 2 other lock families deliberately left fail-open |
| P1-6 | **FIXED** (round 2) | Single `CRON_SECRET` (timing-safe compare), unsafe `/api/import` route removed entirely |
| P1-7 | **FIXED** (2026-08-18) | Shared import limits (10MB / 50k rows / 200 columns / 10k-char fields) + binary-file sniffing; the one genuinely-unbounded export (Order Fulfillment) capped at 25k rows; XLSX exports gained the same row/cell-length caps; formula-injection protection added to the one human-facing CSV export |
| P1-8 | **FIXED** (round 2) | `shouldCreateUser:false`, atomic self-serve org+owner RPC, explicit active-org selection/switcher |
| P1-9 | **FIXED** (round 2) | Magic-byte org-logo content sniffing (SVG removed), all 6 security headers added |
| P2 (API optimisation) | **NOT CURRENTLY JUSTIFIED** (round 3) | Investigated: Customer/Supplier/Product are never full-scanned by the recurring cron at all — nothing to optimise today |
| P2 (CI and sign-off) | **FIXED** (round 2) | Full CI pipeline: lint/tsc/vitest/build, dependency audit, secret scan, clean-bootstrap migration + RLS/security test matrix |

All 18 original items are now resolved: 16 FIXED, plus P2/API optimisation investigated and closed as NOT CURRENTLY JUSTIFIED (see its own section below for why implementing it would be complexity without a measurable benefit today). 4 further findings surfaced during round 3's investigation phase — outside the original 18 — remain open; see "Also investigated in round 3, not yet implemented" below.

---

## FIXED items — detail (round 1)

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
  **Correction (round 2, 2026-08-17):** the `0052`-duplicate "precedent" cited above was never actually valid evidence — it was only ever exercised through the Supabase MCP `apply_migration` path (which assigns its own timestamp-based version against the hosted project, ignoring the local filename), never through a real local-CLI bootstrap. The first-ever CI run of `supabase db reset` against this migration history failed on exactly this: the CLI tracks migration identity by the numeric filename prefix alone, so two files sharing `0046` collide. Both this file and the pre-existing `0052` duplicate were renamed to unique 5-digit prefixes (`00461_reconstruct_push_jobs.sql`, `00521_reorder_report_net_on_order.sql`) that preserve the required relative ordering — see `docs/PROJECT-NOTES.md`'s "Security re-audit round 2" entry for the full story.
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

## Verification output (round 1, final)

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

## FIXED items — detail (round 2)

Round 2's investigation phase used 10 parallel read-only agents to re-establish ground truth against each deferred item's literal spec text before any scoping decision, then Anton picked 6 of the resulting 11 candidates for this pass ("the straightforward six" + P1-4/Lemon Squeezy).

### P1-1: Fail closed on authorization read failures

**Files changed:**
- `src/lib/authorization.ts` — `requireModuleAccess` previously destructured only `data` from all 3 Supabase reads (`super_admins`, `org_members`, `organizations`); a query `error` (e.g. an RLS misconfiguration, a dropped connection) was silently ignored and `data` being `null`/empty fell through as "not found" rather than "couldn't verify" — a fail-open path for any read that errored rather than returned zero rows. Now captures and throws on `error` from all 3 reads.

**Tests:**
- `src/lib/__tests__/authorization.test.ts` — `makeDb` helper extended with an `errorOnTable` option; 4 new tests confirming denial when `super_admins`, `org_members`, or `organizations` reads error, plus a test confirming a super-admin is unaffected by an `org_members` error (that query is skipped entirely for them, so it can't fail closed on something it never runs).

**Live evidence:** N/A (pure application-code fix, no schema change).

---

### P1-4: Lemon Squeezy organization binding and webhook validation

**Files changed:**
- `supabase/migrations/0077_billing_checkout_tokens.sql` (new) — `billing_checkout_tokens(token text primary key, org_id uuid references organizations(id) on delete cascade, created_at)`. RLS enabled, no policies (service-role only). Rows never expire — Lemon Squeezy echoes the same `custom_data` for a subscription's entire lifecycle, not just at checkout.
- `src/lib/lemonsqueezy.ts` — new `createCheckoutToken(db, orgId)` (random 32-byte hex token, inserted into the new table). `buildCheckoutUrl` now puts `checkout[custom][token]` instead of the previous `checkout[custom][org_id]` — the webhook no longer trusts a client-round-tripped org id directly. `mapSubscriptionStatus` now returns `"active" | "past_due" | "canceled" | null` — `cancelled`/`expired`/`paused` explicitly map to `"canceled"`; anything unrecognized now returns `null` instead of silently defaulting to `"canceled"` (the previous behavior would have wrongly canceled a subscription on any Lemon Squeezy status this codebase hadn't anticipated).
- `src/actions/billing.ts` — `getCheckoutUrlAction` calls `createCheckoutToken` then passes the token, not the raw org id, to `buildCheckoutUrl`.
- `src/app/api/webhooks/lemonsqueezy/route.ts` — rewritten: a loose Zod `basePayloadSchema` (event type + `custom_data.token`, `.passthrough()` on the variable-shaped `data` field) is validated first and used to look up `org_id` from `billing_checkout_tokens` (400 on an unrecognized token); only for subscription-typed events is the stricter `subscriptionAttributesSchema` then validated against `data.attributes`. The `organizations` update only includes `subscription_status` when `mapSubscriptionStatus` returns non-null — an unrecognized status is logged and the stored status is left untouched rather than corrupted. Stale-event protection (the existing `subscription_event_at` WHERE-clause guard) is unchanged.

**Tests:**
- `src/lib/__tests__/lemonsqueezy.test.ts` — updated `buildCheckoutUrl` tests for the token param; 3 new `createCheckoutToken` tests; a new test confirming `mapSubscriptionStatus` returns `null` for an unrecognized string.
- `src/actions/__tests__/billing.test.ts` — asserts `createCheckoutToken` is called with the resolved `orgId` and that `buildCheckoutUrl` receives the token, not the raw org id.
- `src/app/api/webhooks/lemonsqueezy/__tests__/route.test.ts` (new, 13 tests) — signature rejection, invalid JSON, Zod schema rejection, non-subscription events skip the token lookup entirely, missing/unrecognized token, org resolution, ignored payment/invoice events, malformed subscription attributes, unrecognized-status leaves the stored field untouched, stale-event skip, 500s on token-lookup/update errors.

**Live evidence:** Migration `0077` applied and schema confirmed via `information_schema.columns`.

---

### P1-6: Harden internal API credentials

**Files changed:**
- `src/lib/internal-auth.ts` — rewritten to check only `process.env.CRON_SECRET` (the second secret, `SYNC_SHARED_SECRET`, is dropped entirely — one credential to rotate, not two that could silently drift). Uses `crypto.timingSafeEqual` with an explicit length check first (it throws on unequal-length buffers, matching the pattern already established in `lemonsqueezy.ts`'s webhook signature check).
- `src/app/api/import/route.ts` — **deleted entirely.** Zero real callers (superseded by `importCsvAction`), and it was strictly more dangerous than the routes it duplicated — it trusted an `orgId` supplied in the request body rather than deriving it from an authenticated session.
- `src/middleware.ts` — `api/import` removed from the matcher's exclusion list; comment updated.
- `.env.example` — `SYNC_SHARED_SECRET` removed; `CRON_SECRET`'s comment updated to reflect it's the only internal secret.
- `src/app/api/sync/route.ts` — comment referencing the old two-secret setup updated.

**Tests:**
- `src/lib/__tests__/internal-auth.test.ts` (new, 6 tests) — correct token, wrong token, missing token, empty token, unset `CRON_SECRET`, and a length-mismatch case (proving the explicit length check is exercised, not just relying on `timingSafeEqual` throwing uncaught).

**Live evidence:** N/A (pure application-code change).

**Named, deferred follow-up (flagged, not fixed here):** 6 sibling `/api/sync*` POST handlers share the same "org id trusted from the request body" shape as the deleted `/api/import` route. Fixing them was judged out of scope for this item's literal wording ("review `/api/import`") and would have meant scope creep beyond what was asked. Flagged via a spawned background task (`task_3213ee9b`, "Scope on-demand /api/sync* POST endpoints to caller's own org") rather than silently left for someone to rediscover — Anton has since started that task independently.

---

### P1-8: Auth/account hardening

**Files changed:**
- `src/app/login/page.tsx` — `signInWithOtp({ email })` → `signInWithOtp({ email, options: { shouldCreateUser: false } })`. Previously, requesting a magic link for any email address — including one with no account — would silently create a new user.
- `supabase/migrations/0076_atomic_self_serve_org.sql` (new) — `create_self_serve_org(p_org_name, p_user_id) returns uuid`, one `plpgsql` function wrapping both the `organizations` insert and the `org_members` owner-insert in a single transaction. Previously these were two separate client-side inserts — a failure between them could leave an orphaned organization with no owner.
- `src/app/signup/actions.ts` — `createSelfServeOrgAction` now calls the new RPC instead of two separate inserts.
- `src/lib/active-org.ts` (new) — `ACTIVE_ORG_COOKIE`; pure function `resolveActiveOrgId(cookieOrgId, membershipOrgIds)` (cookie wins if it names a real membership, else the first membership, else `null`) — one shared rule instead of the previous implicit "whichever org the query happened to return first."
- `src/actions/active-org.ts` (new) — `listMyOrgsAction` (caller's own real memberships only) and `setActiveOrgAction(orgId)` (verifies real membership server-side before trusting the client-supplied org id).
- `src/lib/current-org.ts` — `requireCurrentOrg` now fetches ALL memberships (was `.limit(1)`) and resolves via the shared rule.
- `src/actions/auth.ts` — `getCurrentUserInfo` mirrors the identical resolution logic so it can never disagree with `requireCurrentOrg`; adds `hasMultipleOrgs: boolean`.
- `src/app/ActiveOrgSwitcher.tsx` (new) — UI for a non-super-admin user with more than one org membership to explicitly choose their active org, mirroring the existing super-admin `OrgSwitcher.tsx`.
- `src/app/AppNav.tsx`, `src/app/layout.tsx` — wire `hasMultipleOrgs` through; render `ActiveOrgSwitcher` (non-super-admin, multi-org) or `OrgSwitcher` (super-admin) conditionally.

**Tests:**
- `src/lib/__tests__/active-org.test.ts` (new, 5 tests) — `resolveActiveOrgId`'s pure logic.
- `src/actions/__tests__/active-org.test.ts` (new, 7 tests) — `listMyOrgsAction`/`setActiveOrgAction`, including rejecting a non-membership org id.
- `src/lib/__tests__/current-org.test.ts` (new, 8 tests) — multi-org cookie resolution, super-admin impersonation bypass unaffected.

**Live evidence:** `0076` applied; proven live via `begin;...rollback;` — happy path (real `auth.users` id) AND a deliberate failure injection (a bogus `user_id` violating the FK) confirming the `organizations` insert rolls back too, not just the failed `org_members` insert. Permanent regression test: `supabase/tests/0076_atomic_self_serve_org.test.sql` (skips gracefully if no `auth.users` row exists in the test environment).

---

### P1-9: File/browser hardening

**Files changed:**
- `src/lib/image-sniff.ts` (new) — `sniffImageType(bytes)`: magic-byte checks for PNG (`89 50 4E 47 0D 0A 1A 0A`), JPEG (`FF D8 FF`), WebP (`RIFF....WEBP`). The browser-supplied `File.type` is trivially spoofable and was previously trusted directly.
- `src/actions/org-logo.ts` — `uploadCurrentOrgLogo` now requires `requireOrgAdmin` (was `requireCurrentOrg` — any member could change the org logo). `ALLOWED_LOGO_MIME_TYPES` is now `png/jpeg/webp` only (SVG removed — an SVG can carry embedded `<script>`, a stored-XSS risk once served back to other users; the item's own wording allowed "remove or sanitize," and removal was chosen over adding a sanitizer dependency for one logo format). The actual uploaded bytes are sniffed, and the sniffed type — not the browser's claimed `file.type` — drives the stored extension/content-type, so a mislabeled file gets corrected rather than trusted.
- `src/app/admin/actions.ts` — `uploadOrgLogo` (super-admin path) gets the identical sniff-based fix.
- `src/app/AppNav.tsx`, `src/app/admin/page.tsx` — `image/svg+xml` removed from both logo-upload file inputs' `accept` attribute.
- `next.config.ts` — new `headers()` function adding all 6 named security headers: CSP (`script-src 'self' 'unsafe-inline'` — the `'unsafe-inline'` is needed for Next.js App Router's inline RSC-streaming `<script>` tags; a per-request nonce would remove it but needs middleware wiring, noted as further hardening rather than attempted here), HSTS (`max-age=63072000; includeSubDomains; preload`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera/mic/geolocation/payment/usb disabled). CSP's `img-src`/`connect-src` allowlist the Supabase project origin specifically.

**Tests:**
- `src/lib/__tests__/image-sniff.test.ts` (new, 7 tests).
- `src/actions/__tests__/org-logo.test.ts` (new, 7 tests) — admin-gate enforcement, content-sniff rejection, mislabeled-file correction.

**Live evidence:** Built + ran the production server locally (port 3457), curl'd the headers to confirm all 6 present, then loaded `/` and `/login` in a real browser: zero console errors (no CSP violations), and typed into the login email field to confirm hydration/interactivity genuinely survives the new CSP rather than just checking the header exists.

---

### P2: CI pipeline and sign-off

**Files changed:**
- `.github/workflows/ci.yml` (new — no `.github/` directory existed anywhere in this repo's history before this). 4 jobs:
  - `build-and-test` — `npm ci`, `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build`.
  - `dependency-audit` — `npm audit --audit-level=high`.
  - `secret-scan` — `gitleaks/gitleaks-action@v2`.
  - `migration-and-security-tests` — `supabase init --force` + `supabase start` + `supabase db reset --local` (replays every migration from `0001` onward against a brand-new local Postgres + Supabase Auth stack — the actual automated regression test for the exact class of bug P0-6, round 1, fixed), then runs every `supabase/tests/*.test.sql` file via `psql` against the fresh local database.
- `.github/dependabot.yml` (new) — weekly npm + GitHub Actions update schedule.
- `package-lock.json` — `npm audit fix` applied; fixed 2 pre-existing high-severity transitive vulnerabilities (`brace-expansion`, `js-yaml`) that would otherwise have failed the new `dependency-audit` job on its first run. A moderate `uuid`/`exceljs` finding was left alone (below the `--audit-level=high` threshold; fixing it needs a breaking `exceljs` downgrade).
- `supabase/migrations/0046_reconstruct_push_jobs.sql` → renamed `00461_reconstruct_push_jobs.sql`, and the pre-existing `0052_reorder_report_net_on_order.sql` → renamed `00521_reorder_report_net_on_order.sql` — see the P0-6 correction note above.
- `supabase/tests/0052_org_admin_rls.test.sql` — fixed a test-methodology bug (see below).
- `supabase/tests/0063_box_label_queue.test.sql` — fixed an unrelated stale-fixture bug (see below).

**Could not run the Supabase-CLI-based job locally (no Docker in this environment).** The only way to validate it was to push real commits to the open PR and iterate against actual GitHub Actions runs — 6 real failures were diagnosed and fixed in sequence before the job went green:

1. `supabase db reset` failed: `duplicate key value violates unique constraint "schema_migrations_pkey" — Key (version)=(0046) already exists"`. The local CLI tracks migration identity by the leading numeric filename prefix only, not the full filename — `0046_reconstruct_push_jobs.sql` collided with the pre-existing `0046_production_tracking_tags_and_output.sql`. Fixed by renaming both `0046`-prefixed and both `0052`-prefixed files to unique 5-digit prefixes that preserve required ordering (CLI accepts any-length leading digit runs).
2. `supabase db execute --file` doesn't exist in the pinned CLI version — fixed to `supabase db query --file` per the CLI's own error hint.
3. `db query --file` only accepts a single SQL statement (prepared-statement execution); every `supabase/tests/*.test.sql` file is multi-statement — fixed by installing `postgresql-client` and using a real `psql` connection instead.
4. FK violation: the `0052` test's synthetic user UUIDs were never inserted into `auth.users` — this had only ever been verified against production (which has real pre-existing users), never a genuinely empty fresh bootstrap. Fixed by seeding minimal `auth.users (id)` stub rows first.
5. `permission denied for table cin7_instances` — Supabase's hosted platform grants base table privileges to `authenticated`/`anon` implicitly at project creation, which is never captured in any migration (confirmed: zero migrations anywhere in this repo grant anything to `authenticated`/`anon`). A real hosted project already has these; a from-scratch local bootstrap does not. Fixed by adding explicit (redundant-on-production, necessary-locally) `grant` statements inside the test's own transaction — safe, since `GRANT`/`REVOKE` are transactional in Postgres.
6. A genuine test-assertion bug, not a live vulnerability: after the grants were added, the full `0052` test failed with `EXPECTED DENIED but succeeded: member UPDATE cin7_instances` — on its face, a plain org member successfully writing to a table holding encrypted Cin7 credentials. Investigated live with `GET DIAGNOSTICS row_count` and a re-`SELECT` of the target row rather than trusting the exception-based assertion: the "successful" UPDATE actually affected **0 rows**, value unchanged. Postgres RLS filters a row a policy's `USING` clause makes invisible *before* the UPDATE's own `WHERE` can match it — the statement "succeeds" with zero rows affected and raises no exception at all, unlike an INSERT's `WITH CHECK` failure (confirmed by contrast: the test's INSERT assertion correctly raises a real `check_violation`). The test's `expect_denied()` helper only checked for a raised exception, so it could never catch this — it would report a false PASS on a write that never happened. Fixed by adding `pg_temp.expect_no_effect(sql, label)`, asserting `row_count = 0` directly, and swapping it in for the 3 UPDATE-shaped assertions; `expect_denied` stays correct for the 1 INSERT-shaped assertion. The underlying RLS policies were never at fault — confirmed correct throughout via live `pg_policies` inspection.

**Running the full test suite end-to-end for the first time (this job's whole reason to exist) also caught a genuine bug in a pre-existing, unrelated test:** `0063_box_label_queue.test.sql` failed — migration `0071` (a prior round, unrelated to round 2) changed box-label re-qualification from a plain `printed_at is null` boolean to a quantity-snapshot comparison (`total_ready_for_box_label_qty > ready_qty_at_mark`), so a genuine later fulfilment can re-qualify an order without per-fulfilment Cin7 tracking. `0063`'s test fixture predates `0071` and never set `ready_qty_at_mark` on its `box_label_print_state` insert, so it defaulted to `0` — under the new logic, `10 > 0` reads as fresh growth and wrongly re-qualifies the order the test asserts must stay suppressed. This drift went uncaught because the test was never actually re-run end-to-end after `0071` shipped. Fixed by setting `ready_qty_at_mark = 10` in the fixture, matching what `markBoxLabelPrintedAction` (`src/actions/box-label.ts`) always snapshots for real at click time. No application code changed — purely a stale test fixture, unrelated to any of round 2's 6 scoped items.

**Tests:** the CI job itself is the test — see the final green run below.

**Live evidence:** all 4 jobs passing on the final push: [GitHub Actions run #32037753992](https://github.com/antonhill/cin7core-feeder/actions/runs/32037753992). Both live-verified fixes (`expect_no_effect`, `0063`'s `ready_qty_at_mark`) were additionally proven correct by running the full, assembled test files live against production in a `begin;...rollback;` transaction (terminated by a deliberate final `raise` to confirm every assertion passed) before pushing — not just trusted from the CI run alone.

---

## Verification output (round 2, final)

```
$ npx tsc --noEmit
(clean, no output)

$ npx eslint
(clean, no output)

$ npx vitest run
 Test Files  121 passed (121)
      Tests  1120 passed (1120)

$ npx next build
✓ Compiled successfully
(all routes built, no errors)
```

CI run (all 4 jobs green): [github.com/antonhill/cin7core-feeder/actions/runs/32037753992](https://github.com/antonhill/cin7core-feeder/actions/runs/32037753992)
- `Install, lint, typecheck, test, build`: success
- `Dependency vulnerability scan`: success
- `Secret scan`: success
- `Clean migration bootstrap + RLS/security test matrix`: success

Migrations confirmed live via Supabase `list_migrations` (project `cin7toolbox`, `pnzwjqjovxxdikxtfngq`):
- `20260817100323 atomic_self_serve_org` (0076, P1-8)
- `20260817122803 billing_checkout_tokens` (0077, P1-4)

PR [#40](https://github.com/antonhill/cin7core-feeder/pull/40) merged to `main` at commit `70edefe`.

---

## FIXED items — detail (round 3)

Round 3 was framed as a final sign-off pass, not a new remediation round: re-examine every P0 area already marked FIXED for gaps a first pass could have missed, and resolve the 2 highest-severity remaining deferred items (P1-2, P1-5). 12 parallel read-only investigation agents established ground truth first; every P0 area re-examined had a real gap.

### P1-2 / active-org resolution parity (brief item 1)

**Previous status:** DEFERRED (not investigated in rounds 1-2).

**Finding:** Two related, compounding gaps. First, `middleware.ts` resolved a multi-org user's active org via an unordered `.limit(1)` `org_members` query — completely ignoring the `active_org_id` cookie that `requireCurrentOrg`/`getCurrentUserInfo` (round 2's P1-8 fix) already honored. A user who is a member of Org A but admin of Org B, with Org B active, could have middleware evaluate Org A (member → MFA-enrolment gate skipped) while every Server Action correctly resolved Org B (admin → should be gated) — middleware and Server Actions could genuinely disagree about which org's role applied. Second, no Server Action anywhere enforced AAL2 (two-factor) independently — middleware's own MFA-enrolment gate only ever protects *page navigation*; a direct POST to a privileged Server Action's own endpoint (the client bundle ships a callable reference to every action, independent of whether the user ever rendered the gating page) was never covered by it at all.

**Files changed:**
- `src/lib/active-org-resolution.ts` (new) — `ACTIVE_ORG_COOKIE`/`resolveActiveOrgId` split out of `active-org.ts` into a dependency-free module (no `next/headers` import), so Edge-runtime `middleware.ts` can share the exact same resolution rule as every Server Action without dragging in a Node-only import — mirrors the existing `IMPERSONATED_ORG_COOKIE` duplication pattern's own stated reasoning.
- `src/lib/active-org.ts` — now re-exports from the new module; `getActiveOrgCookie()` (the `next/headers`-dependent half) is unchanged, so every existing importer needed zero changes.
- `src/middleware.ts` — the `.limit(1)` query replaced with fetching every membership and resolving via `resolveActiveOrgId(cookieOrgId, membershipOrgIds)`, reading the cookie via `request.cookies.get(ACTIVE_ORG_COOKIE)` (matching the existing `IMPERSONATED_ORG_COOKIE` read pattern).
- `src/lib/require-privileged.ts` (new) — `requirePrivilegedOrgAdmin()`/`requirePrivilegedSuperAdmin()` compose the existing `requireOrgAdmin`/`requireSuperAdmin` role checks with a real `supabase.auth.mfa.getAuthenticatorAssuranceLevel()` check (`currentLevel === "aal2"`, not just "a factor is enrolled"). Deliberately mirrors middleware's own trial-org AAL2 exemption (a super-admin always needs AAL2; an ordinary org owner/admin only once their org's billing is write-allowed) — enforcing it unconditionally would have made a trial-org admin's page load fine (middleware doesn't force enrolment yet) while the Server Action that page calls on load rejected them, the exact "the two checks disagree" bug this item exists to close, just inverted.
- Applied to 13 call sites: `src/app/settings/instances/actions.ts` (`listInstances`, `upsertInstance`, `deleteInstance`), `src/actions/billing.ts` (`getCheckoutUrlAction`, `getManageSubscriptionUrlAction`), `src/app/settings/members/actions.ts` (`inviteTeamMemberAction`, `removeTeamMemberAction`, `setTeamMemberModulesAction`), `src/app/admin/actions.ts` (`createOrgAndInvite`, `inviteMemberToOrg`, `removeMemberFromOrg`, `setOrgDisabledModules`, `deleteOrganization`), `src/actions/org-switch.ts` (`setImpersonatedOrgAction`).
- Deliberately NOT upgraded (documented, not silent): `uploadOrgLogo` (branding-only, no credentials/money/access consequence), `listInstances`'s/`listTeamMembersAction`'s/`listOrgsForAdmin`'s/`listOrgsForSwitcherAction`'s read-only siblings, `loadInstanceCreds` and the ~25 diagnostic actions funnelling through it (diagnostics-authorization work, out of round 3's P0 scope — see "Also investigated in round 3, not yet implemented" below), `clearImpersonatedOrgAction` (exiting impersonation isn't gated).

**Tests:** `src/__tests__/middleware.test.ts` — rewritten for multi-membership fixtures; new describe block with the brief's own required scenarios: member-in-A/admin-in-B-with-B-active, admin-in-A/member-in-B-with-B-active, stale/invalid active-org cookie, no-cookie fallback, and module-block-uses-active-org. `src/lib/__tests__/require-privileged.test.ts` (new, 12 tests) — AAL2 pass/fail at every currentLevel/nextLevel combination, role-check-fails-before-AAL2-check ordering, AAL-read-error fails closed, the trial-org exemption itself, and confirms a super-admin is held to the bar even on a trialing org. Every downstream action-level test file (`billing.test.ts`, `org-switch.test.ts`) updated to mock the new guard.

**Live evidence:** N/A (pure application-code change, no schema).

---

### Non-idempotent Cin7 create protection — closing P0-2's gap (brief item 2)

**Previous status:** FIXED (round 1) — but only for Purchase Order and Stock Transfer creation.

**Finding:** Exhaustive inventory of every Cin7 POST call in the repo found 6 more genuine creates with zero `nonIdempotentCreate` protection: `pushCustomer`, `pushSupplier`, `pushProduct`, `createWorkCentre`, `createReference` (Category/Brand/UOM), `pushProductionBom`. Each already had an existing find-by-identifier function in the same file (SKU/Name/Code) — the gap wasn't "no reconciliation exists," it was that `cin7Request`'s own internal retry loop could blindly resend the exact same POST several times on a network failure before ever re-checking that identifier. Also found: a super-admin-only diagnostic PO-creation tool (`debug.ts`'s `testCreatePurchaseOrder`) with the same gap and, unlike the 6 production paths, no reconciliation mechanism at all.

**Files changed:** `src/cin7/customers.ts`, `suppliers.ts`, `products.ts`, `work-centres.ts`, `reference-lookups.ts`, `production-bom.ts` — `nonIdempotentCreate: true` added to each genuine create call (conditionally, for `production-bom.ts`'s combined PUT/POST). `src/cin7/debug.ts` — same flag added to `tryPurchaseRequest`/`tryPurchaseOrderLines`'s POST branches, with the residual no-reconciliation risk explicitly documented in code rather than silently accepted.

**Tests:** all 6 production files' existing test suites extended with an assertion that the create call carries `nonIdempotentCreate: true` (`customers.test.ts`, `suppliers.test.ts`, `products.test.ts`, `work-centres.test.ts`, `reference-lookups.test.ts`, `production-bom.test.ts`). No new test for the diagnostic tool — it has no pre-existing test coverage at all (a documented, pre-existing gap, same as round 1's P0-2 action-layer coverage gap).

**Live evidence:** N/A (pure application-code change).

**Reconciliation mechanism confirmed, not assumed:** verified via `run-sync.ts`'s own error handling — a thrown error from any of these 6 push functions leaves the corresponding `*_sync_state` row's `synced_hash` stale (never updated on the failure path), so the row is retried on the next sync run, going through the find-by-identifier check again before attempting to create — genuine reconciliation, not a gap papered over.

---

### Quota coordination — closing P0-3's gap (brief item 3)

**Previous status:** FIXED (round 1) — the distributed coordinator existed, but with a real accounting blind spot for reads.

**Finding:** When the distributed coordinator couldn't grant a slot, a GET request ("degrade" outcome) silently fell back to an in-memory per-invocation throttle and sent the real HTTP request anyway — completely unaccounted by the shared Postgres bucket, reopening exactly the multi-worker uncoordinated-traffic race P0-3 was built to close, just scoped to reads. Separately, `cin7RawRequest` (the P0-1 diagnostics escape hatch) had zero quota participation of any kind — not even the old local throttle. Config had no upper bound at all: `.env.example` shipped `RATE_LIMIT_RPS=1`, exactly on Cin7's 60/min ceiling rather than below it (and this repo has drifted above-limit before — see `docs/cin7-api-findings.md`).

**Files changed:** `src/cin7/http.ts` — a "degrade" outcome is now handled identically to "blocked" (never proceeds unpaced; retries the whole attempt through the existing loop). The entire now-dead local in-memory throttle machinery (`throttle`, `throttleQueueByAccount`, `lastCallAtByAccount`, `minIntervalMs`, `__resetRateLimiterForTests`) was deleted rather than left unused. `cin7RawRequest` now calls `acquireCin7Slot(..., { allowDegrade: false })` before every raw fetch, throwing a clear `Cin7ApiError` on anything but "granted." `src/cin7/rate-limit.ts` — `refillPerSec()`/`capacity()` now clamp to `MAX_RPS = 0.9` / `MAX_BURST = 10` (real headroom under the 60/min limit) and reject non-finite input (`NaN` previously passed straight through `Math.max`, since `NaN` comparisons are always false). `.env.example` — `RATE_LIMIT_RPS` fixed to `0.8`.

**Tests:** `src/cin7/__tests__/http.test.ts` — rewrote the default mock outcome from `"degrade"` to `"granted"` (matching the real common case now that degrade no longer means "proceed anyway"); new tests proving a "degrade" GET never sends the real request and retries exactly like "blocked"; new tests for `cin7RawRequest`'s quota gate (acquires with `allowDegrade:false`, throws on any non-granted outcome, no retry loop). The obsolete "per-account rate limiting" describe block (3 tests exercising the now-deleted local throttle) was removed — that behavior is covered by `rate-limit.test.ts`'s own "concurrent load (multi-worker)" suite instead. `src/cin7/__tests__/rate-limit.test.ts` — 4 new tests for the config clamps (over-limit RPS/burst clamped, non-numeric input falls back to the default, below-minimum still floors).

**Live evidence:** N/A (pure application-code change). Severity assessed honestly, not inflated: Cin7's own 503 backstop plus the shared cooldown already self-corrects a runaway period within ~10s regardless — this closes a real correctness/accounting gap, not an unbounded-quota-exhaustion vulnerability.

---

### Hard operation deadline — closing P0-4's gap (brief item 4)

**Previous status:** FIXED (round 1) — the whole-call deadline existed and was checked, but only between attempts, not during one.

**Finding:** Traced two concrete overrun timelines against the actual code: (1) a contended quota wait alone could consume up to `acquireCin7Slot`'s own fixed 20s internal budget regardless of a much smaller `operationTimeoutMs`, since nothing told it how much time the caller actually had left; (2) a fetch given the full fixed `timeoutMs` (default 20s) plus an unclamped ~5-30s backoff sleep could together blow a small deadline by seconds before the top-of-loop check ever re-fired. Neither sub-operation had ever been bounded by the *remaining* budget — only by their own fixed defaults.

**Files changed:** `src/cin7/rate-limit.ts` — `acquireCin7Slot` gained an optional `maxWaitMs` option; its own internal deadline is now `Date.now() + Math.min(MAX_TOTAL_WAIT_MS, maxWaitMs ?? MAX_TOTAL_WAIT_MS)`. `src/cin7/http.ts` — `remainingForAcquire` (floored at 1ms, so attempt 0 always gets a genuine attempt) is computed fresh before every `acquireCin7Slot` call and passed as `maxWaitMs`; `attemptTimeoutMs = Math.min(timeoutMs, remainingBudget)` computed fresh right before every fetch; a new `clampedBackoff(attempt)` helper (floored at 0, letting the existing top-of-loop check catch a fully-expired deadline on the next iteration with the correct attempt count) replaces all 4 of the function's unclamped `sleep(RETRY_BASE_DELAY_MS * ...)` call sites.

**Tests:** `src/cin7/__tests__/http.test.ts` — new tests proving the fetch's `AbortSignal.timeout` is clamped below the configured value when the operation budget is smaller (spying on `AbortSignal.timeout` directly), that `acquireCin7Slot` receives a clamped `maxWaitMs`, and that a permanently-"blocked" outcome's backoff sleep never overruns a small deadline (proven via fake-timer advancement: if unclamped, the test would still be pending after only 200ms of advancement against a 5000ms unclamped sleep). `src/cin7/__tests__/rate-limit.test.ts` — new tests confirming `maxWaitMs` genuinely shrinks the internal deadline (single-attempt give-up on a 300ms budget vs. a 5000ms-per-attempt reported wait) and that a `maxWaitMs` *larger* than the function's own default doesn't extend it.

**Live evidence:** N/A (pure application-code change).

---

### RLS policy-intent audit — closing P0-5's gap, and finding a live vulnerability beyond it (brief item 5)

**Previous status:** FIXED (round 1) — but that fix was scoped to one table (`category_instances`); the item's own literal wording ("every table... has intentional RLS/grant configuration") was never checked at that scope.

**Finding — the most severe of this round:** A live, directly-exploitable DB-level bypass. 4 admin-only settings tables (`ship_by_notification_settings`, `ship_by_notification_reps`, `bom_alert_settings`, `picking_calendar_settings`) shipped with an `is_org_member` RLS policy on their ALL (ambient read/write) clause, while every Server Action that writes them enforces `requireOrgAdmin` — meaning any ordinary org member could bypass the Server Action gate entirely with a direct PostgREST call using their own valid session token (the anon key is public by design; any logged-in member already has a legitimate access token). Each affected migration's own comment already stated the intended design ("Write access gated to org admins at the application layer") — the SQL just never matched it. Separately, 3 service-managed log/queue tables (`ship_by_change_pending`, `ship_by_change_notifications`, `bom_alert_notifications`) had a member-level read/write policy despite having no legitimate client-side reader or writer anywhere in the app at all.

**Files changed:** `supabase/migrations/0078_fix_admin_only_settings_rls.sql` (new) — drops each of the 4 tables' `is_org_member` ALL policy, recreates it with `is_org_admin` (their separate member-level SELECT policy is untouched — reads are correctly member-level); drops both policies entirely (no replacement) on the 3 log/queue tables, matching the `billing_checkout_tokens` (round 2, P1-4) precedent of RLS-enabled-zero-policies-service-only. Also `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon` — anon already gets nothing anywhere (every policy roots in `is_org_member`/`is_org_admin`, both `false` for a null `auth.uid()`), so this removes an unaudited standing capability rather than changing behavior.

**Tests:** `supabase/tests/0078_fix_admin_only_settings_rls.test.sql` (new) — seeds a throwaway org with one admin and one ordinary member, proves the member can still SELECT the 4 settings tables but every UPDATE affects 0 rows (`pg_temp.expect_no_effect`, the RLS-USING-vs-exception pattern round 2 established), proves the member has zero access (SELECT or UPDATE) to the 3 log/queue tables, and proves the admin's writes still succeed.

**Live evidence:** the fix and its test were both run live against production, wrapped in `begin;...rollback;`, *before* the migration was actually applied — confirming the exact "member blocked, admin allowed" behavior with real rows, not just planned SQL. The migration was then applied for real via `apply_migration`, and the resulting `pg_policies`/`information_schema.role_table_grants` state was independently re-queried and confirmed to match exactly what was intended (4 tables now `is_org_admin`-gated, 3 tables zero policies, 0 remaining anon grants).

**Note:** the item's other stated bar — "prove every table in the exposed public schema has intentional RLS/grant configuration" for the *entire* schema, not just the 7 tables named above — was scoped by the investigation to the specific mismatches actually found (the 7 tables), not a full table-by-table re-certification of all ~58 public tables. The investigation's permission matrix did cover every table and found these 7 as the only real mismatches (everything else — `push_jobs`, `pull_jobs`, `custom_reports`, `purchase_planner_settings`, `cin7_instances`, every Cin7-synced data table — already matched its documented intent), so the practical bar is met, but a table-by-table matrix isn't reproduced verbatim in this report; see the round-3 investigation transcript for the full matrix if needed.

---

### P1-5 — Lock failure policy: Anton-approved 2026-08-17 (brief item 6)

**Previous status:** DEFERRED, explicitly `AWAITING PRODUCT/RISK DECISION` per round 2's own scoping.

**Investigation → decision → implementation:** every lock/claim that can degrade/fail-open was inventoried and classified. 3 are genuine Category B (write-integrity) backstops — PO creation claim, Stock Transfer creation claim, and the per-instance `sync_locks` (the real duplicate-record guard for product/customer/supplier/production-BOM pushes, confirmed via the migration comments of `sync_route_locks`/`push_jobs`' own job-chunk lock, both of which explicitly defer to `sync_locks` as the actual backstop rather than being one themselves — Category A). A decision table (current fail behaviour, fail-open risk, fail-closed UX cost, recovery path, reconciliation availability, per lock) was presented to Anton via `AskUserQuestion`; he approved **"Fail-closed for all 3 (Recommended)"** on 2026-08-17.

**Files changed:** `src/lib/po-idempotency.ts` — `claimPoCreation` returns `{claimed: false, existingStatus: "guard_unavailable"}` on any guard RPC error or unexpected empty result, instead of `{claimed: true}`. `src/lib/stock-transfer-idempotency.ts` — identical shape for `claimStockTransferCreation`. `src/app/supplier-planner/actions.ts` / `src/app/replenish/actions.ts` — a new `existingStatus === "guard_unavailable"` branch surfaces a clear "Could not confirm no duplicate exists — try again shortly" error for that PO/transfer group specifically, without disrupting other groups in the same batch. `src/lib/sync-lock.ts` — `acquireSyncLock` now `throw`s on a guard error/empty result instead of returning `{acquired: true}`. `src/sync/sync-org.ts` — the `acquireSyncLock` call is now wrapped in its own try/catch, producing the identical `sync.push_failed` outcome for that ONE instance (via `mapWithConcurrency`'s per-task isolation) that any other sync failure already produces — other instances in the same batch are unaffected.

**Tests:** the 3 existing "FAILS OPEN" tests (`po-idempotency.test.ts`, `stock-transfer-idempotency.test.ts`, `sync-lock.test.ts`) rewritten to assert the new fail-closed behavior. `src/sync/__tests__/sync-org.test.ts` — new test proving a sync-lock guard error blocks only the affected instance(s) (never calls `syncInstance`, logs `sync.push_failed`) while the batch as a whole completes cleanly (no unhandled rejection escaping `mapWithConcurrency`).

**Live evidence:** N/A (pure application-code change — the guard RPCs themselves are unchanged; only the caller's response to a guard *failure* changed).

**Deliberately unchanged:** `sync_route_locks` and the `push_jobs`/`pull_jobs` job-chunk lock stay fail-open — both are Category A per their own migration comments (read/cache coordination, not write-integrity), and flipping them would trade real availability (report refreshes, import/migrate progress bars) for no actual duplicate-Cin7-write protection.

---

### P2 (API optimisation) — investigated and closed as NOT CURRENTLY JUSTIFIED (brief item 11)

**Previous status:** DEFERRED.

**Investigation:** traced exactly how Customer/Supplier/Product are fetched by the recurring cron sync — it's a changed-row *push* (local Supabase → Cin7), gated by content-hash, never a `GET`-list-scan of Cin7's own Customer/Supplier/Product endpoints. The only callers of the actual full-list-scan functions (`fetchAllCustomers`, `fetchAllSuppliers`, `fetchAllProductsWithBom`) are exactly the complete-dataset workflows the brief itself says must NOT go incremental: System Health, the Data Audit tool, Migrate, and live CSV export. There is nothing recurring to optimise. Separately confirmed: 2 of the 3 previously-probed endpoints for `UpdatedSince` semantics (Assembly Builds, Production Orders) turned out to silently ignore the filter entirely — reinforcing that this item's own required verification step (live-probe before trusting the parameter) is not optional, and Customer/Supplier/Product were never probed at all.

**Status:** `NOT CURRENTLY JUSTIFIED` — no code change. If a genuine Cin7→Supabase pull/mirror sync for these entities is ever built in the future, `probeUpdatedSinceFiltering` (`debug.ts`) should be extended to `/Product`/`/customer`/`/supplier` and run live first, exactly as this item's own brief requires, before assuming the parameter works.

---

## Verification output (round 3, final)

```
$ npx tsc --noEmit
(clean, no output)

$ npx eslint src
(clean, no output)

$ npx vitest run
 Test Files  122 passed (122)
      Tests  1152 passed (1152)

$ npm run build
✓ Compiled successfully
(all 50 routes built, no errors)
```

CI run (all 4 jobs green on the first push): PR [#55](https://github.com/antonhill/cin7core-feeder/pull/55)
- `Install, lint, typecheck, test, build`: success
- `Dependency vulnerability scan`: success
- `Secret scan`: success
- `Clean migration bootstrap + RLS/security test matrix`: success

Migration confirmed live via Supabase `list_migrations`/direct `pg_policies` re-query (project `cin7toolbox`, `pnzwjqjovxxdikxtfngq`):
- `0078_fix_admin_only_settings_rls` — 4 tables confirmed `is_org_admin`-gated, 3 tables confirmed zero policies, 0 remaining `anon` grants on any public table.

PR [#55](https://github.com/antonhill/cin7core-feeder/pull/55) merged to `main` at commit `9d4cfb4` on 2026-08-17.

---

## FIXED items — detail (P1-7, 2026-08-18)

Implemented as a dedicated follow-up pass, using round 3's own investigation (brief item 10, summarized in the now-superseded "DEFERRED items" note below) as the ready-to-implement spec: export files classified (14 Cin7-round-trip templates vs. 1 human-facing CSV export + 14 XLSX export actions), zero import size/row/column/field limits found anywhere, `fetchAllRpcRows` (used only by Order Fulfillment) identified as the one genuinely-unbounded export path — every other report function was accidentally capped by PostgREST's own ~1000-row max-rows config — and zero formula-injection protection found anywhere.

**Files changed:**
- `src/lib/csv-upload-limits.ts` (new) — the shared chokepoint every CSV import surface funnels through: `checkUploadSize` (10MB, checked before `file.text()` reads the whole upload into memory), `looksLikeText` (NUL-byte sniffing to reject a binary file uploaded with a spoofed `.csv` extension — same principle as P1-9's image-magic-byte sniffing, applied to text), `assertCsvWithinLimits` (50,000 rows / 200 columns / 10,000 characters per field, checked immediately after `Papa.parse`, before any per-row zod validation runs).
- `src/import/csv.ts` — `parseCsv` (used by Products/BOM/Suppliers/Customers/Addresses) calls `assertCsvWithinLimits` right after the `fatalErrors` check.
- `src/reports/stocktake-assistant/build.ts` — `parseStocktakeFile` wraps the same call in try/catch, converting a thrown limit error into this function's own `{rows: [], error: string}` contract rather than throwing.
- `src/app/import/actions.ts`, `src/app/stocktake-assistant/actions.ts` — both upload actions call `checkUploadSize` before reading the file and `looksLikeText` right after, before handing off to the parser.
- `next.config.ts` — `experimental.serverActions.bodySizeLimit` set to `10mb` to match the application-level check (previously unbounded at the framework level).
- `src/reports/query.ts` — `fetchAllRpcRows` (Order Fulfillment's own explicit past-PostgREST's-cap pager) now throws a clear "narrow your filters" error once matched rows exceed `MAX_RPC_ROWS = 25,000`, instead of paging forever.
- `src/reports/xlsx-writer.ts` — `renderXlsxBase64`, the single shared rendering chokepoint every one of the ~14 XLSX export actions funnels through, gained `assertSheetWithinLimits`: the same 25,000-row cap plus a 10,000-character cell-length cap.
- `src/export/csv-format.ts` — new `sanitizeCsvField`/`toSanitizedCsv`, deliberately kept separate from the existing `csvField`/`toCsv` (shared by all 14 Cin7-round-trip exports, which must keep byte-exact values — altering a SKU or account code that happens to start with `-` would corrupt a reimport into Cin7). Prefixes a value starting with `=`, `+`, `-`, `@`, or a leading control character with a single quote, so a spreadsheet app (Excel/Sheets/LibreOffice) displays it as literal text instead of evaluating it as a formula (e.g. `=cmd|'/c calc'!A1`).
- `src/export/fulfillment-cleanup-included-sales-csv.ts` — `buildIncludedSalesCsv`, the **one** human-facing CSV export in the app (every other CSV export round-trips into Cin7), switched from `toCsv` to `toSanitizedCsv`.

**Tests:**
- `src/lib/__tests__/csv-upload-limits.test.ts` (new, 13 tests) — size/text/row/column/field-length checks, at-limit and over-limit boundaries.
- `src/import/__tests__/csv.test.ts` — 2 new tests: rejects a 201-column file before validating any row, rejects a single over-length field naming the row and column.
- `src/reports/stocktake-assistant/__tests__/build.test.ts` — 1 new test confirming an over-length field returns this function's own error contract rather than throwing.
- `src/reports/__tests__/query.test.ts` — 1 new test proving `fetchAllRpcRows` throws once matched rows exceed 25,000 rather than paging forever.
- `src/reports/__tests__/xlsx-writer.test.ts` (new, 6 tests) — row-count and cell-length caps, at-limit boundaries, non-string cells ignored for length checks.
- `src/export/__tests__/csv-format.test.ts` (new, 8 tests) — `sanitizeCsvField` prefixes `=`/`+`/`-`/`@`/control-char-led values, leaves normal values and mid-string occurrences untouched; confirms `csvField`/`toCsv` (the 14 Cin7-round-trip exports) are completely unaffected.

**Live evidence:** N/A (pure application-code change, no schema/migration involved).

---

## Verification output (P1-7, final)

```
$ npx tsc --noEmit
(clean, no output)

$ npx eslint src
(clean, no output)

$ npx vitest run
 Test Files  125 passed (125)
      Tests  1183 passed (1183)

$ npm run build
✓ Compiled successfully
(all 50 routes built, no errors)
```

CI run (all jobs green): PR [#56](https://github.com/antonhill/cin7core-feeder/pull/56) — [run #32069338816](https://github.com/antonhill/cin7core-feeder/actions/runs/32069338816)
- `Install, lint, typecheck, test, build`: success
- `Dependency vulnerability scan`: success
- `Secret scan`: success
- `Clean migration bootstrap + RLS/security test matrix`: success
- `Vercel Preview Comments`: success

PR [#56](https://github.com/antonhill/cin7core-feeder/pull/56) merged to `main` at commit `5cdf6ea` on 2026-08-18.

---

## Round 4: final security closure (2026-08-18)

Round 4 was a dedicated closure investigation, run as its own multi-phase engagement rather than folded into this report's own round structure — full detail, evidence, and the underlying methodology live in **`docs/security-final-closure-matrix.md`**, not repeated here. Summary:

**Investigation phase:** 12 parallel, independent, read-only agents re-derived a complete surface for 12 security properties (Cin7 network gateway, every Cin7 POST, privileged Server Actions, active-org resolution, RLS/DB permission matrix, service-role usage, write-integrity locks/claims, internal API routes, diagnostic surface, Cin7 write audit coverage, import/export boundaries, credential encryption) directly against current `main` and live Supabase state, rather than trusting this report's own prior classifications. Five inventories came back clean; seven findings met the sign-off-blocker bar.

**Seven sign-off blockers found and closed**, per Anton's explicit decisions D1–D5 (documented in the closure matrix):
1. `requirePrivilegedOrgAdmin` failed open on a Supabase read error (the identical bug class P1-1 fixed elsewhere, reintroduced in the guard round 3 built).
2. 27 of 31 diagnostic Server Actions were gated by `requireOrgAdmin` instead of `requireSuperAdmin` (extends and closes round 3's own "diagnostics authorization" side-finding, item 5 below).
3. Zero audit logging existed on the diagnostic surface, including 4 actions that make real Cin7 writes (extends round 3's own "Cin7 write audit-log coverage" side-finding, item 6 below).
4. **New finding**, never named in any prior round: `category_instances`' RLS policy — the very table round 1's P0-5 fix touched — was named `"org admins manage..."` but actually gated on `is_org_member`, not `is_org_admin`.
5. **New finding**: the PO/Stock Transfer creation-claim RPCs' TTL-expiry reclaim logic (built in round 1, hardened in round 3's P1-5) never distinguished an `ambiguous` claim from a `pending`/`completed` one, letting an unresolved ambiguous claim silently become blindly re-creatable once its 15-minute TTL lapsed.
6. `/api/sync*`'s 6 POST handlers still trusted a body-supplied `orgId` behind only `CRON_SECRET` (round 3's own "not urgent" side-finding, item 4 below — reclassified here as a blocker and closed by deletion).
7. Purchase Order/Stock Transfer creation actions skipped audit logging entirely on a 100%-failed batch.

**Closure:** PR [#57](https://github.com/antonhill/cin7core-feeder/pull/57) — all 7 blockers implemented, tested, and (for the 2 DB-facing ones) live-verified against production both before and after applying. `SECURITY SIGN-OFF COMPLETE` per the closure matrix's own acceptance checklist. Not yet merged, pending Anton's explicit instruction (this engagement's standing rule, followed for every PR across all 4 rounds).

**Privacy policy** (`docs/legal/privacy-policy.md`) updated alongside — no longer claims "every write" is logged; now accurately describes the post-closure state (user-initiated/high-impact Cin7 writes and credential changes logged including failures; background sync logged at the run level).

---

## Also investigated in round 3, not yet implemented (out of this round's P0-only scope)

Round 3's 12-item investigation phase covered more ground than the 6 items actually implemented this round (P0-only, per Anton's own sequencing choice — P1 items deferred to a follow-up round). 4 investigations produced real findings with no code written yet; recorded here so a future round doesn't redundantly re-investigate:

- **`/api/sync*` on-demand routes (P1-6-adjacent):** confirmed **still NOT fixed** on `main` — all 6 routes still trust a body-supplied `orgId` after only a `CRON_SECRET` check, despite round 2's report noting Anton had started a background task for this. Good news: zero real callers found for any POST handler; 4 of 6 families already have a session-scoped Server Action replacement bypassing the route entirely. Low-risk, mechanical: delete `POST` from all 6 route files, keep only `GET` (the cron entry point). **Closed in round 4 (Blocker 6): all 6 POST handlers deleted.**
- **Diagnostics authorization (P1-9-adjacent):** 26 of 30 diagnostic Server Actions in `settings/instances/actions.ts` are gated by `requireOrgAdmin` (any customer org admin), not `requireSuperAdmin`, despite being documented everywhere as super-admin-only. Several return raw customer/supplier/sale PII to any org admin. Recommendation: every `debug*` action should call `requireSuperAdmin()` directly, independent of the shared `loadInstanceCreds` chokepoint. **Closed in round 4 (Blockers 2 and 3): all 31 `debug*` actions now call `requirePrivilegedSuperAdmin()` directly and the 4 write-capable ones are audit-logged.**
- **Cin7 write audit-log coverage:** the privacy policy makes an unqualified "every write" claim; reality is two-tier — Data Audit/Bulk Pricing/Reorder Points are fully and correctly logged, the sync/push pipeline only logs one aggregate count per instance per run (no per-record target), and shipment status changes, credential changes, and superadmin diagnostic writes aren't logged at all. No secret-leakage found. Recommendation: narrow the privacy-policy wording now (cheap, immediate), close the highest-value logging gaps as a follow-up. **Partially closed in round 4: diagnostic writes and credential changes are now logged (Blocker 3), and PO/Transfer batches log unconditionally (Blocker 7); the privacy policy wording was narrowed. Sync-pipeline per-record logging and shipment-status logging remain hardening-tier, not implemented — Anton's own D3 decision.**
- **Credential encryption lifecycle (P3, hardening not a vulnerability):** current AES-256-GCM is sound; no version/keyId/AAD/rotation support. Small blast radius (1 module, 4 call sites), no-outage migration path designed (dual-format decrypt support, opportunistic re-encryption). **Independently re-verified in round 4 (no live exploit found, confirmed genuinely pure hardening) — still not implemented, correctly deferred.**

## All 18 original items resolved

Round 1 covered 7 items (P0-1 through P0-7, P1-3); round 2 covered 6 more (P1-1, P1-4, P1-6, P1-8, P1-9, P2/CI); round 3 resolved P1-2 and P1-5, and closed P2/API optimisation as not-currently-justified; P1-7 (investigated in round 3, implemented 2026-08-18) was the last of the original 18 to close. None remain deferred or un-investigated.

Of the 4 side-findings from round 3's investigation phase — listed under "Also investigated in round 3, not yet implemented" above — round 4 closed 3 of them (`/api/sync*` routes, diagnostics authorization, and the highest-value part of Cin7 write audit-log coverage) as part of its own 7-blocker closure (see the round 4 section above and `docs/security-final-closure-matrix.md` for full detail). Only **credential encryption lifecycle hardening** remains open, correctly deferred as non-blocking (no live exploit, hardening-only). A handful of narrower hardening items surfaced by round 4's own investigation (sync-pipeline per-record logging, shipment-status logging, and others in the closure matrix's Hardening Backlog) also remain open, non-blocking, for a future pass whenever picked up.
