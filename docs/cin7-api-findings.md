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

## 3. Assembly BOM — corrected 2026-07-03: there is NO separate endpoint
Originally assumed a dedicated `BillOfMaterials` endpoint per earlier indexed-search evidence.
**That was wrong.** A live test against `PUT /BillOfMaterials` redirect-looped (never 404'd,
which is what tipped us off — same signature as the earlier wrong `/ProductionBom` guess).
Confirmed via two independent sources — a raw transcription of Cin7's Apiary spec
(github.com/nnhansg/dear-openapi) and a generated C# client
(github.com/FalconEyeSolutions/CIN7-DearInventory, whose `ProductApi.cs` has no BOM-specific
file, only `Product`) — **BOM fields live directly on the `Product` resource** and are set via
the same `POST`/`PUT /Product` call already used for the product's core fields:
`BillOfMaterial: true`, `BillOfMaterialsProducts: [...]`, `BillOfMaterialsServices: [...]`,
read back via `GET /Product?...&IncludeBOM=true`. Each BOM line's component may be referenced by
either `ComponentProductID` (Cin7 GUID) or `ProductCode` (SKU) — we use SKU, avoiding the need to
resolve a component's Cin7 ID first. `src/cin7/assembly-bom.ts` now just builds these fields;
`src/cin7/products.ts`'s `pushProduct` merges them into the Product payload — there's no longer
a separate push step or 100-per-batch concern (each product's BOM travels with its own
create/update call).

## 4. Production BOM — confirmed available via API (important correction)
The original client proposal (see `docs/Casa_das_Natas_Architecture_Proposal.docx` appendix)
assumed *"Assembly BOMs will suffice for initial manufacturing"* and that advanced production
wasn't scoped. **That assumption doesn't hold** — Cin7 exposes a Production BOM resource at
both the Product and Product Family level: `GET`/`POST` (with an `OverwriteExistingProductionBOM`
flag)/`PUT`/`DELETE`.

**Path corrected 2026-07-03** after a live test against `/ProductionBom` returned an HTML 200
(not JSON — the first sign the path was wrong). Confirmed via a primary-source transcription of
Cin7's own Apiary spec (github.com/nnhansg/dear-openapi, `specification/dearinventory.apib`):
the real path is **`/production/productionBOM`** (nested under `production/`, camelCase
`productionBOM`), and it's addressed by the product's Cin7 **ID** (GUID) via a `ProductID` query
param/body field — **not SKU**. `src/cin7/production-bom.ts` and `src/sync/run-sync.ts` now
resolve a product's `cin7_id` from `sync_state` (set when the product itself was synced) before
attempting its Production BOM push; if the product hasn't been synced yet, the BOM push fails
with a clear "no synced Cin7 ID yet" error rather than guessing.

**Body shape confirmed 2026-07-03** via a live 400 response: `{"ErrorCode":400,"Exception":
"Required attribute ProductionBOMs is not provided."}`. The POST/PUT body must be wrapped as
`{"ProductionBOMs": [...]}` — an array, matching `/BillOfMaterials`'s batch style — not a flat
object as first assumed. `src/cin7/production-bom.ts` now wraps accordingly.

**`Position` field confirmed 2026-07-03** via a further live 400 (`"Required property 'Position'
not found"` on `Operations[0]`, `Operations[0].Components[0]`, and `Operations[0].Resources[0]`):
every entry in the `Operations`, `Components`, and `Resources` arrays needs its own 1-indexed
`Position` field — separate from our semantic `OperationSequence` string.

**`BufferPercent`/`IsDefault`/`Order`/operation `Name` confirmed 2026-07-03** via further live
400s — `BufferPercent` and `IsDefault` map to columns we already store
(`production_bom_versions.buffer_percent`/`version_default`); `Order` is a separate required
integer alongside `Position`; operations also want a bare `Name` field (kept alongside
`OperationName` since it's unverified which one Cin7 actually reads).

**BLOCKING GAP — not yet resolved:** the same round of testing also revealed
`Operations[].WorkCenterID` and `Operations[].Resources[].ResourceID` are **required GUID
references** to Cin7's own Work Centre and Resource master data — not the text codes
(`work_centre_code`, resource `item_code`) our schema stores. We have no lookup, matching, or
sync for Work Centres/Resources at all. Until that's built, Production BOM pushes will keep
failing on these two fields specifically. This is real, separate scope — a "find or create Work
Centre by name" and "find or create Resource by name" flow, analogous to `findProductBySku` — not
another quick field-name fix.

**Still unverified beyond the above:** whether there are further required fields once
WorkCenterID/ResourceID are resolved.
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

## 9. Raw network failures — `src/cin7/http.ts` now retries and surfaces the real cause
A live test hit a recurring "Network error: fetch failed" on `/BillOfMaterials` with no further
detail. Two fixes: (1) a raw fetch failure is now retried like a 503 (transient network issues
get the same backoff chance a rate limit does), and (2) the final error, if retries are
exhausted, includes the request's method/path and Node's underlying `cause` (e.g. `ECONNRESET`)
instead of just "unknown" — a bare "fetch failed" gave no way to tell a transient blip from a
structural bug.
Documented status codes: 200, 400 (validation), 403 (auth failure), 404 (bad endpoint), 405
(method not allowed), 500 (unexpected/parse error), 503 (rate limit).

## Before building `src/cin7/`
1. Get a Cin7 Core sandbox/trial account (per the original README's own recommendation).
2. Confirm the Production BOM payload shape and the Category/UOM write behaviour against it.
3. Build the rate limiter around 60/min + 503 handling, not 429/Retry-After.
