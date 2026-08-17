# Cin7 Core Feeder — Security Re-Audit Remediation Report

**Date:** 2026-08-17 (round 1), updated 2026-08-17 (round 2)
**Scope:** All 18 items from the re-audit. Round 1 covered Anton's own priority order of 7 structural blockers (P0-1 through P0-7, P1-3). Round 2 covered a further 6 of the remaining 11 deferred items (P1-1, P1-4, P1-6, P1-8, P1-9, P2/CI), chosen by Anton as "the straightforward six." 4 items remain DEFERRED: P1-2, P1-5, P1-7, and P2 (API optimisation).
**PRs (round 1):** [#37](https://github.com/antonhill/cin7core-feeder/pull/37) (P0-1, P0-2, P0-5, P0-6, P0-7, P1-3) → [#38](https://github.com/antonhill/cin7core-feeder/pull/38) (P0-3, P0-4, stacked on #37). Merge order: #37 then #38. [#36](https://github.com/antonhill/cin7core-feeder/pull/36) was an earlier, incomplete first pass at P0-3 — closed as superseded by #38.
**PR (round 2):** [#40](https://github.com/antonhill/cin7core-feeder/pull/40) (P1-1, P1-4, P1-6, P1-8, P1-9, P2/CI) — merged `70edefe` on 2026-08-17.

## A note on process

P0-3's first pass ([#36](https://github.com/antonhill/cin7core-feeder/pull/36)) was scoped from a paraphrased summary of the item ("correct distributed rate limiting"), not its full text, and shipped covering 2 of the 7 things the item actually specified. This was caught before the final report was written by going back to the original message text and checking every FIXED item's evidence line-by-line against the literal wording — the same discipline "do not claim completion from code inspection alone" asks for, applied to my own prior work, not just the codebase. The gap is closed in #38. Flagging this here rather than quietly folding it in, since it's relevant to how much to trust the FIXED classifications below: each one below was re-checked against the item's literal text, not the paraphrase.

**Round 2's own process note:** learning from the P0-3 mistake above, round 2 started with 10 parallel read-only investigation agents establishing ground truth against each deferred item's literal spec text before any grouping or scoping decision was made, rather than working from a paraphrase. Building the new CI job (P2) then surfaced two real bugs neither code inspection nor isolated live checks had caught — a test-assertion methodology gap in the `0052` RLS regression test, and a stale fixture in the pre-existing `0063` box-label test left behind by a prior round's migration — both detailed under P2 below. Both are further evidence for why this report insists on live/CI verification over code inspection: the bugs were in the *tests*, not the application code, and only running everything end-to-end for the first time found them.

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
| P1-1 | **FIXED** (round 2) | `requireModuleAccess` now fails closed on any of its 3 Supabase read errors |
| P1-2 | DEFERRED | Not investigated |
| P1-3 | **FIXED** (round 1) | `requireWriteAllowed` added to 3 real write paths missing it |
| P1-4 | **FIXED** (round 2) | Lemon Squeezy webhook: checkout-token binding, two-stage Zod validation, unknown-status left untouched instead of defaulting to canceled |
| P1-5 | DEFERRED | Not investigated |
| P1-6 | **FIXED** (round 2) | Single `CRON_SECRET` (timing-safe compare), unsafe `/api/import` route removed entirely |
| P1-7 | DEFERRED | Not investigated |
| P1-8 | **FIXED** (round 2) | `shouldCreateUser:false`, atomic self-serve org+owner RPC, explicit active-org selection/switcher |
| P1-9 | **FIXED** (round 2) | Magic-byte org-logo content sniffing (SVG removed), all 6 security headers added |
| P2 (API optimisation) | DEFERRED | Not investigated |
| P2 (CI and sign-off) | **FIXED** (round 2) | Full CI pipeline: lint/tsc/vitest/build, dependency audit, secret scan, clean-bootstrap migration + RLS/security test matrix |

No items classified NOT APPLICABLE — every item investigated across both passes was either fixed or deferred outright. 4 items (P1-2, P1-5, P1-7, P2/API optimisation) remain DEFERRED, not yet investigated.

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

## DEFERRED items — not investigated (either pass)

Round 1 covered 7 items (P0-1 through P0-7, P1-3); round 2 covered 6 more (P1-1, P1-4, P1-6, P1-8, P1-9, P2/CI). 4 of the original 18 items remain untouched:

- **P1-2** — Enforce AAL2 inside privileged Server Actions (needs one new reusable guard function wired into ~9 files/15-20 functions)
- **P1-5** — Classify lock failure policy (needs an explicit sign-off on reversing the fail-open philosophy for 3 specific write-integrity locks)
- **P1-7** — Import/export resource boundaries (needs sorting ~15 export files into Cin7-round-trip vs. human-facing before any fix)
- **P2** — API optimisation (modifiedSince watermarks for Customer/Supplier/Product sync — Cin7-side support is unverified; implementing without a live probe first would repeat the exact mistake Phase 3.3b was built to avoid, and the cron-scheduled sync doesn't even list-scan those 3 endpoints today, so the item's practical benefit is unclear until scoped further)

None of these were touched, reviewed, or partially started in either pass — they carry no evidence either way and should be treated as fully open for the next audit round.
