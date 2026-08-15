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
- **Reporting hub** (`/reports`), restructured 2026-07-07 into a single org-toggleable "Reporting"
  module covering multiple report types, each its own route under `src/app/reports/<name>/`, with a
  shared `layout.tsx` (one `ModuleHeader` banner) + `ReportsNav.tsx` (secondary pill-tab nav,
  active-tab logic keyed off `pathname`) so adding a report is just a new route + one line in
  `REPORT_TABS` — no new top-level nav/home-tile entry needed, since disabling "Reporting" in
  `/admin`'s per-org visibility now blocks every report under it in one place.
  - **Sales** (`/reports`, the hub's default/index route): two-phase sales sync (cheap paginated
    list scan queues new/changed sales, then a rate-limited detail phase pulls line items +
    `AverageCost`, since Cin7's Sale API has no bulk line-item endpoint) + a pivot grid matching
    Cin7's own native pivot report layout + Excel export (`exceljs`, not `xlsx`/SheetJS — see below).
  - **Assemblies** (`/reports/assemblies`, moved here 2026-07-07 from a short-lived standalone
    `/assemblies` module): every assembly build pulled live via the same `fetchAllFinishedGoodsList`
    already used by System Health, filterable by Draft/Authorised/In Progress/Completed (checkboxes,
    all on by default) plus a name/number search. **VOIDED is deliberately excluded from the filter
    set entirely, not just unchecked** — a real 5th status Cin7 uses for cancelled assembly records,
    but this report is about builds still relevant to the business, not a cancellation log. No
    domain-logic module of its own — unlike Audit/Health, there's no flagging rule here worth
    unit-testing, just a live pull + client-side filter/search, so `actions.ts` fetches and
    `page.tsx` filters directly. **Quantity + total BOM cost**, confirmed live via a diagnostic
    (`findFinishedGoodsExample` in `src/cin7/debug.ts`, wired to a "Fetch Assembly (FinishedGoods)
    example" button on `/settings/instances`): both `Quantity` and `UnitCost` are already present
    on the **list** response itself, no per-record detail call needed (avoids an N+1 rate-limit
    cost). Total cost = `Quantity * UnitCost` — matched the detail endpoint's
    (`/finishedgoods?TaskID=`, also confirmed live) `OrderLines[].TotalCost` sum exactly on the one
    real example checked, though only against a `Quantity: 1` record, so the multiplication is the
    conventional reading, not independently verified against `Quantity > 1` — revisit if that ever
    looks wrong on real data. The page shows quantity + total cost per row plus a summed total
    across the current filter. **Per-assembly component detail added 2026-07-07**: clicking a row
    expands it (on-demand `fetchFinishedGoodsDetail`/`/finishedgoods?TaskID=` call, only for that
    one row — not fetched eagerly for the whole list, to avoid an N+1 rate-limit cost) showing two
    tables — **Components (planned)**, from `OrderLines[]` (sums to the *estimated* cost), and
    **Actual consumption**, from `PickLines[]` (`Quantity * Cost` per line sums to the *actual*
    cost) — these two totals can genuinely differ if wastage or substitution happened during the
    real build. **Resources/additional costs (labor, overhead) are NOT shown — not confirmed to
    exist on this resource at all.** Product's Assembly BOM *definition* has a parallel
    `BillOfMaterialsServices[]` (assembly-bom.ts), but whether a *built* assembly's own detail
    response carries a matching services/resources array is unconfirmed — the one live example
    checked had no services attached to its BOM, and Cin7 appears to omit empty arrays rather than
    send them empty, so absence there doesn't prove absence generally. Added a new diagnostic,
    `surveyFinishedGoodsFields` (`src/cin7/debug.ts`, "Survey Assembly fields (resources/services?)"
    button on `/settings/instances`) — scans several assemblies across different products and
    reports the union of every field seen, specifically to catch a services/resources key that only
    shows up on some records. The UI's detail panel says this limitation out loud rather than
    silently omitting it.
- **Data Audit** (`/audit`): pulls a chosen instance's products live and flags missing
  Brand/sales-pricing/inventory-setup/GL-accounts, near-duplicate Category/UOM/Tag values
  (Levenshtein-based), incomplete `AdditionalAttribute1-10` values within a category (with a
  copy-from-template bulk fix), and lets you bulk-toggle Sellable. All fixes write **directly to
  the audited Cin7 instance** — no canonical-DB detour, by design. **Extended to
  Customers/Suppliers, 2026-07-07** (`src/audit/party-audit.ts`): a Products/Customers/Suppliers
  tab selector shares the same instance picker. Checks: no named contacts, no contact email, no
  contact phone/mobile, missing TaxNumber, an existing address missing Country/Postcode (parties
  with zero addresses aren't flagged — nothing to check yet), plus Tags/SalesRepresentative/
  DefaultLocation **for Customers only** — confirmed absent from Supplier's real Cin7 field set
  entirely (`docs/cin7-api-findings.md` §10), not just unchecked. Only Tags/SalesRep/Location get
  a bulk-fix control (`src/audit/apply-party-fixes.ts`, same "PUT just the ID + changed field(s)"
  convention as Product) — Contacts/Email/Phone/TaxNumber/address fields are inherently
  per-entity, so those stay report-only, same reasoning as Product's `missing_sales_pricing`.
- **Auth**: Supabase Auth via a typed 6-digit OTP code (not magic links — M365's Safe Links
  pre-consumes link-based codes before the user clicks, so any future email-code auth on an M365
  tenant should go straight to OTP entry). `/admin` (gated by a `super_admins` table) lets Anton
  create orgs and invite users — that invite-only path still exists unchanged, alongside the new
  self-serve signup below.
- **Self-serve signup + 7-day trial, 2026-07-07 (Phases 1–2 only — no payment provider yet).**
  `/signup` (public) is the same 2-step OTP UI as `/login` plus an org-name field, but **creates the
  org only after OTP verification succeeds**, not before — creating it first would let an attacker
  flood `organizations` with rows tied to unverified emails, each starting a real trial clock for
  free. `createSelfServeOrgAction` (`src/app/signup/actions.ts`) is a new, separate action from
  `admin/actions.ts`'s `createOrgAndInvite` (which stays super-admin-gated, invites *someone else*)
  — this one is self-initiated by an already-verified user creating their own org.

  Schema (migration `0023_billing_and_trials.sql`, applied live): `organizations` gains
  `subscription_status` (enum: `trialing`/`active`/`past_due`/`canceled`), `trial_ends_at` (defaults
  to `now() + 7 days`), `max_instances` (defaults to 1), and **provider-agnostic**
  `billing_provider`/`billing_customer_id`/`billing_subscription_id` (deliberately no
  `paystack_`/`stripe_` prefix — Paystack vs Lemon Squeezy vs other is not decided yet; whichever is
  chosen later populates these without a schema rework). **The migration backfilled every
  already-existing org (Casa das Natas, Spark Demo Test) to `active`/unlimited instances** — without
  that, the new column defaults would have "expired" every real client the moment the migration
  applied. Confirmed correct via `execute_sql` immediately after applying.

  Feature gating (`src/lib/billing.ts` — `getBillingStatus`/`requireWriteAllowed`, both org-scoped,
  no shared state with `requireCurrentOrg()` on purpose so read-only actions never have to opt out
  of anything): **write-back-to-Cin7 actions are blocked for the entire trial**, not just once
  `trial_ends_at` passes — `pushToCin7Action` (`src/app/import/actions.ts`, also what `/migrate`'s
  push step calls) and all 7 of `src/app/audit/actions.ts`'s write actions (`applyProductFixesAction`,
  the 4 merge actions, `applyAttributeTemplateAction`, `applyPartyFixesAction`) now call
  `requireWriteAllowed(orgId)` right after `requireCurrentOrg()`. `past_due`/`canceled` reuse the
  same gate as trial — a lapsed subscription degrades to the same read-only state, regardless of
  which provider eventually reports the lapse. Read-only actions (audit/health scans, Reports,
  Templates, Activity Log) are untouched. Instance cap enforced in
  `settings/instances/actions.ts`'s `upsertInstance` insert branch (count vs. `max_instances`).

  UI: `getCurrentUserInfo()` gained two scalar fields (`subscriptionStatus`/`trialEndsAt`, not a
  nested object, to minimize churn on this widely-called function) so `layout.tsx` can show a
  persistent amber trial banner ("Trial — N days left..."). `/import`, `/migrate`, `/audit` each
  fetch billing status once via a new `getBillingStatusAction()` (`src/actions/billing.ts`) and
  disable their write buttons + show an inline "Available on a paid plan" note — `/audit`
  specifically has 8 separate write-button call sites (all already shared one `isApplying` prop, so
  gating became `isApplying={isApplying || !canWrite}` at each site rather than threading a new prop
  through every sub-component).

  **Deliberately not built**: any payment provider integration, the `/pricing` marketing page (needs
  real copy/price, which need the provider decision first), abuse prevention for the fully-public
  `/signup` (rate limiting, disposable-email blocking — flagged as a real risk, not solved),
  trial-expiry automation (a stale trial just stays `trialing`, blocked from writes, indefinitely —
  fine for v1), and the `docs/legal/subprocessors.md` update (needs a real provider chosen first).
  **Open item, not verifiable in this environment**: whether `signInWithOtp` on a genuinely
  brand-new email implicitly creates the `auth.users` row before OTP verification, depending on this
  Supabase project's Authentication → Providers → Email settings — check against the real project
  before relying on the verify-then-create ordering being airtight.

  **Real bug, found by Anton's first live test (2026-07-07): signup looked "stuck on Verifying…"
  even though the org was actually created — only a manual refresh showed it worked.** Two issues,
  both fixed:
  1. `createSelfServeOrgAction` called `redirect("/")` for the "already a member" edge case
     **inside a try/catch** — `redirect()` throws internally, and that catch block silently
     swallowed it as a generic error instead of navigating. Not what Anton actually hit (he was a
     first-time signup, a different branch), but a real landmine for anyone re-visiting `/signup`
     after already converting. Fixed by removing `redirect()` entirely — that branch now just
     returns `{ ok: true }`, since the client already redirects home on any successful result.
  2. **The actual cause**: both `/signup` and `/login` redirected after a fresh sign-in with
     `router.push("/"); router.refresh();` — a client-side soft transition. Right after
     establishing a brand-new session, this doesn't reliably pick up the just-set session cookie
     before rendering (a known Next.js App Router + Supabase SSR rough edge) — the page looks
     stuck because middleware/the layout still see an unauthenticated state until something forces
     a real request. A manual refresh does exactly that, which is why it "worked after refreshing."
     Fixed on **both** pages by switching to a hard navigation, `window.location.href = "/"` —
     forces a full request through middleware with the cookie already set, no ambiguity. `/login`
     had the identical latent bug (same pattern) even though it wasn't the one reported; fixed for
     consistency since the underlying fragility was the same.

  **Second real bug, same day, found immediately after re-testing the fix above**: Anton went to
  `/signup` a second time (to start a "new" trial) while still signed in from the first — the
  *previous* org's trial banner rendered on top of the fresh signup form, and
  `createSelfServeOrgAction` would have silently discarded the org name he typed and reused his
  existing membership instead (per the fix in item 1 above — "already a member" just returns
  success and redirects home to the *old* org). **Root cause: `/signup` never checked whether the
  visitor was already signed in.** `/login` already redirects an authenticated user straight home
  rather than showing the form again — `/signup` needed the identical treatment. Fixed in
  `middleware.ts` by folding `/signup` into that same existing redirect-home check. You can't have
  two accounts active in one browser session; signing out first is the correct way to test a
  second trial, not re-visiting `/signup` while still logged in.
- **Org switcher, 2026-07-07**: a super-admin can view/act as **any** org, not just ones they're an
  explicit `org_members` row for — Anton's explicit ask ("access any organisation as the master
  user"), confirmed via `AskUserQuestion` over the alternative (member-only switching). Selection
  is a cookie (`impersonated_org_id`, `src/lib/org-switch.ts`), always re-verified against a real
  `super_admins` check before being honored — the cookie is only ever a "which org" hint, never an
  authorization grant on its own, so tampering with it as a non-super-admin gains nothing.
  `requireCurrentOrg()` (`src/lib/current-org.ts`) and `getCurrentUserInfo()` (`src/actions/auth.ts`)
  both check impersonation first, falling back to the normal `org_members` lookup. **`middleware.ts`'s
  disabled-module block-check also had to be updated** — it derives its own `org_id` independently
  (doesn't call `requireCurrentOrg()`), so without this fix a super-admin impersonating org B would've
  had org A's (their real membership's) module-visibility settings wrongly applied while viewing org
  B. UI: `OrgSwitcher.tsx` (a `<select>` in the sidebar, super-admin only, lazy-loads the full org
  list once per page load) + a persistent amber "Viewing as X (master user)" banner with an Exit
  button (`clearImpersonatedOrgAction`) in the root layout — deliberately prominent, since this lets
  live writes reach a client's actual Cin7 instance while impersonating and losing track of which
  org you're in would be a real mistake to make invisible. **Not fully exercised live in this
  session** (no real super-admin session available in the sandbox) — verified via `tsc`/`eslint`/
  `vitest`/`next build` plus an actual production-server request (`next start` + curl), which
  confirms both touched `"use server"` files evaluate cleanly at runtime, not just at build time
  (this codebase's standing rule — a bad export crashes the whole module only at request time).
  Worth Anton clicking through the real switcher once deployed to confirm the UI itself.
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
- **Public Privacy Policy page, 2026-07-07**: `/privacy` (added to `PUBLIC_PATHS` in
  `middleware.ts`, no sidebar — same standalone treatment as `/login`) renders a client-safe copy
  of `docs/legal/privacy-policy.md`, with a visible "Draft — pending legal review" banner. This is
  a **separate, hand-written copy**, not a live render of the `.md` file — the `.md` file is the
  internal working draft for attorney review and still has bracketed placeholder notes (retention
  period, cross-border-transfer justification) that read as unfinished TODOs; the live page phrases
  those honestly as "still being finalized" instead. Keep both in sync by substance when either
  changes — the `.md` file remains the source of truth for anything not yet decided. Linked from
  the login page footer and the sidebar footer (below Sign out).
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

## Authorization / RLS matrix (Phase 0.3–0.4, 2026-08-11)

App authorization is enforced **inside Server Actions** (the primary boundary);
RLS is defense-in-depth for the anon-key path. Most writes run through the
service-role client, which **bypasses RLS** — so RLS matters most for what a raw
authenticated (anon-key) session could do directly if it skipped the app.

Helpers: `is_org_member(org_id)` (0001); `is_org_admin(org_id)` (0052 — role in
('owner','admin')).

| Resource | App-action guard | RLS write | RLS read |
|---|---|---|---|
| `cin7_instances` | `requireOrgAdmin` (0.2) | owner/admin (`is_org_admin`, 0052) | owner/admin — app reads via service-role; **no member read of Account ID / encrypted key** |
| `purchase_planner_settings` | `requireOrgAdmin` | owner/admin (`is_org_admin`, 0052) | member — a non-sensitive shared business default |
| `custom_reports` | `requireCurrentOrg` (members save their own reports) | member — **intentional** | member |
| `pull_jobs` / `push_jobs` | `requireCurrentOrg` (member-initiated migrate/import) | member — **intentional** | member |
| canonical data (`products`, `price_tiers`, `customers`, `suppliers`, BOMs, …) | `requireCurrentOrg` | member | member |

Migration **0052** fixed the only two write policies whose name/comment said
admin-only but checked `is_org_member`. `custom_reports` and `pull_jobs` are
member-managed by design (their actions authorize with `requireCurrentOrg`), so
their member-level RLS is correct, not a mismatch. RLS behaviour is verified by
`supabase/tests/0052_org_admin_rls.test.sql` (transactional, rolls back — run it
against the DB after 0052 is applied).

## Module-access enforcement inside Server Actions (Phase 1.1–1.2, 2026-08-11)

Module visibility (`organizations.disabled_modules` per-org; `org_members.allowed_modules`
per-member) was historically enforced only in the nav (cosmetic) and in
`middleware.ts` (blocks direct URL navigation by matching `request.nextUrl.pathname`).
A **Server Action is a POST whose path is the referer page, not the action's own
module**, so the middleware path check can be routed around — an action's
`requireCurrentOrg()` proves org membership but not "allowed to use THIS module".

**`src/lib/authorization.ts`** (Phase 1.1) closes that gap:
- `requireModuleAccess(moduleHref)` — member + module-visibility check, reusing
  `computeEffectiveDisabledModules`/`findBlockedModule` from module-nav so the action
  gate and the URL gate can't drift. Super-admin bypasses the per-user allow-list but
  is still bound by the org's `disabled_modules` (parity with middleware); impersonation-aware.
- `requireModuleWrite(moduleHref)` = `requireModuleAccess` + `requireWriteAllowed` (billing
  write-plan gate) — the guard for Cin7-write actions.

Capability → guard: `reports.read`→`requireModuleAccess`; `imports.run`/`products.write`/`sync.run`→`requireModuleWrite`; `instance.manage`/`team.manage`/`billing.manage`→`requireOrgAdmin` (+`requireModuleAccess` where the module is org-toggleable); `diagnostics.run`→`requireSuperAdmin`.

**Phase 1.2 rollout checklist** — swap each org-toggleable module's actions from bare
`requireCurrentOrg` (reads) / `requireCurrentOrg`+`requireWriteAllowed` (writes) to
`requireModuleAccess(<MODULE>.href)` / `requireModuleWrite(<MODULE>.href)`:

| Module href | Action files | Status |
|---|---|---|
| `/activity` | `activity/actions.ts` | **done (1.1 proof)** |
| `/import` | `import/actions.ts` | **done (1.2)** |
| `/templates` | `templates/actions.ts` | **done (1.2)** |
| `/migrate` | `migrate/actions.ts` | **done (1.2)** |
| `/reports` | `reports/actions.ts` + all `reports/*/actions.ts` sub-routes (cost-estimator, fulfillment-cleanup, shipping-calendar, inventory-movement, stock-health, invoicing-scheduler, assemblies, order-fulfillment, production-tracking, custom, reorder-report) | **done (1.2)** |
| `/audit` | `audit/actions.ts` | **done (1.2)** |
| `/pricing` | `pricing/actions.ts` | **done (1.2)** |
| `/replenish` | `replenish/actions.ts` + `replenish/reorder-points/actions.ts` | **done (1.2)** |
| `/supplier-planner` | `supplier-planner/actions.ts` | **done (1.2)** |
| `/stocktake-assistant` | `stocktake-assistant/actions.ts` | **done (1.2)** |
| `/health` | `health/actions.ts` | **done (1.2)** |
| `/settings/instances` | `settings/instances/actions.ts` | **role-gated (see note)** |

The 1.2 rollout swapped every `requireCurrentOrg()` guard in the 22 files above to
`requireModuleAccess(<MODULE>.href)`, leaving each `requireWriteAllowed(orgId)` line
untouched (so a write action is now module-access + billing-write, exactly as before
plus the module gate — billing behaviour unchanged). ~91 call sites.

**`/settings/instances` — deliberately left role-gated (not a silent defer).** Its
actions use `requireOrgAdmin` (owner/admin), which already excludes *every* member —
and members are the only principals a module allow/deny toggle can restrict. Module-
gating them would only add coverage for the narrow case of an *admin* whose org had the
instances module disabled org-wide invoking an instance action by direct POST (middleware
already blocks that via the URL). Weighed against editing the app's most intricate,
previously-outage-prone `"use server"` file, that marginal gain wasn't worth the risk in
this rollout. Tracked as a small follow-up if strict action-layer parity is wanted.

**`loadPendingPurchaseOrders`** (was exported from `supplier-planner/actions.ts`, making it
a guardless action endpoint) moved to `src/lib/pending-purchase-orders.ts` (server-only, not
an action). Both call sites (`supplier-planner`, `reports/reorder-report`) updated. It only
ever runs with an already-authorized `orgId` + service-role `db` passed by its callers.

Not module-toggleable (keep their existing role/plan/single-org guards, no `requireModuleAccess`):
`/settings/members` (`requireOrgAdmin`), `/settings/billing` (`requireOrgAdmin`), `/admin/*`
(`requireSuperAdmin`), `/reports/natas` (`requireCasaDasNatasOrg`), and the self-scoped
`auth.ts`/`org-switch.ts` actions.

## Mandatory MFA for privileged users (Phase 1.5, 2026-08-12)

`middleware.ts` now forces **privileged** users who have no verified TOTP factor to
`/settings/security?mfa=required` before they can reach anything else (that page is
exempted from the redirect so they can actually enrol, and it carries the app's
sign-out control). Enrolled-but-not-stepped-up users were already sent to
`/mfa-challenge` — this adds the *enrolment* requirement on top.

**Scope = super-admins + owners/admins of orgs with write access** (Anton's decision,
2026-08-12). Read-only **trial orgs are exempt** so trial onboarding isn't gated on
setting up an authenticator app; "write access" is `writeAllowedFor(subscription_status)`
(active only), shared with billing via the new dependency-free `src/lib/billing-status.ts`
(edge-safe — middleware can import it without pulling billing.ts's I/O deps). The
privileged check reuses the reads the module-block already does (added `role` to the
`org_members` select and `subscription_status` to the `organizations` select — no extra
round-trips).

**AAL2-on-billing (deferred from Phase 1.3): satisfied by this middleware enforcement**,
not a per-action check. A paid org's owner/admin — the only principals who can reach
`getManageSubscriptionUrlAction` — is now forced to enrol + step up to AAL2 before any
page loads, so billing management is effectively AAL2-gated. A redundant `assertAal2()` on
the billing actions was deliberately NOT added: it would also have to guard
`getCheckoutUrlAction`, which **trial** owners (MFA-exempt) must use to subscribe — blocking
it there would break the upgrade path.

## Impersonation hardening (Phase 1.6, 2026-08-13)

Super-admin "view as org" (`src/actions/org-switch.ts`, cookie `impersonated_org_id`):
- **Secure cookie in prod** — `secure: NODE_ENV === "production"` added to the cookie set
  (local dev stays plain http). Was `httpOnly`/`sameSite=lax` only.
- **Shorter expiry** — `maxAge` 30 days → **8 hours** (`IMPERSONATION_MAX_AGE_SECONDS`), so an
  impersonation left open by accident reverts the same day.
- **Audit** — `setImpersonatedOrgAction`/`clearImpersonatedOrgAction` now emit a structured
  `[impersonation.start|end]` server log line (actor user id, target org id/name, timestamp).
  Deliberately a **platform log**, not a client-visible `activity_log` row — a super-admin's
  access shouldn't appear in the target org's own Activity feed. A durable, queryable
  super-admin audit table is **Phase 13** (observability) work; this is the no-schema-change
  audit trail for now.
- **Banner** — the "Viewing as {org} (master user)" amber bar + Exit already existed
  (`src/app/layout.tsx`, gated on `isImpersonating`); no change needed.

The cookie remains a "which org" hint only — never an authorization grant. Every read/write
still re-checks super-admin status server-side before honoring it.

## Cin7 distributed rate limiter (Phase 2.1, 2026-08-13)

Cin7 Core enforces **60 calls/min per API application, keyed by `accountId`** (503, no
Retry-After). The old throttle in `src/cin7/http.ts` only paced calls **within one serverless
invocation** — but 6 cron sync routes fire on the same 15-min schedule, plus on-demand syncs,
live Supplier-Planner reports, and migrate/import jobs, all able to hit the same account
concurrently and blow past 60/min from combined volume.

**Fix = a Postgres token bucket** (Anton chose Supabase over adding Upstash — no new infra;
the only cross-invocation store the project has):
- **Migration `0054`** — `cin7_rate_limits` table (one row per `accountId`) + atomic
  `cin7_rate_limit_acquire(account_id, capacity, refill_per_sec)` function (time-based refill
  via `clock_timestamp`, `FOR UPDATE` row lock so concurrent invocations serialize). Returns
  ms-to-wait (0 = granted). RLS on, no policies, EXECUTE revoked from anon/authenticated —
  service-role only. Test: `supabase/tests/0054_cin7_rate_limit.test.sql` (transactional).
- **`src/cin7/rate-limit.ts`** `acquireCin7Slot(accountId)` — calls the RPC, sleeps the
  returned wait (bounded, jittered), returns `true` when it paced the call. **Never throws:**
  on any DB error returns `false`; on `42883` (function missing → migration not applied) it
  latches the distributed path off process-wide.
- **`http.ts`** calls `acquireCin7Slot` before each attempt; if it returns `false` the call
  falls back to the **existing in-memory throttle**, so behaviour is identical to today until
  0054 is applied, and a limiter/DB outage never halts Cin7 traffic. The 503 linear backoff
  stays as the backstop.
- Rate = `RATE_LIMIT_RPS` (default 0.8/s ≈ 48/min, under the 60 ceiling); burst =
  `CIN7_RATE_LIMIT_BURST` (default 5).

Rollout: apply `0054` **before** merging/deploying the code, so the deployed limiter runs
against an existing function (the `42883` latch makes an out-of-order deploy safe regardless).

## Reducing Cin7 API call volume (Phase 3, 2026-08-13)

Recon finding: the suspected per-product N+1 is **already solved** — supplier/component/
reference lookups are memoized per run (`refCache`/`supplierIdCache`/`refCheckCache`/
`cin7IdBySku` in run-sync.ts), and skip-unchanged runs **before** any Cin7 call (an unchanged
row makes 0 calls). So Phase 3 targets the remaining, independent reductions.

**Phase 3.1 (shipped):**
- **Page size 100→1000** on the 5 list endpoints Cin7 documents as `limit` max 1000
  (Products, Customers, Suppliers, Sales, ProductAvailability — `products.ts`, `customers.ts`,
  `suppliers.ts`, `sales.ts`, `product-availability.ts`). Cuts list-phase GETs ~5–10×. Safe:
  the `< pageSize` short-page termination stays correct because these endpoints honour the
  requested limit (never return fewer while more remain). **Deliberately NOT raised** on
  `purchaseList`, `finishedGoods`, `production/orderList`, `categories`, `ref/*` — docs don't
  confirm max 1000 there, and an endpoint that silently caps below the requested size would
  early-terminate the loop and drop rows.
- **Staggered the 6 sync crons** (`vercel.json`) across a 10-min window (`0/2/4/6/8/10` + 15s),
  each still every 15 min — they used to all fire at `*/15` (minute 0/15/30/45) together and
  saturate the per-account 60/min bucket at tick boundaries. Flattens the burst → fewer 503
  retries (each retry is a wasted call).

**Phase 3.2 (shipped):** skip the find-by-key GET when the stored `cin7_id` is known.
`pushProduct`/`pushCustomer`/`pushSupplier` now PUT straight to the stored ID (products via the
already-threaded `cin7IdBySku`; customers/suppliers via `cin7_id` now added to the
`customer_sync_state`/`supplier_sync_state` SELECTs — the column was already written, just not
read back). −1 GET per changed, previously-synced row. **Safety:** on a NON-retryable PUT
failure the stored ID may be stale (row deleted/recreated in Cin7 out of band) → falls back to
the authoritative find→create/PUT path (a genuine payload error recurs there and surfaces). A
RETRYABLE failure (rate-limit/network, already exhausted in http.ts) is re-thrown, NOT doubled
into a second round of calls. No schema change. First-sync/bulk-create paths are unaffected
(no stored ID yet → find→create as before).

**Phase 3 backlog (not yet done):**
- **3.3a** — per-(org,route) in-flight guard (needs a stale-TTL, not a naked flag) to stop
  overlapping cron ticks / user syncs double-scanning.
- **3.3b** — `UpdatedSince` watermark for purchases/assembly-builds/production-orders lists
  (they full-scan history every tick; sales already avoids this). **Blocked on a live Cin7
  probe** — a silently-ignored filter param would drop rows.

## Data integrity — duplicate-write / partial-data (Phase 4, 2026-08-13)

A Phase-4 audit found the **sync engine itself is well-protected** (find-by-key + `content_hash`
+ after-success-only `synced_hash` ordering + unique constraints backing every upsert). The real
holes are the **unguarded external-create paths** — a double-click / two tabs / concurrent
invocation creates duplicate real Cin7 records. Ranked: (1) **duplicate Purchase Order**, (2)
**duplicate Stock Transfer**, (3) concurrent same-org sync (no lock; mostly self-heals), (4)
concurrent job chunks (status read isn't a claim).

**Phase 4.1 (shipped) — PO-creation idempotency:**
- **Migration `0055`** — `po_creation_claims` table + atomic `po_creation_claim(org, instance,
  key, ttl_seconds)` function (INSERT-or-`FOR UPDATE`-reclaim; returns whether the caller may
  create). RLS on, no policies, EXECUTE revoked from anon/authenticated. Test:
  `supabase/tests/0055_po_creation_claims.test.sql` (transactional).
- **`src/lib/po-idempotency.ts`** — `poIdempotencyKey` (sha256 of supplier+location+sorted
  lines/qtys), `claimPoCreation` / `settlePoCreation` / `releasePoCreation`.
- **`createSupplierPlanPurchaseOrdersAction`** (and its reorder-report delegate) now claims each
  group **before** the Cin7 create: a live `completed` claim → returns the existing PO
  (`deduplicated` result field, amber UI note); a live `pending` claim → skipped as `failed`
  ("already being created"); success → settle; failure → release (immediate retry).
- **Fails OPEN**: any guard error (DB down, migration not applied) → proceeds to create exactly
  as before (never blocks the money path on the guard). TTL 15 min — covers double-click /
  retry / concurrent, far short of a legitimate recurring re-order (which the existing
  `supplier_plan_created_po_lines` advisory also flags).

Rollout: apply `0055` before merging (guard fails open until then, so out-of-order is safe too).

**Phase 4.2 (shipped) — Stock-Transfer-creation idempotency:** identical shape to 4.1, applied to
`createReplenishTransfersAction` instead of PO creation.
- **Migration `0056`** — `stock_transfer_creation_claims` table + atomic
  `stock_transfer_creation_claim(org, instance, key, ttl_seconds)` function, same INSERT-or-
  `FOR UPDATE`-reclaim shape as `po_creation_claim` — written with the table-qualified-column fix
  from the start (0055 needed a follow-up migration for this; the `RETURNS TABLE` output params
  share names with the underlying table's columns, so an unqualified `select` is ambiguous). RLS
  on, no policies, EXECUTE revoked from anon/authenticated. Test:
  `supabase/tests/0056_stock_transfer_creation_claims.test.sql` (transactional), plus a live
  `execute_sql` run against the real DB after applying.
- **`src/lib/stock-transfer-idempotency.ts`** — `stockTransferIdempotencyKey` (sha256 of
  fromLocation+toLocation+sorted sku/qty lines — batch/expiry deliberately excluded from the key
  since it's resolved fresh from current stock on each call, not part of the user's selection
  identity), `claimStockTransferCreation` / `settleStockTransferCreation` /
  `releaseStockTransferCreation`.
- **`createReplenishTransfersAction`** restructured from a single top-level try/catch (which lost
  evidence of already-created transfers if a later destination group failed) to per-group
  try/catch, matching the PO action's shape: claims each destination group **before** the Cin7
  create; a live `completed` claim → returns the existing transfer (`deduplicated` result field,
  amber UI note on `/replenish`); a live `pending` claim → skipped as `failed` ("already being
  created"); success → settle; failure → release (immediate retry). `CreateTransfersResult`
  (`created`/`failed`/`deduplicated`) replaces the old bare `CreatedTransfer[]` return — UI
  updated to match Supplier Planner's three-block (amber/green/red) result rendering.
- **Fails OPEN**: any guard error (DB down, migration not applied) → proceeds to create exactly
  as before. Same 15 min TTL as 4.1 — covers double-click/retry/concurrent, short of a genuine
  later replenish of the same lines.

Verified: `tsc`/`eslint`/`vitest` (full suite, 940 tests) clean, `next build` clean, and a
`next start` + `curl` against `/replenish` and `/` confirms the touched `"use server"` file
evaluates cleanly at request time (standing rule #1) — 307 redirect-to-login (unauthenticated,
expected) and 200 respectively, no module-crash errors in the server log.

**Phase 4 remaining:** 4.3 per-(org,instance) advisory lock around syncs (pure code); 4.4
job-chunk claim (`locked_at` column + claiming UPDATE).

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
