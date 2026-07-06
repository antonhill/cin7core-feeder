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
- **No Row-Level Security anywhere** in `supabase/migrations/` — tenant isolation is enforced
  entirely by `requireCurrentOrg()` checks in each server action (the service-role client bypasses
  RLS regardless, so RLS would only be defense-in-depth, but there's currently no DB-level backstop
  if a future action forgets to scope a query by `org_id`).
- **No activity/audit log** on live-write actions (Data Audit fixes/merges, sync push) — nothing
  persists who changed what, when, on a client's live instance.
- **No privacy policy / DPA / subprocessor list** — needed before this can be pitched to
  third-party clients generally (POPIA since Spark is SA-based; GDPR too if a client's Cin7 data
  includes EU customers).

## Where to look next

- `docs/cin7-api-findings.md` — verified auth scheme, endpoints, rate limits, and every
  Cin7-API-vs-docs discrepancy found so far, with the live evidence for each.
- `supabase/migrations/` — canonical schema, applied in order; `0001` is the org-scoped foundation.
- `src/audit/`, `src/sync/`, `src/import/` — the three main domain areas; each has its own test
  suite (`npx vitest run`) that has caught real logic bugs before shipping more than once — trust
  it, and add cases to it rather than skipping tests when a check feels "obviously right."
