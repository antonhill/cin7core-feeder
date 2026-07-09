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

**Confirmed live (2026-07-03): the uniqueness check is case-insensitive.** Creating UOM
"hour" failed with `{"ErrorCode":400,"Exception":"This unit already exists. Unit name must
be unique."}` even though the exists-check (GET, exact-case match) hadn't found it — an
entry differing only in case (e.g. "Hour") was already there, and Cin7's own uniqueness
check treats them as the same name. Fixed by making the exists-check case-insensitive, plus
a belt-and-suspenders catch: any create rejection matching "already exists"/"must be
unique" is now treated as success rather than propagated, since the desired end state (the
entry exists) is already true regardless of the exact mismatch that caused the false
negative.

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

## 5b. Full InventoryList field coverage — added 2026-07-03
Client feedback ("I am concerned that you are not being complete with the template") prompted
a full audit: the canonical schema/CSV model only mapped ~12 of Cin7's ~96 InventoryList
columns. Brand/CostingMethod being missed earlier were symptoms of this, not one-off misses.
Added the remaining ~63 columns to `src/model/products.ts`/`src/cin7/products.ts`, split by
confidence:

- **Push-confirmed** (~36 fields — dimensions, carton info, weight/dimension units, reorder
  levels, `AutoAssembly`/`AutoDisassembly`/`DropShipMode`, the 4 Account fields, attribute
  set, 10 additional attributes, discount/tags/stock-locator, `PurchaseTaxRule`/`SaleTaxRule`
  (previously collapsed into one lossy `tax_code` — same class of bug as `cin7_type`),
  short description, `Sellable`, pick zones, always-show-quantity, internal note, HS code,
  country of origin): every one of these has a confirmed field name from a real live
  GET /Product response, and is now sent on every push. Two write-side field names differ
  from their CSV column names — confirmed live: `DimensionsUnits` (API) vs `DimensionUnits`
  (CSV), and `AttributeSet`/`DiscountRule`/`Tags` (API) vs `ProductAttributeSet`/
  `DiscountName`/`CommaDelimitedTags` (CSV).
- **Capture-only** (~23 fields — `FixedAssetType`, `CartonVolume`, `DropShipSupplier`,
  `AverageCost`, the 8 ProductFamily variant fields, `WarrantySetupName`, `MakeToOrderBom`,
  `IsAccountingDimensionEnabled`, the 10 DimensionAttribute fields): stored from CSV for
  round-trip export fidelity, but deliberately NOT sent to Cin7 yet — no field ever observed
  in a real live GET /Product response, so the risk of guessing wrong (as happened repeatedly
  with Work Centres/Production BOM) outweighs the benefit. `AverageCost` specifically should
  likely never be pushed even once confirmed — it reads as a Cin7-calculated value (from
  costing method + purchase history), not a settable field.
- **Also missing from the initial pass: `Description` itself** — captured on import and
  already in `content_hash` since the first migration, but never actually included in
  `toCin7ProductPayload` (only `ShortDescription` was). Fixed 2026-07-03; confirmed live
  field name matches the CSV column exactly.

## 5c. Supplier fields — confirmed push-confirmed (2026-07-03)
The 4 Supplier CSV columns (`LastSuppliedBy`/`SupplierProductCode`/`SupplierProductName`/
`SupplierFixedPrice`) were originally left capture-only because the live sample product had
`"Suppliers": []` — an array, not flat fields. Researched (same two repos) and confirmed:
Cin7's Product resource carries a nested `Suppliers[]` array, sent in the **same POST/PUT
payload**, confirmed by a real wired-up call in the FalconEyeSolutions C# client's Product
PUT request model (`ProductPutRequestSuppliersInner`), not just a schema definition. An item
is referenced by `SupplierName` (a string) — `SupplierID` (GUID) is the alternative, but
`SupplierName` alone is accepted, no pre-resolution needed. There's no separate
"is-default-supplier" flag in Cin7's model; since the CSV format only supports one supplier
per row anyway, `LastSuppliedBy` is treated as that one supplier's name.

Two of Cin7's real field names differ from the CSV column names:
- `SupplierProductCode` (CSV) → **`SupplierInventoryCode`** (API)
- `SupplierFixedPrice` (CSV) → **`FixedCost`** (API)
- `SupplierProductName` matches exactly on both sides.

A separate dedicated `/product-suppliers` endpoint and a `/supplier` CRUD resource (for
creating a brand-new Supplier/Contact entity) also exist, but aren't needed for this — a
supplier referenced by name inline on the Product payload doesn't require a pre-existing
Supplier record to be resolved first.

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

## 10. Customer & Supplier — confirmed live (2026-07-04), ahead of building push

Researched via the same two community sources used throughout this doc, then confirmed with a
real `GET /customer?page=1&limit=1` and `GET /supplier?page=1&limit=1` against the live "Spark
Demo" sandbox (`src/cin7/debug.ts`'s `findCustomerAndSupplierExamples`, wired to a Settings UI
button) before writing any push code — same rigor as Product/BOM.

**Endpoints confirmed:** `GET/POST/PUT /customer` and `GET/POST/PUT /supplier` (both paths
lowercase). List responses wrap as `{"Total","Page","CustomerList":[...]}` /
`{"Total","Page","SupplierList":[...]}` — same convention as `Products`, different key name per
resource. Matched by `ID` GUID on PUT — no upsert-in-one-call, same as Product.

**Both resources carry nested `Addresses[]` and `Contacts[]` arrays in the same POST/PUT
payload** — there is no separate address/contact endpoint to call. Confirmed live shape for
`Addresses[]` (identical on both resources): `Line1`, `Line2`, `City`, `State`, `Postcode`,
`Country`, `Type` (e.g. `"Billing"`/`"Shipping"`/`"Business"`), `DefaultForType` (bool), `ID`.
Maps directly onto our `supplier_addresses`/`customer_addresses` columns.

**Field name discrepancies vs the CSV column names (import already stores the CSV name
verbatim; the push client must translate):**
- Customer: `SaleAccount` (CSV) → **`RevenueAccount`** (API) — confirmed via a real value
  (`"191"`) present under that key in the live response.
- Customer `Contacts[]` has `JobTitle`; **Supplier `Contacts[]` does not** — confirmed by its
  absence in a real Supplier contact object, matching the community-sourced model docs
  (`SupplierPutRequestContactsInner` has no `JobTitle`, `CustomerPutRequestContactsInner` does).
  Our CSV has a `JobTitle` column for both — harmless to send for Supplier if Cin7 just ignores
  unknown fields, but don't rely on it round-tripping.
- `MarketingConsent` is a **number** in Cin7's real model (seen as `1` live), not the CSV's
  string values (`"Unknown"`/`"Opt in"`/`"Opt out"`) — **no enum mapping confirmed**, so leave
  this capture-only (stored, not pushed) until a real write test (or Cin7 support) confirms which
  integer means what, rather than guessing and silently corrupting a customer's consent flag.

**Update 2026-07-05:** Anton pasted Cin7's own Customers CSV template documentation, which lists
`CreditLimit` as a normal optional numeric field ("Credit limit applied to the customer sales on
order/invoice authorisation... If left blank, then the 0 value is assumed") — that's sufficient
confirmation to turn it on (see `toCin7CustomerPayload`), superseding the "held back" note below
for `CreditLimit` specifically. `IsOnCreditHold` and `ParentCustomer` remain held back: the same
docs list `ParentCustomer` too, but it's "Name of the parent customer" — i.e. still needs
name-to-ID resolution before it can be sent, unlike CreditLimit's straight scalar pass-through, so
it's a genuinely different (unconfirmed) code path, not just caution.

**Present in the live GET response but absent from the community-sourced PUT/POST request
models — capture-only, not push-confirmed:**
- Customer: `IsOnCreditHold`, `CustomerParentID`/`CustomerParentName` (our CSV's
  `ParentCustomer`) — plausible these need a different write path (e.g. a dedicated credit-limit
  endpoint, or name-to-ID resolution for the parent link like Product's `Suppliers[]`), but
  guessing here risks the same wasted round-trip Work Centres cost — confirm via a live 400/200
  before wiring in.
- Both resources: `Carrier` is documented+confirmed for Customer's write model but **absent
  from Supplier's** — our Suppliers CSV has a `Carrier` column; don't send it for Suppliers.
- Both resources: `IsAccountingDimensionEnabled`/`DimensionAttribute1-10` (our CSV has these for
  both) **do not appear in either resource's request model at all** — likely a CSV-bulk-import-only
  feature, same class of gap as Category/Brand auto-create being UI/CSV-only. Don't attempt to
  push these; they're stored for round-trip export fidelity only.

**Update 2026-07-05 — pre-flight reference checks, ahead of building `src/cin7/reference-lookups.ts`'s exists-only helpers.** Confirmed via `github.com/nnhansg/dear-openapi`'s Apiary spec (same source used throughout this doc):
- **Location** — `GET /ref/location?Name={Name}` → `{Total, Page, LocationList: [{ID, Name, ...}]}`. Matched by `Name` (a Customer's `Location` field references this by name, not ID).
- **Company Contacts** (what a Customer's `SalesRepresentative` resolves against — Cin7's own error text literally says "...was not found in Company Contacts reference book") — `GET /me/contacts?Name={Name}` → `{Total, Page, MeContactsList: [{ContactID, Name, Type, ...}]}`. `Type` can be `Billing`/`Business`/`Sale`/`Shipping`/`Employee` — a `SalesRepresentative` should be a contact with `Type: "Sale"` per Cin7's own field docs ("your company contact with the type 'Sales' selected"), but the exists-check here only confirms the *name* exists, not that its Type is specifically `Sale` — a name that exists but isn't typed `Sale` would still pass this check yet could still fail push. Not hit live yet; revisit if it comes up.
- **Chart of Accounts** — same `/ref/account` endpoint already confirmed above, `GET /ref/account?Code={Code}` or `?Name={Name}` → `{Total, Page, AccountsList: [{Code, Name, ...}]}`. Cin7's own docs say an account field accepts "code or name," so the exists-check tries `Code` first, then falls back to `Name`.

Why this exists: confirmed live that Cin7's own `PUT /customer` only reports a handful of validation issues per request — fixing the reported ones (e.g. `Location`) revealed a *different* set on the next push (e.g. `AccountReceivable`) rather than everything at once. These exists-only checks (no auto-create — same "must already exist" treatment as Chart of Accounts elsewhere in this doc) run before the actual push, so every reference-field problem surfaces in one pass instead of a multi-round cycle.

**First hypothesis (2026-07-05, later disproven): thought this was a Xero/QuickBooks-sync limit.** A customer whose AccountReceivable/SaleAccount both appeared to pass the `/ref/account` exists-check still failed the actual push with `"Account with specified ID not found"`. Given Anton confirmed Xero/QuickBooks is connected on Spark Demo, and this doc's own earlier note that account writes route through the connected accounting system, the working theory was that Cin7 needed to resolve the account against Xero/QuickBooks's own internal ID — something outside this project's visibility. To make any future case like this self-diagnosable, `run-sync.ts`'s error path was changed to also carry the untouched raw Cin7 response body alongside the friendly parsed text (`describeError` returns `{lines, raw}` instead of just `string[]`), surfaced as a collapsed "raw response" detail per error in the Import page's UI.

**Real cause, found 2026-07-06 via a purpose-built diagnostic (`checkCustomerReferenceFields` in `src/cin7/debug.ts`, wired to a Settings-page "Check customer's reference fields" button): this was our own bug, not Xero/QuickBooks at all.** `GET /ref/account?Code=<value>` returns a **400 error** ("Account with specified ID not found") instead of an empty `AccountsList` when the code doesn't match anything — contrary to what the community spec's sample response implies, and different from how `/ref/location`/`/me/contacts` behave (those return an empty list cleanly). `accountExists`'s underlying `cachedFieldExists` didn't handle this — it let the exception propagate, which crashed the pre-flight check mid-sequence, *before* it ever got to assemble the full list of problems or even report the Location/SalesRepresentative issues it had already found. That crash then got caught by the same handler as a genuine push failure, surfacing Cin7's own raw (and unhelpfully vague) error text — which is exactly what made this look like an external Xero/QuickBooks-sync mystery instead of a straightforward bug in our own exists-check. Fixed: `cachedFieldExists` now catches a non-retryable `Cin7ApiError` and treats it as "not found" (`false`) rather than crashing — a retryable error (rate limit, network) still propagates, since that's a genuine infrastructure problem, not a "this value doesn't exist" signal. **Lesson: an exists-check's own lookup call needs the same defensive error handling as anything else hitting a live API — don't assume a reference-book GET always degrades to an empty list on no-match.**

**Update 2026-07-06 — PaymentTerm pre-flight check added, Currency confirmed unavailable.** Found via a real broken supplier test file (`PaymentTerm: "cashe"`, non-blank so the existing blank-check couldn't catch it): `GET /ref/paymentterm?Name={Name}` → `{Total, Page, PaymentTermList: [{ID, Name, Duration, Method, IsActive, IsDefault}]}`, confirmed via the same Apiary spec used throughout this doc. Added `paymentTermExists` (`src/cin7/reference-lookups.ts`) and folded it into both the customer and supplier pre-flight checks in `run-sync.ts`, plus the standalone diagnostic tool — full consistency across both entity types. **Searched the entire spec for a Currency reference-book/list endpoint and found none** — Currency is a free-text 3-character field everywhere it appears (Customer, BankAccount, Journal, etc.) with no CRUD group of its own, unlike Location/Tax/PaymentTerm/Account. Left unchecked rather than guessed at an unconfirmed endpoint — same discipline as everywhere else in this doc.

**Two more real bugs found the same day, both via live evidence, not guessing:**
1. **`paymentTermExists` ignored `IsActive`.** Cin7's own push-time error text — `"Active payment term with name cash was not found in Payment Terms reference book"` — literally has the word "Active" in it. A same-named-but-deactivated payment term still shows up in the plain `GET /ref/paymentterm?Name=` list, so an existence-only check said "exists" when the real push correctly rejected it. Fixed: now requires `IsActive !== false` (a missing/undefined `IsActive` still counts as active, per Cin7's own docs — `"True" as default for POST`).
2. **`accountExists` (used for both AccountReceivable and AccountPayable) only checked existence, not the "special account" restriction Cin7's own field docs state** ("Only special account [payable/receivable] accounts are valid for this field"). Confirmed live by comparing two real accounts side by side (new `findAccountsByCodes` diagnostic + Settings-page "Compare account codes" button): code `800` (`Name: "Accounts Payable"`, `SystemAccount: "Accounts payable"`) genuinely works for AccountPayable; code `801` (`Name: "Unpaid Expense Claims"`, `SystemAccount: "Unpaid expense claims"`) exists and shares the **identical** `Type`/`Class` (`CURRLIAB`/`LIABILITY`) with 800, yet is rejected by the real push — `SystemAccount` is the actual discriminator, not `Type`/`Class`. Added `payableAccountExists`/`receivableAccountExists` (`src/cin7/reference-lookups.ts`), which check existence *and* `SystemAccount === "Accounts payable"`/`"Accounts receivable"` respectively; wired into both the AccountPayable (supplier) and AccountReceivable (customer) pre-flight checks and the diagnostic tool. `SaleAccount`/`RevenueAccount` deliberately kept on the plain `accountExists` check — Cin7's docs don't call that one "special."

**Push-confirmed fields (safe to build now):**
- Customer: `Name`, `DisplayName`, `Currency`, `PaymentTerm`, `Discount`, `TaxRule`, `Carrier`,
  `SalesRepresentative`, `Location`, `Comments`, `AccountReceivable`, `RevenueAccount` (←
  `SaleAccount`), `PriceTier`, `TaxNumber`, `AdditionalAttribute1-10`, `AttributeSet`, `Tags`,
  `Status`, `IsLegalEntity`, `IsBillParent`, `Addresses[]`, `Contacts[]` (`Name`, `JobTitle`,
  `Phone`, `MobilePhone`, `Fax`, `Email`, `Website`, `Default`, `Comment`, `IncludeInEmail`).
- Supplier: `Name`, `Currency`, `PaymentTerm`, `TaxRule`, `Discount`, `Comments`,
  `AccountPayable`, `TaxNumber`, `AdditionalAttribute1-10`, `AttributeSet`, `Status`,
  `Addresses[]`, `Contacts[]` (`Name`, `Phone`, `MobilePhone`, `Fax`, `Email`, `Website`,
  `Default`, `Comment`, `IncludeInEmail` — no `JobTitle`).

## 11. Product pre-flight reference checks — added 2026-07-05

Same pre-flight-in-one-pass treatment as Customer/Supplier (§10), extended to Product. Anton
pointed out first that most of Product's optional fields have real, Cin7-documented defaults
when blank (`Type`→`Stock`, `CostingMethod`→`FIFO`, `DefaultUnitOfMeasure`→`Item`, `Sellable`→
`Yes`/site default) — so blank isn't a data-quality problem worth flagging for those. What *is*
still worth checking: values that are non-blank but wrong, since no default rescues those.

**Accounts (`InventoryAccount`/`RevenueAccount`/`ExpenseAccount`/`COGSAccount`) use the plain
`accountExists` check, not the special-account variant AccountPayable/AccountReceivable need** —
confirmed via §5 above: Cin7's docs don't call any of these four a "special account" type, unlike
AccountPayable/AccountReceivable's documented `SystemAccount` restriction. No live test found a
counter-example. `DefaultLocation` reuses `locationExists`; `PurchaseTaxRule`/`SaleTaxRule` reuse
`taxRuleExists` — both already-confirmed reference books, no new research needed.

**`ProductAttributeSet` confirmed via `/ref/attributeset`** — same shape as Location/Tax
(`Name`/`Page`/`Limit` params, `AttributeSetList` wrapper), no `IsActive` field on this resource.
Added `attributeSetExists` using the existing generic `cachedFieldExists`.

**`DiscountName` confirmed via `/reference/discount`** — a different path prefix (`/reference/*`,
not `/ref/*`) than every other reference-book endpoint in this project. No exact-match `Name`
query param exists here, only `Search` (substring match on Name), so `productDiscountExists`
fetches by `Search` and filters client-side for an exact case-insensitive match (same approach as
`priceTierExists`' full-fetch). The `DiscountRule` model has a required `IsActive` field and
Cin7's own field docs say a discount "must exist ... and should be active" — same `IsActive`
handling as `paymentTermExists`.

**`PickZones` researched and confirmed to have NO reference-book/CRUD endpoint anywhere in the
spec** — a comma-delimited free-text field with no list resource to validate against (searched
for "Pick Zone" as a resource path; only found the unrelated `/reference/shipZones` and
`/reference/shipZonesEnabled`, which are a different concept for shipping). Left unchecked
rather than guessed, same call as Currency in §10. `WarrantySetupName` remains unchecked too, per
§5's earlier finding (no CRUD endpoint at all, capture-only field).

## 12. Product enum fields — casing doesn't match Cin7's own docs (confirmed 2026-07-06)

Anton hit a false-positive warning on a genuine Cin7 export: `Status "ACTIVE" is not a recognized
value (expected Active or Deprecated)`. Checked the real live sample already in this repo
(`docs/cin7-templates/InventoryList_2026-07-03.csv`) rather than guess — its `Status` column is
literally `ACTIVE` (all caps), not the `Active` (title case) Cin7's own field docs list as the
valid value. Same class of doc-vs-real-export mismatch already found for the boolean fields
(`AutoAssemble`/`Sellable` — docs say True/False, the real export uses Yes/No). Since Cin7's docs
have now been wrong about casing twice, `checkProductEnumFields` (src/import/warnings.ts) compares
all four enum fields (CostingMethod/Type/DropShip/Status) case-insensitively rather than trusting
any one convention — not just patching Status, since there's no reason to assume the others are
reliably cased either.

## 13. Future reporting — unexplored resources (2026-07-09, desk research only, NOT yet live-verified)

Ahead of the next reporting feature request, a pass through `github.com/nnhansg/dear-openapi`'s
full spec transcription (same primary source used throughout this doc) for resources this project
hasn't touched yet, specifically ones relevant to reporting. **Every item below is desk research
only** — same discipline as everywhere else in this doc: confirm live before building, since this
project has repeatedly found the community spec wrong (Work Centres §4, BOM endpoint §3).

**13a. `Movements[]` on the Product resource — potentially the single biggest find here.**
`GET /product?ID={ID}&...&IncludeMovements={IncludeMovements}` returns a `Movements[]` array
right on the Product response, modeled as `{TaskID, Type, Date, Number, Status, Quantity, Amount,
Location, BatchSN, ExpiryDate, FromTo}`. `Type` is a rich enum covering **every** movement kind
Cin7 tracks internally: `Purchase`, `Sale`/`SaleMultiple`, `Restock`/`RestockMultiple`,
`Adjustment`, `Stocktake`, `Transfer In`/`Transfer Out`, `Finished Goods`, `Disassembly`,
`Inventory Write-Off`, plus a `*Cost Change` variant of each. If this holds up live, it's a
single per-product call that could cover Stock Adjustments/Stock Takes/Transfers/Disassembly/
Write-Offs (13c-13e below) all at once, instead of syncing 4+ separate list+detail resource pairs
the way Purchases/Assembly Builds were each built this session. **Caveats to verify before relying
on it:** (1) it's per-product (`ID=` one SKU at a time) — a full-catalog historical movement sync
would still be one rate-limited call per SKU, the same N+1 cost class as Purchases/Assembly Builds'
detail phase, not a free lunch; (2) whether `Amount`/`Quantity` sign convention matches "in
positive, out negative" or needs `Type` to determine direction is unconfirmed; (3) whether old
movements page/truncate on this field the way `OrderLines`/`PickLines` don't is unconfirmed.
**Recommended first live test** if this becomes the next piece of work: one `IncludeMovements=true`
call against a real product with known adjustment/transfer history, diffed against what's already
in `assembly_builds`/`purchase_receipt_lines`/`sale_lines` for the same SKU to confirm the shapes
line up.

**13b. Product Availability (`/ref/productavailability`) — real on-hand stock levels, a genuine
gap in this app today.** Every report built so far (Sales, Assemblies, Cost Estimator, Inventory
Movement) is movement-based — this app has **zero** live on-hand-quantity data anywhere. This
endpoint returns exactly that, per product/location/batch: `OnHand`, `Allocated`, `Available`,
`OnOrder`, `StockOnHand`, `InTransit`, `NextDeliveryDate`, plus `Location`/`Bin`/`Batch`/
`ExpiryDate`. Paginated, filterable by `Location`/`Batch`/`Category`/`Sku`/`Name` — looks like a
normal list endpoint, not a detail-per-product one, so a full-catalog sync should be a cheap list
scan like `/saleList`, not an N+1 detail cost. **This is the natural next report** (current stock
levels, reorder points, days-of-cover) and would also sharpen the existing Inventory Movement
report's Fast/Medium/Slow classification — right now it's velocity-only (outbound qty), with real
on-hand data it could become a proper turnover ratio (velocity ÷ stock held), which is what "slow
mover" usually means in practice (high stock, low movement) rather than just "low movement."

**13c. Stock Adjustments (`/stockadjustmentList?Status=`, `/stockadjustment?TaskID=`) — a real
missing "in/out" source for the Inventory Movement report.** Write-offs, stock takes, damage,
and manual corrections all flow through here and aren't captured by Purchases/Assembly
Builds/Sales at all — meaning the current Inventory Movement report can show a product's net
change looking wrong (doesn't reconcile to what Cin7 itself would show) whenever a business has
had any manual stock corrections in the period. **Important quirk, different from every movement
source built so far:** a Stock Adjustment's line (`ExistingStockLineModel`/`NewStockLineModel`)
carries `Quantity`/`QuantityOnHand` as the **new absolute on-hand value**, not a delta — Sales/
Purchases/Assembly Builds all give a movement quantity directly, this one requires computing
`new − previous` to get an actual in/out amount, which means either tracking a running on-hand
total ourselves or reading the paired `Adjustment` field (also present, described as "New value
for QuantityOnHand" — needs live confirmation of what it actually contains, name is ambiguous
against `QuantityOnHand`).

**13d. Stock Takes (`/stockTakeList`, `/stocktake?...`) — same underlying line models as Stock
Adjustment** (`ExistingStockLineModel`/`NewStockLineModel` are shared/reused per the spec), just a
different top-level resource/workflow (a full physical count reconciliation vs. an ad hoc
correction). Whether a completed Stock Take produces its *own* Adjustment-type movement (i.e.
whether 13c already covers this) or is genuinely separate is unconfirmed — check both together,
not independently, to avoid double-counting the same physical event.

**13e. Stock Transfers (`/stockTransferList?Status=`, `/stockTransfer?TaskID=`) — location-to-
location movement, doesn't change org-wide total in/out.** A `Transfer Out` at one location is
always matched by a `Transfer In` at another (confirmed by both appearing as a pair in 13a's
`Type` enum) — net-neutral for a single combined Inventory Movement report, but necessary for any
future **per-location** breakdown (the current report already has instance-level filtering; a
future location dimension would need this). Two-stage: `Status` can be `DRAFT`/`IN TRANSIT`/
`COMPLETED`/`VOIDED`, with a separate `Order` sub-resource (`/stockTransfer/order`) for tracking
stock that's left the source but hasn't arrived yet — relevant if a future report wants an
"in transit" figure alongside on-hand (13b already surfaces `InTransit` too, worth reconciling
which is authoritative if both get built).

**13f. Sale/Purchase Credit Notes (`/saleCreditNoteList`, `/sale/creditnote`;
`/purchaseCreditNoteList`, `/purchase/creditnote`) — returns/refunds, not currently netted out
anywhere.** The Sales report's revenue/COGS/profit today only reads `sale_lines`
(invoice lines) — a heavily-returned product would look more profitable than it really is since
nothing in this app currently subtracts credit notes. Same two-endpoint-kind split already found
for Purchases (classic vs. Advanced — §Phase 1 migration comments) likely applies here too,
unverified. Field shape (`SaleCreditNoteModel`): `CreditNoteInvoiceNumber` (links back to the
original invoice), `Status` (`DRAFT`/`AUTHORISED`/`VOIDED`/`NOT AVAILABLE`), `Lines[]` (same
`SaleInvoiceLineModel` as regular invoice lines), `Total`/`Tax`/`TotalBeforeTax`.

**13g. Backorders — no separate endpoint, likely the cheapest possible future report.**
`BackorderQuantity` is a plain field directly on `SaleOrderLineModel` — i.e. it should already be
present in the same `GET /sale?ID=` detail response `sync-sales.ts`'s Phase 2 already fetches for
every sale. A "what's currently on backorder" or "fill rate" report might need **zero new Cin7
calls**, just adding this field to `sale_lines` and reading it — worth checking the raw response
`sync-sales.ts` already receives before assuming a new sync pipeline is needed.

**13h. Sale Quotes (`/sale/quote`) — pipeline/forecast reporting, a distinct resource from Sale
Orders.** Own `Status` lifecycle (values not yet confirmed — referenced as `QuoteStatuses` in the
spec but not read this pass). Relevant only if a future ask is forward-looking ("what's in the
pipeline") rather than historical movement, which is what everything built so far answers.

**13i. Webhooks (`/webhooks`) — real-time alternative to the polling model every sync in this
project uses today.** **Requires Cin7's separate "automation module" add-on** — the spec says so
explicitly, meaning **this can't be assumed present on any given client's account** and must be
confirmed per-instance before ever being relied on (same "must already exist, don't guess" caution
as Tax Rules/Chart of Accounts in §5). Max 5 webhooks of the same type at once; failed deliveries
retry 6 times over ~76 minutes then auto-deactivate. Most reporting-relevant types:
`Stock/AvailableStockLevelChanged`, `Sale/InvoiceAuthorised`, `Sale/CreditNoteAuthorised`,
`Purchase/StockReceivedAuthorised`, `Purchase/CreditNoteAuthorised`, `Sale/Backordered`. Would
shift this app from "polls every 15 minutes" to "reacts within ~1 minute," but is a genuinely
bigger architectural change (a public callback endpoint, signature/auth handling, no fallback if
the add-on isn't enabled) — not a drop-in improvement to the current sync model, a parallel one.

**Suggested live-verification order, if/when this becomes real work:** Product Availability (13b)
first — biggest single unlock, plain list endpoint, no delta-math ambiguity. Then Stock
Adjustments + Stock Takes together (13c/13d, check both at once to avoid double-counting). Then
Backorders (13g) — practically free, just confirm the field's really in the existing `/sale?ID=`
response. Credit Notes (13f) next for accurate Sales report profit. Quotes (13h) and Webhooks
(13i) only if a future ask specifically calls for pipeline reporting or real-time updates — both
are a materially bigger lift than the others here.
