# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Three named audiences (verified current positioning, live marketing copy — `src/app/marketing-home.tsx`, mirrored on the authenticated home page):

- **Implementation partners** — manage every client's Cin7 instance from one console, standardise setups, catch issues before go-live.
- **Multi-entity businesses** — run several Cin7 instances across entities or regions, keep products/customers/suppliers consistent without re-keying.
- **Operations and inventory teams** — own data accuracy, spot what's at risk, fix it in bulk, report on what Cin7 can't natively show.

Framing line the product uses for all three: *"For the people responsible for the data."* Within an org, members hold `owner`/`admin`/`member`; a platform super-admin sits above all orgs.

These are experienced operators doing real, dense operational and financial work (inventory, purchasing, fulfilment, reporting, data correction, Cin7 configuration) — not casual consumer users.

## Product Purpose

Cin7 Core runs inventory well for a single instance but "wasn't built to manage itself" (verbatim landing-page framing): it degrades once an org has more than one instance, or data that has drifted. Cin7 Core Toolbox is a multi-tenant SaaS sitting beside Cin7 Core doing what it cannot do itself — bulk data operations, cross-instance migration, live reporting, planning and workflow tooling. Public tagline: *"Do amazing things that you cannot do in Cin7 Core."*

Named failure modes it addresses: managing one instance at a time (re-keying the same product into multiple entities, which then drift), record-by-record manual cleanup at scale, no early warning before a report/sync surfaces a problem, reports that stop short of the actual question and force an Excel export.

## Positioning

It writes straight to Cin7 Core — the product's own stated trust proposition is: start read-only, log every write, and the customer holds their own Cin7 credentials. This is real, verified behaviour (trial orgs are genuinely blocked from writing to Cin7 for the whole trial; Activity Log records live writes; an org can edit/remove its own Cin7 credentials at any time), not marketing language stretched past what the product does.

## Operating Context

20 registered modules (`src/app/module-nav.tsx`, the single source of truth for the product's feature inventory): 14 org-toggleable (Import & Sync, Templates, Migrate, Reporting, Data Audit, Bulk Pricing, Quotes, Replenish, Purchase Planner, Stocktake Assistant, Picking Calendar, System Health, Cin7 Instances, Activity Log) plus 6 gated by role/plan instead of a module toggle (Admin, Security, Diagnostics, Billing, Team, Notifications). Reporting is itself a hub of 14 routes. Work happens in dense operational tables, bulk-edit forms, and settings/configuration screens — not marketing or content surfaces.

## Capabilities and Constraints

- Next.js 16.3.0 (App Router, Turbopack), React 19.2.4, TypeScript 5.9.3, Tailwind 4.
- Authorization is layered and enforced server-side (org resolution → module gate → billing/write-eligibility gate → role/assurance gate); the UI's job is to communicate these states clearly, never to be the enforcement itself.
- Four Cin7-write action families currently require a live second-factor (AAL2) step-up before completing; nine others are member-permitted with no extra assurance. This distinction is a real product fact the UI must keep legible.
- A trial org is fully read-only for anything that writes to Cin7, for the whole trial — not just after it expires.
- The app is desktop-only today with no responsive shell — this is a genuine current limitation, not a preserved feature.

## Brand Commitments

- Product name: **Cin7 Core Toolbox** (the repository is still named `cin7core-feeder`; the product name is authoritative).
- Public tagline, used identically on the marketing page and the authenticated dashboard: *"Do amazing things that you cannot do in Cin7 Core."*
- Explicit negative-positioning statement, footer: *"An independent tool — not affiliated with, or endorsed by, Cin7."* — never presented as a Cin7 product or official integration.
- Existing brand asset pack at `public/marketing/branding/` (favicons, PWA icons, horizontal + mark logo variants for light/dark) and a maintained module-icon system in `module-nav.tsx` — real, deliberate design work already in place, not a placeholder to discard.
- Typeface: Geist Sans / Geist Mono, already in use — retained.

## Evidence on Hand

No testimonials, customer logos, or case studies exist anywhere in the current marketing or app copy — confirmed by direct search. None should be fabricated for the reskin.

## Product Principles

1. The product is powerful because it can change real records across a customer's live Cin7 instances — trust and legibility of consequence (what's editable, what's destructive, what needs a step-up) are load-bearing, not decorative.
2. Every feature closes a specific, named gap in native Cin7 Core administration — the UI should keep that operational specificity, not generalize into a consumer dashboard.
3. Users are experienced operators working with dense information under real time pressure — scanability and data density outrank visual flourish.
4. Source-of-truth boundaries (what Cin7 owns vs. what the Toolbox owns) are a real product fact, not a UI nicety, wherever they're currently surfaced.
5. "Your instances, your keys" — the org's ownership of its own Cin7 connection is a trust commitment the settings/instances experience should keep visible and clear.

## Accessibility & Inclusion

**WCAG 2.2 AA is the required target** (explicit product decision, confirmed 2026-09-04, superseding an earlier lighter-touch answer given before the full reskin brief was provided). Current baseline is well below this bar — no visible focus indicators on ~48 form fields, zero `aria-invalid`/`aria-describedby`, zero `sr-only` usage, no in-app reduced-motion handling, table headers without `scope`. These are treated as genuine reskin work, built into shared primitives rather than patched page by page.
