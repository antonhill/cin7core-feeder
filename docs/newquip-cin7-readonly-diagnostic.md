# NewQuip read-only Cin7 diagnostic

## Purpose

Read LIVE Cin7 data (never the Toolbox cache, which can be stale) for a list of SKUs, so the owner can compare it, locally, with the supplier / BOM source files supplied by Sean. It reports what Cin7 actually holds: product status and costing, every supplier record on the product, the live supplier master currency, and the BOM including any substitution-like fields.

It is a diagnostic. It does not fix, sync, capture or change anything.

## What it does

- Page: `/newquip-grower/diagnostics` (a 404 unless enabled and authorised). Action: `runCin7DiagnosticAction` in `src/app/newquip-grower/cin7-diagnostic-actions.ts` (credential loading lives in `src/cin7/readonly-diagnostic-run.ts`, outside the NewQuip no-write scan area).
- Per SKU, one `GET /Product?SKU=<sku>&IncludeSuppliers=true&IncludeBOM=true&page=1&limit=1`. An EXACT SKU match is required (Cin7 can ignore the filter); anything else is reported as not found.
- Per distinct supplier name across the batch, one `GET /Supplier?Name=<name>&page=1&limit=1` (exact name) to read the live master `Currency` and `Status`.
- All requests go through `Cin7ReadOnlyGate` (`src/cin7/readonly-diagnostic.ts`) which has a single `get(path, query)` method. The HTTP method is hard-coded GET, only `/Product` and `/Supplier` are allowed, and only the query keys `SKU, Name, ID, IncludeSuppliers, IncludeBOM, page, limit`. Anything else throws before a request is built. Requests use the existing credential loader and the existing Cin7 gateway (`cin7Request`, canonical origin, no redirects, distributed rate limiter).
- `/Product?SKU=` and `/Supplier?Name=` may be contains/prefix matches in Cin7, so each asks for 10 results (page 1) and picks the exact one: SKU exact and case-sensitive; supplier name exact, else a UNIQUE case-insensitive trimmed match, else the supplier is flagged `supplierNameAmbiguous` and its master currency is not used.
- Limits: 150 SKUs per run (trimmed, de-duplicated, max 64 characters, characters `A-Z a-z 0-9 . _ - / space`).
- Pacing: sequential, 1500 ms between requests. HTTP 429/503 backs off 2s, 4s, 8s then fails that SKU.
- Budget: a 240 s wall-clock deadline stops further requests and returns the partial results. At most 100 distinct supplier names are looked up live; the rest are flagged `supplierLookupSkipped` (master currency unknown). The page exports `maxDuration = 300` (the Vercel Pro ceiling; the plan limit is not known here, so on a lower plan keep lists short because the platform may cut a long run off).
- Single-flight: one run per organisation at a time (an in-process flag, plus a check that refuses when a `newquip.cin7_diagnostic_run_started` audit row from the last 5 minutes has no later `newquip.cin7_diagnostic_run` row, which works across serverless instances). If the check cannot be done, the run is refused. The button is disabled while a run is pending. The check-then-write is not atomic, so two truly simultaneous calls on different instances could both pass; the pacing and admin-only access bound the harm.

## Threat model

| Risk | Control |
|---|---|
| Credential exposure | Credentials are loaded server-side by `loadCin7Credentials` and never returned, logged or placed in an error. Failures are mapped to short codes (`http_401`, `http_429`, `network`, ...). No URL, header or raw Cin7 error body appears in any output (tested with a canary credential). |
| Writes | The gate cannot express a non-GET method. The new files may not import any quote store, draft saver, `captureLatestCostsAction`, cost-actions, pricing writers or `*-write` module (enforced by a static test). Nothing is written to Cin7 or to a quotation draft. The only write is ONE audit row per run (`newquip.cin7_diagnostic_run`) holding counts only: no SKUs, no costs. |
| Data exposure | The output contains costs. Access needs: the NewQuip organisation, Quotes module access, NOT a Demo Mode identity, an organisation owner/admin or super admin (via `requireOrgAdmin`), cost visibility, AND the env gate. A refusal is one plain message and does no work. The output is returned to the caller only, never stored. The page is `force-dynamic`. |
| Abuse / rate limits | 150 SKUs max, one request per 1.5 s, 240 s deadline, supplier-lookup cap, single-flight, bounded backoff, abort after 3 consecutive errors, shared distributed Cin7 limiter, admin-only, every run audited. |

## Enabling and removing the gate

`NEWQUIP_CIN7_DIAGNOSTIC_ENABLED=true` turns it on; any other value or absence leaves it off (default off). Set it ONLY as a BRANCH-SCOPED Preview variable (this feature branch), for the time needed, then remove it. It must NEVER be set in Production scope and NEVER in the all-branches Preview scope. Removing the variable and redeploying disables the page and the action at once; no data cleanup is needed.

## How to run and compare (locally, no upload)

1. On the candidate Preview, signed in as an organisation owner/admin, open `/newquip-grower/diagnostics`.
2. Paste the SKUs, one per line, and press "Run read-only check".
3. Use "Download JSON" (built in the browser; nothing is uploaded anywhere).
4. Compare on your own machine with Sean's imported source files (for example load both into a spreadsheet or a small script). Do not upload either file to a third party.

## Reading the output

- `found: false` with `error: null`: Cin7 has no product with that exact SKU. With an `error` code: the request failed (see codes).
- `status`, `type`, `uom`, `costingMethod`, `averageCost`: as returned by Cin7.
- `suppliers[].cost` and `fixedCost`: the raw `Suppliers[].Cost` / `FixedCost`, not interpreted (the output does not claim which is the latest price or the unit basis).
- `recordCurrency`: the supplier record's own `Currency` on the product, or null. `masterCurrency`: the live `/Supplier` record's `Currency`, or null. The currency is never inferred from the Toolbox suppliers table.
- `currencyConflict`: both are known and differ. `currencyUnknown`: neither is known.
- `bom`: `type`, `components[]` (code, name, qty, wastagePercent, wastageQty, costPercentage and the raw object) and `services[]`; null when the product has no BOM data. `rawBomLineKeys` is the sorted union of every key seen on BOM component objects, and `rawSupplierKeys` likewise for supplier records, so fields such as a substitute or alternative are discovered rather than assumed. Any field whose name contains substitut / alternat / alias / replace is also copied to `substitutionFields`.
- `summary`: requested, found, missing, inactive, noSupplier, multipleSuppliers, currencyConflicts, currencyUnknown, bomMissing (found SKUs with no BOM data, which is normal for non-assembly products), errors.
- `aborted: true`: the run stopped early; `abortReason` says why. `consecutive_errors`: 3 errors in a row (usually auth or Cin7 trouble: check the codes). `deadline`: the 240 s budget ran out. Either way the SKUs already read are valid and the rest are `skipped_after_abort`: run the remainder as a separate list. `abortReason: null` means it ran to the end.
- `supplierLookupSkipped`, `supplierNameAmbiguous`, `nameNotQueryable` (per supplier entry, counted in `summary`): the live master currency could not be read for that supplier, so do not treat `currencyUnknown` there as a real gap. `nameNotQueryable` is not counted as an error.

## Explicitly NOT built

No sync, no cost capture, no write to Cin7, no write to quotation drafts or any quote store, no caching of results, no scheduled or background run, no upload of files, no Production enablement, no `/ProductList` call.
