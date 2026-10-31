# RWTSA demonstration: local workbook adapter (PR-1)

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
| `../../scripts/rwtsa-demo/validate.ts` | Local structure-only validation of the protected workbook. |

Calculation engines (Red Flag, landed cost, variance, BOM/cost, quotes, Fast React) are **not** in this PR.

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
tests included) under `src/rwtsa-demo`, `scripts/rwtsa-demo` and `rwtsa-demo/` with the TypeScript AST, and follow
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

## Known unknowns (not guessed here)

Real header strings; status vocabulary; date and percent formats; the tender marker column; whether `Quotes` has a
product dimension; meaning of overhead/efficiency/margin; customs value and duty definitions; the unnamed 12th
tab; where the size curve lives. Each is resolved from **local** inspection, not by assumption.
