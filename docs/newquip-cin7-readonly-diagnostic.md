# NewQuip read-only Cin7 diagnostic

## Purpose

Read LIVE Cin7 data (never the Toolbox cache, which can be stale) for a list of SKUs, so the owner can compare it, locally, with the supplier / BOM source files supplied by Sean. It reports what Cin7 actually holds: product status and costing, every supplier record on the product, the live supplier master currency, and the BOM including any substitution-like fields.

It is a diagnostic. It does not fix, sync, capture or change anything.

## What it does

- Page: `/newquip-grower/diagnostics` (a 404 unless enabled and authorised). Action: `runCin7DiagnosticAction` in `src/app/newquip-grower/cin7-diagnostic-actions.ts`.
- Per SKU, one `GET /Product?SKU=<sku>&IncludeSuppliers=true&IncludeBOM=true&page=1&limit=1`. An EXACT SKU match is required (Cin7 can ignore the filter); anything else is reported as not found.
- Per distinct supplier name across the batch, one `GET /Supplier?Name=<name>&page=1&limit=1` (exact name) to read the live master `Currency` and `Status`.
- All requests go through `Cin7ReadOnlyGate` (`src/cin7/readonly-diagnostic.ts`) which has a single `get(path, query)` method. The HTTP method is hard-coded GET, only `/Product` and `/Supplier` are allowed, and only the query keys `SKU, Name, ID, IncludeSuppliers, IncludeBOM, page, limit`. Anything else throws before a request is built. Requests use the existing credential loader and the existing Cin7 gateway (`cin7Request`, canonical origin, no redirects, distributed rate limiter).
- Limits: 150 SKUs per run (trimmed, de-duplicated, max 64 characters, characters `A-Z a-z 0-9 . _ - / space`). Sequential, about one request per second; HTTP 429/503 backs off 2s, 4s, 8s then fails that SKU; the run aborts after 3 consecutive errors (remaining SKUs are marked `skipped_after_abort`). A 150-SKU run takes a few minutes.

## Threat model

| Risk | Control |
|---|---|
| Credential exposure | Credentials are loaded server-side by `loadCin7Credentials` and never returned, logged or placed in an error. Failures are mapped to short codes (`http_401`, `http_429`, `network`, ...). No URL, header or raw Cin7 error body appears in any output (tested with a canary credential). |
| Writes | The gate cannot express a non-GET method. The new files may not import any quote store, draft saver, `captureLatestCostsAction`, cost-actions, pricing writers or `*-write` module (enforced by a static test). Nothing is written to Cin7 or to a quotation draft. The only write is ONE audit row per run (`newquip.cin7_diagnostic_run`) holding counts only: no SKUs, no costs. |
| Data exposure | The output contains costs. Access needs: the NewQuip organisation, Quotes module access, NOT a Demo Mode identity, an organisation owner/admin or super admin (via `requireOrgAdmin`), cost visibility, AND the env gate. A refusal is one plain message and does no work. The output is returned to the caller only, never stored. The page is `force-dynamic`. |
| Abuse / rate limits | 150 SKUs max, one request per second, bounded backoff, abort after 3 consecutive errors, shared distributed Cin7 limiter, admin-only, every run audited. |

## Enabling and removing the gate

`NEWQUIP_CIN7_DIAGNOSTIC_ENABLED=true` turns it on; any other value or absence leaves it off (default off). Set it ONLY on the candidate Preview deployment's scope for the time needed, then remove it. It must NEVER be set in Production scope (and the feature is not intended to ship enabled anywhere else). Removing the variable and redeploying disables the page and the action at once; no data cleanup is needed.

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
- `aborted: true`: the run stopped after 3 consecutive errors.

## Explicitly NOT built

No sync, no cost capture, no write to Cin7, no write to quotation drafts or any quote store, no caching of results, no scheduled or background run, no upload of files, no Production enablement, no `/ProductList` call.
