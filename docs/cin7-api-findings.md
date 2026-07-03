# Cin7 Core API — verified findings

Research pass against Cin7 Core's public API documentation before building `src/cin7/`. The
Apiary spec (dearinventory.docs.apiary.io) is JS-rendered and returned empty on direct/proxied
fetch, so findings below are triangulated from Cin7's own Zendesk help articles
(help.core.cin7.com) plus indexed snippets of the Apiary content. Confidence noted per item —
**confirm anything marked "unverified" against a live sandbox account before relying on it.**

## 1. Auth & base URL — confirmed, and live-tested (2026-07-03)
`GET /Product?page=1&limit=1` with the two headers below succeeded (200) against a real Cin7
Core sandbox account via the Settings UI's "Test connection" button (`src/cin7/client.ts`) —
this is no longer just doc triangulation, it's a verified live call.
Two required headers: `api-auth-accountid` and `api-auth-applicationkey` (set up under
`/ExternalAPI` in the Cin7 Core UI — not OAuth, not Basic Auth).
Base URL: `https://inventory.dearsystems.com/ExternalApi/v2/` — matches what's already
defaulted in `cin7_instances.base_url`, no schema change needed.
v1 (`.../ExternalApi/` without version segment) is deprecated.

## 2. Products — confirmed, no single upsert
`POST /Product` creates, `PUT /Product` updates (matched by `ID` GUID). **There is no
create-or-update-in-one-call** — the caller must look up by SKU first (e.g. filter query) and
branch POST vs PUT. This matches the sync engine design already in the README (match via
`sync_state`, then create-if-absent / update-if-present) — no design change needed, just
confirms the client can't shortcut it.
Errors: array of `{ "ErrorCode": <int>, "Exception": "<message>" }`.

**Live-tested (2026-07-03) and corrected:** `GET /Product?SKU=<sku>&page=1&limit=1` correctly
filters by SKU (confirmed — the returned row's own SKU field matched what was requested).
`PUT /Product` (and presumably `POST`) returns the **same wrapped-list shape as GET** —
`{"Total":1,"Page":1,"Products":[{"ID":"...","SKU":"...",...}]}` — not a bare `{"ID": "..."}`
object as first assumed. `src/cin7/products.ts` now reads the ID from `Products[0].ID`.

## 3. Assembly BOM — confirmed
Dedicated `BillOfMaterials` endpoint (`/BillOfMaterials/{ProductID}` and bare
`/BillOfMaterials`). `PUT` batch-supports create/update/delete of BOM components and services
for **up to 100 products per call**, keyed by SKU/ProductID. Response includes a per-product
`OperationStatus` + `Errors` array — the sync engine should plan to batch by 100 rather than
one call per product.

## 4. Production BOM — confirmed available via API (important correction)
The original client proposal (see `docs/Casa_das_Natas_Architecture_Proposal.docx` appendix)
assumed *"Assembly BOMs will suffice for initial manufacturing"* and that advanced production
wasn't scoped. **That assumption doesn't hold** — Cin7 exposes a `ProductionBom` resource at
both the Product and Product Family level:
- `GET` — list Production BOMs for a product/product family
- `POST` — create (with an `OverwriteExistingProductionBOM` flag)
- `PUT` — update
- `DELETE` — remove

So our `production_bom_versions`/`operations`/`items` schema **can** eventually sync out to
Cin7, not just live in the hub. **Unverified:** the exact field-level payload shape for
operations/routing/work-centres/resources — searches confirmed the CRUD surface but not a full
field dump. Confirm against a sandbox before building `src/cin7/production-bom.ts`.
Worth relaying back to the client/proposal conversation, since it changes what's actually
possible vs. what was scoped.

## 5. Categories / UOM / Price Tiers — partially unverified
`ProductCategories`, `ProductBrands`, `UnitsOfMeasure` appear as their own GET endpoints, and
also as embedded fields on the Product payload. `PriceTier` has its own endpoint (list all
sale price tiers). **Unverified:** whether Category/UOM support POST/PUT as first-class
resources, or are read-only reference lookups you must match by name rather than create.
Confirm before assuming the sync engine can create a missing category/UOM in Cin7 on the fly.

## 6. Pagination — confirmed
`page` + `limit` query params (e.g. `/Product?page=5&limit=200`). Default page size 100,
min 1, max 1000. Documented for Customers, Suppliers, Products, ProductFamilies,
ProductAvailability, Sales — not necessarily every endpoint.

## 7. Rate limits — confirmed (corrects `.env.example`/README assumption)
**60 calls/minute per API Application**, plus an unspecified daily cap. Exceeding it returns
**HTTP 503** (not 429) with `"You reached 60 calls per minute API limit."` — **no documented
`Retry-After` header.** The README/`.env.example` currently mention honouring "429 +
Retry-After"; the sync engine's backoff logic needs to key off 503 instead, with a fixed/backoff
delay rather than reading a header. `RATE_LIMIT_RPS=2` (~120/min) in `.env.example` is actually
*above* the real 60/min limit and should be tightened to ~1/sec with a token-bucket queue.

## 8. Response/error format — confirmed
Success: JSON object(s). Errors: `{ "ErrorCode": <int>, "Exception": "<message>" }[]`.
Documented status codes: 200, 400 (validation), 403 (auth failure), 404 (bad endpoint), 405
(method not allowed), 500 (unexpected/parse error), 503 (rate limit).

## Before building `src/cin7/`
1. Get a Cin7 Core sandbox/trial account (per the original README's own recommendation).
2. Confirm the Production BOM payload shape and the Category/UOM write behaviour against it.
3. Build the rate limiter around 60/min + 503 handling, not 429/Retry-After.
