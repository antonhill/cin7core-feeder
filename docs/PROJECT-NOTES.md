# Project notes — decisions, gotchas, and current state

This is the durable, committed record for this project — unlike a Claude Code session's local
memory, this file travels with the repo to any machine. Read it at the start of a session
alongside `README.md` (what the app is) and `docs/cin7-api-findings.md` (verified Cin7 API
behavior). Keep this updated with *decisions and gotchas*, not a session-by-session diary —
prune/rewrite entries here rather than appending forever once something is fully superseded.

## What's shipped

- **Import** (`/import`): 3-step wizard — CSV upload (Products/AssemblyBOM/ProductionBOM,
  Customers/Suppliers/their Addresses) → validation with blocking errors and non-blocking
  warnings → push to one or more connected Cin7 Core instances, scoped to "All" or "just this
  import" per data kind.
- **Instance Migrator** (`/migrate`): pulls every Product/Assembly BOM/Customer/Supplier live from
  one instance and feeds it through the same import pipeline server-side, then pushes to other
  instances — a migration gets identical validation/audit-trail to a manual upload.
- **Sync engine**: idempotent create-or-update push for Products, Assembly BOM, Customers,
  Suppliers. Skip-if-unchanged via a trigger-maintained `content_hash` vs. each instance's
  `sync_state.synced_hash`. Pre-flight reference-book existence checks (Location, SalesRepresentative,
  AccountReceivable/Payable, TaxRule, PriceTier, PaymentTerm, ProductAttributeSet, DiscountName)
  run before the real push so failures surface in one pass instead of a multi-round trial-and-error
  cycle. **Production BOM push is paused** — the Work Centre/Resource GUID lookup it depends on
  404s on every path tried against the live public API; working theory is that Work Centre/Resource
  management isn't exposed on the public partner API at all (only Cin7's internal frontend API),
  though this hasn't been confirmed by Cin7 support. Don't re-attempt path-guessing without new
  evidence.
- **Reporting Consolidator** (`/reports`): two-phase sales sync (cheap paginated list scan queues
  new/changed sales, then a rate-limited detail phase pulls line items + `AverageCost`, since
  Cin7's Sale API has no bulk line-item endpoint) + a pivot grid matching Cin7's own native pivot
  report layout + Excel export (`exceljs`, not `xlsx`/SheetJS — see below).
- **Data Audit** (`/audit`): pulls a chosen instance's products live and flags missing
  Brand/sales-pricing/inventory-setup/GL-accounts, near-duplicate Category/UOM/Tag values
  (Levenshtein-based), incomplete `AdditionalAttribute1-10` values within a category (with a
  copy-from-template bulk fix), and lets you bulk-toggle Sellable. All fixes write **directly to
  the audited Cin7 instance** — no canonical-DB detour, by design.
- **Auth**: Supabase Auth via a typed 6-digit OTP code (not magic links — M365's Safe Links
  pre-consumes link-based codes before the user clicks, so any future email-code auth on an M365
  tenant should go straight to OTP entry). `/admin` (gated by a `super_admins` table) lets Anton
  create orgs and invite users; no self-serve signup, no org ID ever shown to a client.
- **MFA, 2026-07-07**: opt-in TOTP two-factor via Supabase Auth's built-in `auth.mfa` API — no new
  infra. `/settings/security` (linked from the sidebar footer, next to Sign out) lets a user
  enroll/remove an authenticator app factor (QR code + manual secret, matching `SECURITY_MODULE` in
  `module-nav.tsx` — deliberately not in `MODULES`, so it's not an org-toggleable tile). The email
  OTP sign-in only ever proves `aal1`; `middleware.ts` now also checks
  `auth.mfa.getAuthenticatorAssuranceLevel()` and redirects to `/mfa-challenge` whenever a user has
  a verified factor but hasn't cleared it this session — that page (plain layout like `/login`, no
  sidebar) challenges + verifies the TOTP code, with a "sign out instead" escape hatch since the
  main sidebar isn't rendered there. Deliberately **opt-in per user**, not org-wide mandatory —
  matches the "small, Anton-invited user base" scale; revisit if that changes. Not yet tested against
  a real authenticator app end-to-end (needs a real login, can't simulate OTP email delivery in this
  environment) — verified instead via unauthenticated smoke checks (`Auth session missing!` renders
  cleanly, no crash) plus a fresh `tsc`/`eslint`/`vitest`/`next build` pass. No backup-codes flow —
  Supabase doesn't provide one out of the box, so a lost device today means Anton manually
  unenrolling the user's factor via the service-role client.
- **Visual language, 2026-07-07**: dark sidebar (new `--sidebar-*` CSS vars in `globals.css`,
  `#12172a` base) replacing the old white sidebar, to match a reference production-dashboard
  screenshot Anton shared. `ModuleHeader` slimmed from a big bordered banner card to a compact
  title bar (icon chip + title + one-line blurb, bottom-border only) so it reads like a dashboard
  title rather than its own content block. Home page gained a 3-card KPI row (active instances,
  team members, activity in the last 7 days) via cheap `count: "exact", head: true` Supabase
  queries — no live Cin7 calls — added in `getHomeStats()`; `getCurrentUserInfo()` now also
  returns `orgId` to support this. Module tiles/icons (gradient chips per module in
  `module-nav.tsx`) were kept as-is, just tightened in spacing — they already matched the
  colorful-icon-square look being aimed for.
- **System Health** (`/health`): live scorecard across 6 dimensions — Sales unfulfilled past
  deadline (`FulFilmentStatus`/`ShipBy`), Purchases not received past deadline
  (`CombinedReceivingStatus`/`RequiredBy`), Stock Transfers stuck in draft/ordered/in-transit,
  Assemblies not completed, Production Orders due and behind (`RequiredByDate`, filtered to
  `Type: "O"` to avoid double-counting routing sub-rows), and Product Data Health (reuses the Data
  Audit's own findings, broken down by named check — duplicate categories/brands/UOMs/tags,
  inconsistent attributes, missing Brand/pricing/inventory/GL — not one blended count). All 5
  non-product checks needed brand-new Cin7 API research (`/purchaseList`, `/stockTransferList`,
  `/finishedGoodsList`, `/production/orderList`) — see `src/health/system-health.ts` for the exact
  live-verified field mapping. Same live-scan, read-only design as Data Audit.

## Standing rules (recurring bug classes — don't relitigate these)

1. **A `"use server"` file must contain ONLY async function exports** — no exported consts,
   objects, or `export type {...}` re-exports. One non-function export fails the *whole module* at
   runtime request time, taking down every action in that file (not just the one you're touching).
   `next build` succeeding does **not** prove this — it's a runtime-only check. Verify with a real
   production request (`next build && next start` + hit the route, or an actual Vercel deploy) after
   touching any actions file. This has caused two separate production outages already.
2. **A push-payload-shape code change doesn't invalidate already-synced rows.** `content_hash`
   only reflects *canonical data* changes, not push-logic changes — if you fix how a field is sent
   (e.g. blank-clears-field, a new field added to the payload), already-synced rows will keep
   skipping as "unchanged" forever unless you also reset `synced_hash` (customer/product/supplier
   sync_state) for affected rows.
3. **Blank CSV values actively clear the corresponding Cin7 field on push** for Products,
   Customers, and Suppliers (confirmed via direct testing) — every optional field must be sent as
   `""`/`0` rather than omitted (`|| undefined` silently means "leave untouched," which is wrong).
4. **A reference-book "exists" check's own lookup call needs defensive error handling.**
   `/ref/location` and `/me/contacts` degrade to an empty array on no-match; `/ref/account` throws
   a 400 instead. Treat any non-retryable API error from an exists-check as "not found," not a crash
   — a retryable error (rate limit, network) should still propagate.
5. **Plain existence isn't always the full requirement.** AccountPayable/Receivable also require
   matching `SystemAccount` (a same-Type/Class account can still be the wrong "special" one);
   PaymentTerm and DiscountName also require `IsActive` — a same-named deactivated record still
   shows up in a plain list GET.
6. **Cin7's own field docs don't reliably match live API casing/values.** Product `Status` docs say
   `Active`/`Deprecated`; live exports show `ACTIVE` (all caps). Sale `CombinedInvoiceStatus` docs
   list values that don't appear at all in real data. Verify against a live diagnostic pull before
   trusting written docs, and prefer case-insensitive comparisons for enum-like fields generally.
7. **A CSV import can have more structural repetition than a naive "one row = one entity" model
   assumes** — multiple contacts and multiple addresses per (Name, AddressType) are normal;
   check for repeated key columns across sample rows before assuming a flat 1:1 shape.
8. **`exceljs`, not `xlsx`/SheetJS**, for Excel export — SheetJS's last npm release has unpatched
   prototype-pollution/ReDoS advisories with fixes only available via their own CDN.

## Known gaps (scoped, not yet started — see Task #33 in project tracking)

Reviewed 2026-07-06 for client-readiness beyond the first client (Casa das Natas):
- ~~No Row-Level Security anywhere~~ — **correction, same day**: this was wrong. Every table
  across `supabase/migrations/` has `ENABLE ROW LEVEL SECURITY` plus org-scoped policies
  (`is_org_member(org_id)`), confirmed by grepping all 27 tables. The original finding used a
  case-sensitive search that missed this codebase's lowercase `enable row level security`
  convention — a real defense-in-depth layer already exists underneath the app-level
  `requireCurrentOrg()` checks (the service-role client still bypasses RLS, so app-level scoping
  is still the primary enforcement, but there IS a DB-level backstop, contrary to what was
  recorded here before). Not a gap — removed from the task list.
- ~~No activity/audit log~~ — **shipped 2026-07-05**: `activity_log` table + `/activity` page
  records every live write this app makes (Data Audit fixes/merges, sync push), with who/when.
  See `src/lib/activity-log.ts`.
- ~~No confirmation before bulk fixes/merges in Data Audit~~ — **shipped 2026-07-07**:
  `window.confirm()` gates before every Data Audit write (bulk field-set, merge, attribute-copy,
  Sellable toggle) in `src/app/audit/page.tsx`, matching the existing confirm-before-delete
  pattern elsewhere in the app.
- ~~No privacy policy / DPA / subprocessor list~~ — **drafted 2026-07-07**: see
  `docs/legal/privacy-policy.md`, `docs/legal/data-processing-agreement.md`,
  `docs/legal/subprocessors.md`. These are **drafts only** — grounded in this repo's actual
  architecture (Supabase `eu-west-1`, Vercel, AES-256-GCM credential encryption, RLS isolation,
  activity log) but explicitly require real attorney review before use with any client; several
  sections (retention period, liability/governing law, breach-notification window) are left as
  placeholders because they're business/legal decisions, not something to invent. POPIA is the
  primary framework (Spark is SA-based); GDPR is called out as conditional — only relevant if a
  specific client's Cin7 data includes EU/UK personal information.

## Scoped, not started (see Task tracking for current numbers)

- **Per-instance price markup** — scoped 2026-07-06 for a new client running a two-instance
  inter-company trading structure: a Procurement instance buys from suppliers at BEEE-negotiated
  rates and "sells" (inter-company) to a Selling instance at a markup, which then sells to end
  customers. **Today, `price_tiers` is keyed `(org_id, product_sku, tier_code)` — one canonical
  price per SKU per org, pushed identically to every connected instance.** There's no way for the
  same SKU to carry a different sell price per instance. Note: the inter-company
  Procurement→Selling leg itself (Sales Order in one instance, Purchase Order in the other) is
  Cin7's own native Sales/Purchases workflow — this app doesn't push Sales or Purchases at all, so
  there's nothing to build there; the gap is specifically the Selling instance's end-customer
  PriceTier values needing to differ from whatever's on the product record elsewhere.
  - **Chosen approach: a markup percentage configured per instance**, not full per-instance price
    overrides — matches the client's stated "cost + markup" formula directly (change the base
    canonical price once, every instance's push price updates correctly), versus a full override
    table which would allow arbitrary per-SKU pricing per instance but need ongoing manual upkeep.
    Revisit if the client's real markup turns out to vary by category/product rather than being
    one flat instance-wide %.
  - **Schema**: add `price_markup_percent numeric(7,4) not null default 0` to `cin7_instances` —
    default 0 is a no-op (existing instances/clients push canonical prices unchanged, fully
    backward compatible).
  - **Code path**: `Cin7Credentials` (`src/cin7/types.ts`) gains `priceMarkupPercent`, populated by
    `loadCin7Credentials`. New pure `applyPriceMarkup(priceTiers, markupPercent)` helper in
    `src/cin7/products.ts` (alongside `toCin7ProductPayload`) — applied in `run-sync.ts` right
    before the existing `pushProduct(creds, product, priceTiers, ...)` call (line ~311), so
    `pushProduct`/`toCin7ProductPayload` themselves stay simple "push this exact data" functions,
    not instance-aware.
  - **UI**: add a "Price markup %" field to the Add/Edit Instance modal on
    `/settings/instances`, alongside the existing Account ID/Application Key/Base URL fields.
  - **Scope boundary**: markup applies uniformly to every PriceTier field being pushed for that
    instance — no per-tier or per-category markup rules in v1.

- **System Backup (backup-only, not restore)** — scoped 2026-07-06. Periodic, read-only snapshots
  of live Cin7 data into this app's own Supabase DB, purely defensive ("in case there's ever a
  problem" with the source instance) — explicitly NOT a restore/write-back feature, since Sales,
  Purchases, Stock Transfers, Assemblies, and Production Orders have no push-to-Cin7 path in this
  codebase today (only Products, Assembly BOM, Customers, Suppliers do) — building restore for the
  other 5 would be a much larger, separate effort.
  - **Scope**: full-fidelity snapshots (list + per-record detail call, e.g. `/sale?ID=` for
    Invoices/Fulfilments/line items) — deliberately more thorough than `/health`'s list-only reads,
    since a backup's whole value is fidelity. New tables: a `backup_runs` header row per snapshot
    + `backup_records` (one row per record per run, raw JSONB — same "store the raw response, don't
    lossily normalize" precedent as `import_rows.raw`).
  - **Fetch design**: reuse the exact two-phase pattern already built for sales sync
    (`src/sync/sync-sales.ts`) — cheap list scan first, then a rate-limited, resumable detail-fetch
    phase — rather than reinventing the same "many detail calls behind Cin7's 60/min limit"
    solution. Scheduled via a new `/api/backup` Vercel Cron endpoint, same bearer-secret auth
    convention as `/api/sync`/`/api/sync-sales`.
  - **Retention**: full snapshots (not incremental/delta — simpler to reason about "what did Cin7
    look like on date X"), rolling window, e.g. last 30 daily runs kept then pruned. Adjustable.
  - **Cost, checked 2026-07-06**: current DB is 18 MB for existing canonical data at this instance's
    scale (~3,700 products, 560 sales). Full-fidelity JSONB snapshots would run larger per record;
    rough estimate 50-150 MB per full snapshot at this scale, so ~1.5-4.5 GB for 30 retained daily
    snapshots — still within Supabase Pro's included 8 GB (Pro is $25/mo base, 8 GB DB storage
    included, then $0.125/GB/month — [supabase.com/pricing](https://supabase.com/pricing)). Real
    cost driver would be much larger catalogs or multiple clients, not this instance today.
  - **Explicitly deferred**: restore/write-back, incremental/delta storage, any UI beyond minimal
    backup-run status visibility (no "browse backed-up records" UI planned yet).
  - **Sharpens existing gaps**: storing meaningfully more sensitive client data at rest raises the
    stakes on data retention — the privacy policy/DPA drafts above explicitly flag "no retention
    policy" as unresolved; settle that before this feature goes from scoped to active, since a
    backup feature multiplies exactly the data volume that policy needs to cover.

## Where to look next

- `docs/cin7-api-findings.md` — verified auth scheme, endpoints, rate limits, and every
  Cin7-API-vs-docs discrepancy found so far, with the live evidence for each.
- `supabase/migrations/` — canonical schema, applied in order; `0001` is the org-scoped foundation.
- `src/audit/`, `src/sync/`, `src/import/` — the three main domain areas; each has its own test
  suite (`npx vitest run`) that has caught real logic bugs before shipping more than once — trust
  it, and add cases to it rather than skipping tests when a check feels "obviously right."
