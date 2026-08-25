# Quotation + Margin Module — Implementation Report

> This is the living implementation report required by the brief (§44). It starts with
> the **Phase 0 discovery** below and is extended as each phase lands. Brief of record:
> `docs/quotation-margin-module-brief.md`.

**Status:** Phase 0 (discovery) complete — awaiting owner decisions before Phase 1.
Discovery done via three read-only inspections of `main @ bcf3c0a` (2026-08-25).

---

## Phase 0 — Discovery

### A. Existing architecture to reuse (do NOT build parallel infra)

**Cin7 write gateway** — `src/cin7/http.ts` `cin7Request<T>()` is the ONLY sanctioned way to
call Cin7 (enforced by `src/test/__tests__/cin7-gateway-boundary.test.ts`). Distributed rate
limiting via `src/cin7/rate-limit.ts` `acquireCin7Slot` is automatic inside `cin7Request`;
writes never degrade to a local throttle. There is **no `workflow` tag** today — attributing
`workflow=quotation` means threading an optional field / using the audit action name.
Set `nonIdempotentCreate: true` on the create call.

**Idempotency + reconciliation** — mirror the PO / Stock-Transfer pattern exactly:
- Claim tables `po_creation_claims` (migration `0055`) / `stock_transfer_creation_claims`
  (`0056`), PK `(org_id, instance_id, idempotency_key)`, status `pending|completed|ambiguous`.
- Atomic claim RPC (`po_creation_claim`) = `INSERT ... ON CONFLICT DO NOTHING`, else
  `SELECT ... FOR UPDATE` (return live claim or age-reclaim past TTL). `ambiguous` **never**
  age-reclaims (migration `0080`). 15-min TTL. Guard errors **fail closed**
  (`existingStatus: "guard_unavailable"`), per re-audit round 3 P1-5.
- Full flow template: `src/app/supplier-planner/actions.ts:260-422` (claim → create →
  settle on success / release on definite failure / mark ambiguous on lost response or
  settle-write failure).
- → **New:** `quote_creation_claims` table + `quote_creation_claim` RPC copying `0055/0056/0080`;
  `src/lib/quote-idempotency.ts` mirroring `src/lib/po-idempotency.ts`. Idempotency key =
  Toolbox quote UUID (+ org + instance), NOT a content hash (a quote is edited in place).

**Reconciliation key opportunity** — PO/transfer reconciliation is best-effort heuristic
(newest matching DRAFT in the TTL window). Cin7's Sale API has a writable, currently-**unused**
`ExternalID` field (`src/cin7/sales.ts:37`). If it round-trips + is filterable, embed the
Toolbox quote UUID there for an *exact* reconciliation match. **UNVERIFIED — probe required.**

**Audit** — `src/lib/activity-log.ts` `logActivity()` → `activity_log` (`0022`). Never logs
creds / PII / raw bodies. Action naming `"<feature>.<verb>"` → `"quotation.create_quote"`.
Log unconditionally (even all-failure batches), per re-audit "Blocker 7".

**Authorization** — `src/lib/authorization.ts` `requireModuleAccess` (reads) /
`requireModuleWrite` (= access + `requireWriteAllowed` billing gate; Cin7 writes). Both fail
closed. Org via `requireCurrentOrg()`; creds via `src/cin7/load-credentials.ts` (SSRF-safe).
**Register the `quotes` module with a single `ModuleConfig` entry in `src/app/module-nav.tsx`**
(that array drives member allow-lists, org toggles, nav gate, home tiles automatically).
**AAL2 is NOT required** for a member Cin7 write — confirmed against `pricing/actions.ts` and
`replenish/actions.ts` (both only `requireModuleWrite`). AAL2 is reserved for admin/instance/
billing actions.

**RLS + CI** — new tables: `alter table … enable row level security` +
`create policy "org members read <t>" … using (is_org_member(org_id))`, **no client write
policy** (writes via `createServiceRoleClient()` in guarded actions). Add a checked-in
`supabase/tests/NNNN_quotes_rls.test.sql` (seeded-org member/cross-org pattern of `0079`). The
create POST must be added to `docs/cin7-post-classification.json` (classification
`RECONCILE_BEFORE_RETRY`) and `scripts/service-role-allowlist.json`. CI (`.github/workflows/ci.yml`):
`lint`, `tsc --noEmit`, `vitest`, `build`, `npm audit --audit-level=high`, gitleaks, and a full
`supabase db reset` + all `supabase/tests/*.test.sql`.

### B. Local data inventory (search local-first)

**Freshness caveat:** `products` / `customers` / `price_tiers` / `average_cost` are **not**
cron-synced — they land only via a *manual* CSV Import or Migrate-pull. Only
`product_availability`, sales, purchases, builds are cron-pulled. → The quote UI needs a
"**data as of `products.updated_at`**" freshness indicator. There is also **no existing local
search** in the app — the quote builder is the first to `ilike` local tables (org-scoped).

| Field | Local source | Notes / fallback |
|---|---|---|
| Customer name | `customers.name` (PK, no surrogate id) | Cin7 `GET /customer` |
| Customer Cin7 id | `customer_sync_state.cin7_id` | **only after a push** — may be absent; live `GET /customer?Name=` |
| Contacts | `customer_contacts` | |
| Product SKU/name/desc/barcode | `products.*` | |
| Product Cin7 id | `sync_state.cin7_id` | **only after a push** — may be absent |
| Price tiers | `price_tiers.amount` keyed `(org_id, product_sku, tier_code="Tier1..10")` | positional |
| Customer default tier | `customers.price_tier` = tier **NAME** (e.g. "Wholesale") | **GAP** below |
| Average cost | `products.average_cost` | commercially sensitive (see D) |
| Availability | `product_availability` (OnHand/Available/OnOrder per Location) | **truly cron-fresh (15 min)** |
| Addresses | `customer_addresses` (billing/shipping) | |
| Currency | `customers.currency` / `price_tiers.currency` (default ZAR) | free text |
| Tax rule / terms / sales rep / revenue account | free text on `customers`/`products` | no local reference list |
| Locations | **none** (free text everywhere) | live `/ref/location` |
| **Tier-name ↔ Tier1..10 map** | **none** | live `/ref/priceTier` — needed to auto-price |
| **Exchange rate** | **none anywhere** | external FX source only |

### C. The critical-path blocker — Cin7 quote-create contract UNVERIFIED

No Sale/Quote *create* function exists. **KNOWN:** `SALE_WRITABLE_FIELDS`
(`src/cin7/sales.ts:14-39`) incl. `SkipQuote`, `PriceTier` (by **name**), `SalesRepresentative`
(by **name**, must be a `Type:"Sale"` company contact), `Location` (required),
`TaxRule`→write-side `TaxInclusive` boolean, `ExternalID`, `CurrencyRate`; `/sale/quote` is a
documented distinct resource (status lifecycle unconfirmed, `cin7-api-findings.md §13h`).
**UNKNOWN (needs a live probe against a SAFE test account):** exact endpoint (POST `/sale` vs
`/sale/quote`); whether lines are a separate sub-resource call (no `Lines` in the writable set
→ likely yes, like PO's two-step); response shape (Sale ID + quote/order number); id-vs-name on
*create*; null-field handling; `ExternalID` round-trip; `SkipQuote` semantics. **Precedent: PO
creation took 7 rounds of live probing** — a `testCreateSaleQuote` diagnostic (like
`src/cin7/debug.ts` `testCreatePurchaseOrder`) must run before writing `createQuote`.

### D. Commercial-data leak to design around

`products.average_cost` (+ `*_account` fields) sits in `products` with only `is_org_member`
RLS — **any module member already sees cost today** (e.g. cost-estimator report). A quote
product-picker must **exclude cost from the browser payload** unless the viewer is permitted to
see margin. There is **no cost/margin-visibility permission** in the codebase (see decisions).

---

## Open decisions (blocking Phase 1/3) — for Anton

1. **Safe Cin7 test target (§22) — CRITICAL, gates Phase 3.** A sandbox / throwaway test
   customer to probe + verify quote creation. Without it, Cin7 submission is BLOCKED-EXTERNAL.
2. **Margin/cost visibility (§33).** No permission exists. (a) new `can_view_cost` flag,
   (b) owner/admin-only cost, or (c) accept module-access = full visibility.
3. **Currency (§10).** ZAR-only v1 (recommended; zero FX infra exists) vs build multi-currency.
4. **Member-write AAL2 (§32).** Recommended: No (matches existing precedent) — confirm.
5. **Uncosted additional charges (§19).** Exclude from margin denominator vs include as
   revenue with unknown cost.

## Recommended sequencing
Phases 1–2 (data model + margin engine + RLS + local search + draft CRUD + builder UI) do NOT
need Cin7-create and can start once decisions 2–5 are set. Phase 3 (Cin7 submission) waits on
the safe test account (#1) + the live probe.

---

## Sections to complete in later phases (§44)
Database schema · Permissions · Margin calculation · Cost basis · Multi-currency ·
Cin7 API contract (post-probe) · Create/reconciliation lifecycle · API usage · Tests ·
Security/RLS · Known limitations · Deferred V2 features · Verification results.
