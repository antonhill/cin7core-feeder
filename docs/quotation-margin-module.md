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

## Decisions (resolved 2026-08-25, Anton)

1. **Cin7 test target (§22):** a **sandbox / demo Cin7 Core account**. Phase 3 is unblocked once
   that sandbox instance is wired into a test org/instance in Toolbox; probe there, never a
   live customer.
2. **Margin/cost visibility (§33):** **everyone with `quotes` module access sees cost + margin.**
   Matches the existing precedent (Average Cost is already visible to module members in reports)
   and the module's purpose. NO new cost-visibility permission is built. Cost/margin flow to the
   quotes UI for any member who can open it.
3. **Currency (§10):** **ZAR-only for V1.** Quote + cost + margin all in ZAR; flag/limit non-ZAR
   customers. `quotes.currency`/`exchange_rate` columns kept in the schema for forward-compat but
   V1 always ZAR (rate = 1). Multi-currency deferred to V2.
4. **Member-write AAL2 (§32):** **No.** A quote-create Cin7 write requires only
   `requireModuleWrite` (module + billing), matching pricing/stock-transfer member writes.
5. **Uncosted additional charges (§19):** **excluded from margin.** An uncosted charge shows
   `cost —, margin N/A` and is left OUT of the overall margin denominator (with a footer note);
   never inflates the headline margin.

## Sequencing
Phases 1–2 (data model + margin engine + RLS + local search + draft CRUD + builder UI) don't need
Cin7-create and proceed now. Phase 3 (Cin7 submission) proceeds once the sandbox instance is
connected + the live `testCreateSaleQuote` probe has verified the contract.

---

---

# Completion Report (V1 shipped 2026-08-26)

**Status: COMPLETE and live.** All phases built, merged to `main`, deployed, and verified end-to-end
against the Spark Demo Cin7 sandbox. The module ships **hidden by default** (migration `0085` seeds
every org's `disabled_modules` with `/quotes`); it is enabled for the owner's org only. A super-admin
enables it per org via `/admin`.

### What was built (branch-per-phase, PR each)

| Phase | Content | PRs |
|---|---|---|
| 0 — Discovery | This report's Phase 0 + decisions | #59 |
| 1 — Data + engine | Margin engine, schema (`0084`), draft CRUD, module registration, hidden-by-default (`0085`) | #60, #61 base |
| 2 — Builder UI | Live per-line margin + weighted footer; searchable customer/location/tier/rep; tier→price; customer tax rule→VAT %; live customer resolve | #61, #62, #66, #67, #68, #70, #72 |
| 3 — Cin7 submission | `Submit to Cin7`: two-step create, idempotency, reconciliation, VAT, additional charges, tax-inclusive | #71, #72, #74, #76 |

### Cin7 Sale/Quote CREATE contract — CONFIRMED LIVE (the Phase-0 blocker, resolved)

Discovered via `scripts/probe-quote-create.mjs` (an iterative live probe against the sandbox, the same
approach PO-create needed). Two steps, both `nonIdempotentCreate`, all references **by name**:

1. **`POST /sale`** — header. Body: `{ Customer, Location, SaleOrderDate, SkipQuote:false, TaxInclusive,
   TaxRule, PriceTier, SalesRepresentative, ExternalID }`. Returns `ID` (SaleID), `Order.SaleOrderNumber`
   (e.g. `SO-00743`), `Status:"ESTIMATING"`, and echoes `ExternalID`.
2. **`POST /sale/quote`** — lines + charges. Body: `{ SaleID, Memo, Status:"DRAFT", Lines:[{ ProductID,
   SKU, Name, Quantity, Price, Discount, Tax, TaxRule, Total }], AdditionalCharges:[{ Description,
   Comment, Quantity, Price, Discount, Tax, TaxRule, Total, Account }] }`. Returns Cin7's totals.

**Non-obvious findings the probe pinned down:**
- `TaxRule` is required on the header **and** every line/charge.
- Cin7 **uses the `Tax` amount we send** on each line/charge (it does NOT derive it from `TaxRule`) —
  sending `Tax:0` made VAT land as 0. We resolve the rate from `/ref/tax` (`TaxRuleList[].TaxPercent`)
  and compute it.
- `Total` is the **discounted line amount in the quote's tax mode** — net when tax-exclusive, **gross**
  when tax-inclusive (Cin7 rejects a net Total in inclusive mode: *"Expected value is: <gross>"*).
- Additional charges post to a GL revenue account (`Account` = the customer's `RevenueAccount`).
- Reference books used: `/ref/location`, `/ref/priceTier`, `/ref/tax`, `/me/contacts` (sales reps),
  `/customer` (live customer defaults).

### Architecture & reuse (no parallel infra)

- **Gateway:** every Cin7 call goes through `cin7Request` (`src/cin7/http.ts`) — rate-limited, retry/
  deadline-bounded, credential-safe. Registered in `docs/cin7-post-classification.json` as
  `RECONCILE_BEFORE_RETRY`.
- **Idempotency/reconciliation:** mirrors PO/Stock-Transfer exactly. `quote_creation_claims` table +
  `quote_creation_claim` RPC (migration `0084`, with `0080`'s "ambiguous never age-reclaims" rule
  baked in). Wrappers in `src/lib/quote-submit.ts` (`claim` fail-closed, `settle`, `release`,
  `mark-ambiguous`, `discard`). `ExternalID = QUOTE-<quoteId>` is the reconciliation key.
- **Authz:** reads use `requireModuleAccess('/quotes')`; writes use `requireModuleWrite('/quotes')`
  (module + billing; no AAL2, per decision #4).
- **RLS:** org members read `quotes`/`quote_lines`; no client write policy (service-role writes only);
  `quote_creation_claims` service-role only.

### Margin calculation & cost basis

`src/lib/quote-margin.ts` (pure, 26 tests) is the single source of truth, used **client-side** for the
live builder and **server-side** on save (a client can never persist its own totals). Weighted overall
margin from summed revenue/cost (never an average of line %s); margin on revenue **ex-tax**; a line
whose cost is unknown is **excluded** from the margin (never costed as 0). Cost basis = the org's synced
Cin7 **Average Cost** (`products.average_cost`), sourced server-side by SKU. Uncosted additional charges
are excluded from margin (decision #5). ZAR-only V1 (decision #3).

### Submit flow & failure handling (the money path)

`submitQuoteAction` (`src/app/quotes/actions.ts`): validate draft → resolve the **live** customer tax
rule + rate → **claim** → **create** (`src/cin7/sale-quote-write.ts` `createSaleQuote`, resolving each
SKU's `ProductID` via `findProductBySku`) → settle + link (`status='submitted'`, `cin7_sale_id`,
`cin7_quote_number`). Failure paths: concurrent submit blocked by the claim; a network-ambiguous
outcome is never blindly retried and is reconciled by `ExternalID` on the next attempt (link if found,
else retry fresh); a step-2 (lines) definite failure links the created header (no duplicate) with a
warning to complete it in Cin7.

### Verification (live, Spark Demo sandbox)

- Tax-**exclusive** submit → `SO-00743` — products, prices, margins, tax rule, sales rep, account all
  correct; VAT corrected (#72).
- Additional **charges** → accepted with computed tax + revenue account (#74).
- Tax-**inclusive** → probe `--inclusive` returned **MATCH** (net R150 / VAT R22.50 / total R172.50) (#76).
- Static gates on every merge: `eslint` + `tsc` clean, full suite **1315 tests** green (37 engine/build +
  11 submit-payload), `next build` compiles `/quotes`, Cin7-POST classification + service-role allowlist
  + RLS guardrail tests all pass.

### Known V1 limitations / deferred to V2

- **Multi-currency** — ZAR-only; `currency`/`exchange_rate` columns exist for a future FX pass.
- **Per-product tax rule** — all lines use the customer's tax rule (products' own `SaleTaxRule` not
  resolved in V1).
- **Sales-rep list** — all `/me/contacts` shown (not filtered to `Type:"Sale"` contacts).
- **Cost/customer freshness** — cost from the last product sync; customer defaults are refreshed live at
  pick time, but the picker list itself is the synced `customers` table (no continuous customer pull).
- **Quote → Cin7 is one-directional** — once submitted, the quote is frozen in Toolbox; edits happen in
  Cin7.

### Key files

`src/lib/quote-margin.ts` · `src/lib/quote-build.ts` · `src/lib/quote-submit.ts` ·
`src/cin7/sale-quote-write.ts` · `src/cin7/reference-lookups.ts` (locations/tiers/tax/contacts) ·
`src/app/quotes/actions.ts` · `src/app/quotes/page.tsx` · `supabase/migrations/0084_quotes.sql` +
`0085_hide_quotes_module_by_default.sql` · `scripts/probe-quote-create.mjs` (discovery/verification tool).
