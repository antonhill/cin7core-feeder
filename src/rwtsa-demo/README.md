# RWTSA demonstration: local workbook adapter (PR-1) and shell state (PR-2)

Local, read-only, offline foundation for the RWTSA vendor demonstration. **No Supabase client, no Cin7 client, no
network code, no database migration, no credentials** in the audited code (see "What the boundary test proves"). Nothing here changes the deployed Toolbox application.

## What this PR contains

| Path | Purpose |
|---|---|
| `contracts/` | Structural contracts for the 11 named workbook tabs (NDA-safe brief §4), matched by header **name**. |
| `workbook/` | ExcelJS reader, path guards, per-tab parser, dataset builder, validation certificate. |
| `reconcile.ts` | Deterministic control totals and a canonical content hash. |
| `findings.ts` | Value-free findings and errors. |
| `fixtures/synthetic.ts` | Seeded **synthetic** workbook generator (tests only; never committed as a file). |
| `state/` | PR-2: scenario metadata (delivery layers, assumptions), the demo state loader and the pure views the shell renders. READY is derived only from the validator's per-scenario flags. |
| `../../scripts/rwtsa-demo/validate.ts` | Local structure-only validation of the protected workbook. |
| `../../rwtsa-demo/` | PR-2: the standalone local-only Next.js shell (see its README). |

Calculation engines exist for scenarios A (Red Flag), B (variance, BOM/cost), C (landed cost, FX exposure) and D (quote conversion, `engine/quote-conversion.ts`; status table in `contracts/quote-status.ts`). The Fast React exchange does not exist yet.

## Red Flag engine (`engine/`)

Pure functions over the validated dataset: `runRedFlag(dataset, config, exclusions)`.

- **Available** = JHB + Durban + Cape Town + Factory Store - Committed, per SKU, reconciled against the workbook's own Available (differences are reported; the formula wins). Bond and In transit are excluded.
- **Forecast** = average monthly demand over the window / 4.345. The window is anchored to the stock date (default 2026-10-31): `strict` requires the N months to the last complete month and gives no forecast where months are absent (nothing older is substituted); `last-available` (default) uses the last N months on file and shows the months in between as an assumption. Sales for those months are never invented. A blank cell is missing; an explicit 0 is valid.
- **Projection**: balance(w) = balance(w-1) + inbound(w) - forecast(w) - committed_due(w), starting from Available, committed_due = 0 unless a separate dated schedule is supplied. First breach = first week strictly below the minimum; shortfall = maximum shortfall over the horizon (13 or 26 weeks); proposed order = that, rounded up, never negative (a proposal, not a purchase order). Tender SKUs never propose an order.
- **Inbound**: open purchase orders by ETA to stores (week 1 = the 7 days after the stock date). On-water and on-order are separate; an overdue on-water shipment is assumed to land in week 1 (switchable); overdue on-order, received/closed, unrecognised-status, unmatched and beyond-horizon quantities are excluded and reported. Stock "In transit" is never added (purchase orders only), and any disagreement is exposed. Style-level lines are split to sizes by a supplied size curve (largest-remainder, exact), or held unallocated.
- **Anomalies**: a month exceeding both `multiple x SKU median` (5) and `floor` (40 units) is flagged. A planner exclusion needs a reason and removes the month from the demand total and the observation count (no median substitution).
- **Style roll-up**: quantities are sums of SKU quantities and reconcile exactly; ratios are recomputed from totals.

Known gaps: the workbook's PO status vocabulary and the real size curve are unknown (unrecognised statuses are excluded and counted); the real history's end month and the treatment of September-October remain the owner's decision.

## STRUCTURE PASS is not readiness

`validate.ts` prints one headline, `STRUCTURE PASS|FAIL · N of 4 scenarios READY`, and reports two **separate** things.
A workbook can be structurally valid and have **no** scenario ready (exit code 0, `0 of 4 scenarios READY`).
**STRUCTURE PASS never means "ready to demonstrate".**

1. **STRUCTURE PASS / FAIL (workbook validity)** concerns the *core tabs*. PASS requires: every contract tab present
   exactly once; required headers present; every cell valid; no duplicate keys; **Items, SalesHistory and Stock all
   contain data**; **every Items SKU is present in both SalesHistory and Stock**; Stock and PO styles agree with the
   Items SKU's style; no orphan SKUs/styles; no negative stock or other negative cost/quantity/minutes input; no SKU
   with an entirely empty sales series. Non-core tabs (ImportPOs, BOM, Routing_SMV, ProductionOrders, LandedCost,
   Payments_FEC, Customers, Quotes) may be empty or sparse: that is a **warning** and makes the scenarios that need them
   NOT READY. A workbook with empty *core* tabs FAILS; one with only the non-core tabs empty passes with warnings.
2. **Scenario readiness (A, B, C, D)** is READY only if the workbook is structurally valid **and**: every record tab the
   scenario needs has data; every critical optional column is **present and populated with meaningful observations**; and
   (scenario A) every SKU has a valid observation in **each of the last N months** (default **6**, configurable with
   `--forecast-window`, 1-36). A valid explicit `0` or `false` is an observation; a blank never is, and never becomes
   `0`/`false`. Population rules for a present column: `Items.minLevel` every non-tender row; `Items.isTender` every row
   (explicit true/false); `Quotes.lostReason` every lost quote; `Quotes.convertedOrder` every won quote; any other
   critical column at least one value (finer per-row rules arrive with each calculation engine). Missing months in the
   window, or an unpopulated column, make a scenario NOT READY; they are **not** structural failures. Reasons are
   printed as counts only.

Sales history distinguishes an explicit **0** (a valid observation), an **empty cell** (a missing observation: kept as
`null`, counted, never converted to 0) and an **invalid value** (an error). Negative **quantities, costs, prices,
minutes and rates are errors**; negative sales cells (credit notes) are warnings. Only fields signed by nature declare
`allowNegative` in their contract: the variance columns and the file's own derived `Available` (negative when
over-committed).

### Readiness limits (preliminary; do not over-read READY)

- **The forecast window is not anchored to the stock date.** Scenario A's check evaluates the *latest N available
  month columns of the SalesHistory sheet* (default N = 6). It does not compare them with the stock-as-at date, so a
  history that ended long ago can still show READY, and a negative sales cell (a credit note) counts as a valid
  observation (it is only a warning). **Anchoring the window to the stock date must be implemented in the Red Flag
  engine before anyone claims complete forecasting readiness.** READY for scenario A means "the sheet's latest N months
  are fully populated", not "the forecast is ready".
- **Scenario B, C and D readiness is preliminary.** Beyond the tabs having data and the critical columns being present,
  most of their critical columns need only *at least one value* (the explicit per-row rules are `Quotes.lostReason`,
  `Quotes.convertedOrder`, `Items.minLevel`, `Items.isTender`). A column populated in a single row therefore still
  passes. Each scenario's calculation engine must define and enforce its own per-row requirements; until then treat B, C
  and D READY as "inputs plausibly present", not "calculable".
- Scenario D is READY with zero lost quotes even if the `Lost reason` column is empty (nothing needed a reason).

### Command-line arguments

`--forecast-window` takes only canonical positive decimal digits within 1-36: hexadecimal (`0x6`), fractions (`6.0`),
signs (`+6`, `-6`), exponents, leading zeros (`06`), padded or empty text are rejected (exit 2, error certificate). A
flag supplied without its value (as the last argument, or followed by another `--flag`) is rejected; it never falls back
to a default.

### Artefacts and exit codes

Every run first deletes the previous `validation-certificate.json` and `reconciliation.json` in the output directory,
then writes this run's certificate (`pass`/`fail`, or an `error` certificate if the run failed before a verdict). With
`--reconcile` and a clean pass it also writes `reconciliation.json`, carrying the **same `runId`**. A reconciliation from
an earlier successful run therefore cannot remain beside a later failed or crashed one. Files are written atomically.
Exit codes: `0` structure PASS (however many scenarios are ready), `1` structure FAIL or unexpected error, `2` usage
error or safety refusal.

## What the boundary test proves (and does not)

`__tests__/boundary.test.ts` + `boundary-scanner.ts` parse every code file (`.ts .tsx .js .jsx .cts .cjs .mts .mjs`,
tests included) under `src/rwtsa-demo`, `scripts/rwtsa-demo` and `rwtsa-demo/` with the TypeScript AST (three profiles: runtime, app, test), and follow
first-party imports transitively (currently also `src/lib/csv-upload-limits.ts` and `src/lib/format-count.ts`), resolving
canonical real paths (no string-prefix comparison; symlinks inside the boundary are violations). It proves that the
audited code: imports only an allowlist (`exceljs`, `zod`, `node:fs`, `node:path`, `node:crypto`, `node:os`; tests add
`vitest`, `typescript`, `node:child_process`); has no dynamic `import()`, `require`, `createRequire` or
`import = require`; references no `fetch`/`XMLHttpRequest`/`WebSocket`/`eval`/`Function`/`globalThis`-style
identifiers or `.constructor`/`.binding` properties; reads `process.env` only as a named `RWTSA_*` variable; and
contains no network URL literal.

It is a **review-time tripwire against accidental or unreviewed imports** (Supabase, Cin7, other application modules,
network APIs). It is **not a sandbox** and gives **no protection against deliberately malicious code**, against
third-party packages or Node itself, or against `node:fs` misuse (arbitrary file reads/writes remain possible).

## Confidentiality rules (enforced by tests)

- The protected workbook lives **outside every git working tree**; the reader refuses anything inside one.
- Output (certificate, reconciliation, later app state) is written outside every repository, default `~/rwtsa-local`.
- Errors, findings, logs and reports carry only: our own tab and field names, counts, row numbers and reason
  classes. Never a cell value, a file-supplied header or tab name, a file name or a path.
- Synthetic data is for tests only. A dataset carries `provenance: "synthetic" | "local-workbook"`; only a clean
  `validate.ts` run on the real file may produce `local-workbook`. Do not present synthetic results as the
  advisor's data.
- No global `*.xlsx` ignore; the narrow rules are in `.gitignore` (`/rwtsa-local/`, `RWTSA_*.xlsx`, ...).

## Validating the protected workbook locally

```bash
npx tsx scripts/rwtsa-demo/validate.ts --file "/path/outside/repo/workbook.xlsx" [--header-map "/path/outside/repo/map.json"] [--forecast-window 6] [--reconcile]
```

Terminal output is structure only (tab presence, parsed row counts, missing canonical field names, value-free
findings). `--reconcile` writes control totals to the local output directory for you to compare with the
advisor's figures; they are derived from protected data, so keep them local.

If the real headers differ from the contract's aliases, supply a local header map (JSON outside the repo):

```json
{ "Stock": { "committed": "The real header text" } }
```

Keys are our tab names and canonical field keys (see `contracts/tabs.ts`).

## Deferred review findings (P3 and decisions; none blocks merge)

- Path guard tests `.git` presence only (a bare/detached repo or dangling `.git` symlink would not be detected;
  `$HOME` being a dotfiles repo fails closed).
- `local-workbook` provenance is a convention: a synthetic file saved to disk and validated is labelled
  `local-workbook`. Consider stamping synthetic workbooks and refusing that label.
- Library exceptions thrown inside `readWorkbook` itself (not the CLI) are not wrapped; the CLI reports only the class name.
- Only the compressed size (25 MB) is capped; a decompression bomb is bounded only by memory.
- Date strings with trailing text are accepted after the date; any Date used as a header collapses to `YYYY-MM`.
- The boundary test uses the `typescript` JS API (`createSourceFile`); a TypeScript 7 upgrade (Dependabot #53) must be
  checked against it. Known non-goals of the boundary scanner (computed `constructor` chains, `module.require`,
  renamed destructured `fetch`, `Reflect`, arbitrary `node:fs` paths) are deliberate: it is a tripwire, not a sandbox.
- No range check on huge values (e.g. 1e15); only negatives are reported.
- Readiness population rules for scenarios B-D are coarse ("at least one value") until their engines define per-row needs.
- Scenario A requires the recent window for every SKU, tender SKUs included.
- Two concurrent `validate.ts` runs in the same output directory can interleave (each run's `runId` differs, so a
  mismatched pair is detectable). No lock file yet.

## Sheet layouts (the original workbook loads directly)

The advisor's workbook is not uniformly tabular, and `workbook/layouts.ts` reads it **as supplied** (no reshaping, no header-map file). Every rule is explicit and per sheet; unknown headers are never fuzzy-matched.

- **Tabular sheets** (Items, SalesHistory, Stock, ImportPOs, Customers, Quotes): header in the first non-empty row. The real header wording is accepted through explicit aliases in `contracts/tabs.ts`.
- **Report sheets** (BOM, Routing_SMV, ProductionOrders, LandedCost, Payments_FEC): the header is tried on the first row, then on that sheet's named rows (4, 4, 3, 4, 3). The data region ends at the first gap or the first row with no key. Everything below it is counted as a trailing **summary** row (carries a number or date) or **note** row (text only).
- **Title and text-line context**: BOM style (`Style: <code>` on row 2), Routing style (row 1) and cost per minute (`R<amount>` on row 2), LandedCost shipment (row 1), planning FX, customs FX and freight total (row 2). A missing identifier is an error naming our field; a missing optional rate is a warning and the field stays blank.
- **BOM**: `Applies to sizes` lists become one row per size (`All ...` means every size; an unknown size token is an error); the component label is the code and name; a `Labour` line whose quantity and cost are text pointing at the routing is an explained, counted exclusion (labour is costed from Routing_SMV), while any other non-numeric line is still an error.
- **LandedCost**: only the exact header `FOB (USD/unit)` is converted (unit price x quantity = the line total the engine expects); `Duty %` is a rate column and is kept apart from the duty amount; a product that is an Items style code is a style-level line.
- **Composite product text** (`SKU / style` on ImportPOs, the Style cell on ProductionOrders) is resolved against Items: an exact SKU or style, else exactly one SKU as a whole token, else exactly one style. Two different codes, or none, is unresolved: the text is kept, a PO line is a **warning** (the Red Flag engine counts its units as unmatched) and a production order is an error.
- **Percent-formatted cells** (`0.0%`, `0%`) are read as displayed (0.857 shown as 85.7% is 85.7). A bare number in a General cell is never reinterpreted.
- **Yes/No with a description** is accepted for `ImportPOs.bondOnArrival` only.
- **Rows below a report table** that still look like table rows (a key and about as many distinct values as the data rows) are an error, not a summary. This is a heuristic with known limits: a plain total row with as many distinct values as the data rows would be flagged, and a short keyed row with one value would be counted as a summary. Both are visible in the row accounting.
- **Merged note rows** (nothing in the first column, one repeated text) and the **ReadMe** sheet are recognised, counted and not parsed.
- **Row accounting**: for every tab, title + header + data + notes + explained exclusions + trailing summary + trailing notes = non-empty sheet rows, and parsed rows = data rows + rows added by size lists. The validation page shows it; findings carry counts and row numbers only.

Not decided here (open commercial rules, shown by name and withheld): tender classification, overdue on-water treatment, sales-history gap treatment, overhead / efficiency / margin in product cost, and paid-or-open USD exposure.

Run `RWTSA_WORKBOOK_PATH=<file outside git> npx vitest run src/rwtsa-demo/__tests__/original-workbook.local.test.ts` to check a protected workbook locally. The test is skipped when the variable is unset and prints nothing from the file.

## Known unknowns (not guessed here)

Real header strings; status vocabulary; date and percent formats; the tender marker column; whether `Quotes` has a
product dimension; meaning of overhead/efficiency/margin; customs value and duty definitions; the unnamed 12th
tab; where the size curve lives. Each is resolved from **local** inspection, not by assumption.
