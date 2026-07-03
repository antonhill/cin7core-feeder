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

**Exact field schema confirmed 2026-07-03** directly from the C# client's model source
(`ProductPutRequestBillOfMaterialsProductsInner.cs`) and the `.apib` spec's "Bill Of Material
Product/Service Model" sections — not inferred from a live error this time, since the earlier
guess (`Wastage`/`WastagePercentage`/`CostAllocationPercentage`) was simply wrong and got a vague
`"BillOfMaterialsProduct is invalid"` rather than a field-by-field breakdown:
- `BillOfMaterialsProducts[]`: `ProductCode` or `ComponentProductID` (one required), `Quantity`
  (required), `WastageQuantity`, `WastagePercent` (mutually exclusive), `CostPercentage`.
- `BillOfMaterialsServices[]`: `Name` or `ComponentProductID` (one required — **`Name`, not
  `ProductCode`**, unlike the Products model), `Quantity` (required), `ExpenseAccount`,
  `PriceTier` (an **integer** on Cin7's side — we only store a tier name/string, so it's omitted
  rather than sent with a type mismatch).
- Parent Product fields **required when `BillOfMaterial: true`**: `QuantityToProduce` (we send
  `1` — an assembly BOM produces one unit of the finished good) and
  `AssemblyCostEstimationMethod` (sent as `"Average Cost"` per the spec's sample value; no enum
  list given, so other accepted values are unverified). `BOMType` is documented **read-only** —
  never send it.
- Empty `BillOfMaterialsProducts`/`Services` arrays are omitted entirely rather than sent as
  `[]`, per neither model requiring the array itself to exist.

**Real root cause found 2026-07-03** via the Settings UI's "Fetch BOM example" diagnostic
(fetches a live product with a working BOM via `GET /Product?...&IncludeBOM=true`): even after
the field-name fix above, the vague `"BillOfMaterialsProduct(s) is invalid"` error persisted. The
live example showed every `BillOfMaterialsProducts`/`Services` line carrying **both**
`ComponentProductID` (Cin7 GUID) **and** `ProductCode`/`Name` (SKU) — we had only ever sent the
SKU. `src/cin7/products.ts` now has `resolveComponentIds()`, which resolves each BOM line's
component SKU to its Cin7 ID (via the same `findProductBySku` lookup, cached across a sync run —
same pattern as Production BOM's `cin7IdBySku`) before building the payload. A component not yet
synced to Cin7 simply falls back to SKU/Name alone, which the spec says should also work.

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

**Work Centre/Resource lookup built 2026-07-03.** `Operations[].WorkCenterID` and
`Operations[].Resources[].ResourceID` are required GUID references to Cin7's own Work Centre and
Resource master data. Endpoints confirmed via the same two sources (github.com/nnhansg/dear-openapi,
corroborated by github.com/FalconEyeSolutions/CIN7-DearInventory):
- **Work Centre** — `GET /production/workcenters?Page=1&Limit=100&Name=<code>` (list/search by
  name prefix; `Code` returned so filter client-side), `POST /production/workcenters` (body
  `{"Workcenters":[...]}`) to create. Creation is **safe to auto-do**: minimal required fields are
  just `Code`, `Name`, `IsActive`, `IsCoMan: false`, `IsCoManPurchase: false`,
  `WorkCenterLocations: []`. `src/cin7/work-centres.ts`'s `resolveWorkCentreId` looks up,
  auto-creates if missing.
- **Resource** — `GET /production/resourceList?Page=1&Limit=100&Name=<code>`,
  `POST /production/resource` (body `{"Resources":[...]}`). Creation is **NOT auto-done** —
  required fields are `Name`, `ResourceType` (`Labor`/`Machine`/`Other`), and `CycleDuration` (int
  seconds), none of which our schema models, and critically: a `Labor`-type resource's `Name` must
  be a registered Cin7 user's email, which can't be inferred from a code like `LAB1`. Guessing
  wrong risks creating a broken or wrongly-typed resource in the customer's account.
  `src/cin7/resources.ts`'s `resolveResourceId` only looks up — it throws a clear, actionable error
  ("create it manually in Manufacturing > Resources") if the resource doesn't exist yet, rather
  than guessing.

Adding explicit `Page`/`Limit` query params (the generated C# client always sends all three
together, never `Name` alone) was a reasonable next fix given the same "200 but HTML body"
signature as the earlier `/ProductionBom`/`/BillOfMaterials` path mistakes — but it **did not**
resolve it. `src/cin7/http.ts`'s "200 but non-JSON body" error (includes method/path) is what made
all of this diagnosable at all.

**PAUSED 2026-07-03 — likely an external limitation, not a bug in our code.** A live probe
(`src/cin7/debug.ts`'s `probeWorkCentrePaths`) tried 8 casing/nesting variants
(`/production/workcenters`, `/production/workCenters`, `/production/WorkCenters`,
`/production/Workcenters`, `/production/workcentres`, `/production/workCentres`, `/WorkCenters`,
`/Workcenters`) against a live account confirmed via screenshot to have real Work Centres
configured (`MIXING`, `BLENDING`, `PACKING`, `CANNING LINE 1`) — **all 8 returned byte-identical
"Page not found" HTML**, right next to `/production/productionBOM`, which works fine on the same
account with the same auth. That rules out casing/path-guessing and deployment staleness (verified
via a forced empty-commit redeploy) as explanations.

Best working theory: `github.com/nnhansg/dear-openapi` and the generated C# client likely
transcribe/target Cin7's **internal frontend API** (the one powering their own Work Centres
settings screen) rather than the **public partner API** (`ExternalApi/v2`) we authenticate against
with `api-auth-accountid`/`api-auth-applicationkey`. Work Centre/Resource management may simply not
be exposed on the public API surface at all, even though ProductionBOM happens to be. If true, no
path fix resolves this — it would need either Cin7 support confirming a real endpoint, or a manual
GUID-mapping workaround (user pastes each Work Centre/Resource's Cin7 GUID once per instance,
found via browser dev tools in the Cin7 UI, since we can't look it up ourselves).

**Decision (2026-07-03):** paused again rather than pursued further — Products and Assembly BOM
are fully working end-to-end, which is the core feeder goal. Revisit only if Cin7 support confirms
API access, or the manual GUID-mapping route becomes worth the setup cost.

Both caches (`ProductionBomRefCaches`) remain shared across a whole sync run in `run-sync.ts`, same
pattern as the product-ID cache used for Assembly BOM component resolution — the plumbing is ready
to use immediately if a real Work Centre/Resource lookup path is ever found.

**Still unverified beyond the above:** whether there are further required fields once
WorkCenterID/ResourceID are resolved.
Worth relaying back to the client/proposal conversation, since it changes what's actually
possible vs. what was scoped.

## 5. Reference-book fields (Category/Brand/UOM) — confirmed (2026-07-03); Accounts/Tax confirmed NOT to auto-create
Confirmed live: POST/PUT `/Product` rejects an unrecognized `Category` (`{"ErrorCode":404,
"Exception":"Category not found."}`) or `Brand` (`{"ErrorCode":404,"Exception":"Brand '...'
was not found in reference book"}`) — unlike Cin7's own UI/CSV bulk-import, which
auto-creates these on the fly, the JSON API does **not**.

Category, Brand, and UOM are all genuine CRUD resources with an identical shape (confirmed
via github.com/nnhansg/dear-openapi's worked examples, corroborated by real wired-up calls
in github.com/FalconEyeSolutions/CIN7-DearInventory's generated client — `RefBrandPost`,
`RefUnitPost`, etc., not just schema definitions):
- **Category**: `/ref/category` — `GET ?Page=&Limit=&Name=` → `{Total, Page, CategoryList: [{ID, Name}]}`; `POST {"Name": "..."}` to create; `PUT {"ID", "Name"}`; `DELETE ?ID=`
- **Brand**: `/ref/brand` — same shape, `Name` max 50 chars
- **UOM**: `/ref/unit` — same shape, `Name` max 50 chars

Each is referenced on the Product payload as a plain Name string, not an ID — so the fix is
to ensure the name exists (GET, then POST if missing) before referencing it on a product
push, not to resolve/store an ID. Implemented generically in `src/cin7/reference-lookups.ts`
(`ensureReferenceExists`, parameterized by path), wired into `pushProduct` for all three.

**Deliberately NOT extended to every reference-book field.** Also researched and confirmed:
- **Tax Rules** (`/ref/tax`) — CRUD exists, but creating one requires an existing liability
  Account code (`Account`, `IsActive`, `TaxInclusive` all required) — too much implicit
  business-logic risk to auto-create blindly.
- **Chart of Accounts** (`/ref/account`, `InventoryAccount`/`RevenueAccount`/`ExpenseAccount`/
  `COGSAccount` on the Product payload) — CRUD technically exists, but **Cin7's own spec
  explicitly states account writes are blocked when Xero/QuickBooks integration is enabled**,
  since the connected accounting system (not Cin7) is the source of truth there. Treat these
  as must-already-exist; a rejection here is a real client config gap to flag, not something
  to paper over by auto-creating a GL account.
- **ProductAttributeSet** (`/ref/attributeset`) — CRUD exists (`Name` + up to 10 attribute
  slots), not yet wired up — no live failure observed for this field yet.
- **WarrantySetupName** — no CRUD endpoint found in either reference repo. Only a
  `WarrantyRegistrationNumber` free-text field exists on fulfilment/packing lines, which is a
  different thing entirely. If Product create ever rejects an unrecognized warranty name,
  that behaviour isn't documented anywhere researched so far — would need live testing.

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
