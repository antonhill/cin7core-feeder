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

## What PASS means, and what it does not

`validate.ts` reports two separate things:

1. **PASS / FAIL (workbook validity).** PASS requires: every contract tab present exactly once; required headers
   present; every cell valid; no duplicate keys; **Items, SalesHistory and Stock all contain data**; **every Items SKU is
   present in both SalesHistory and Stock**; Stock and PO styles agree with the Items SKU's style; no orphan SKUs/styles;
   no negative stock; no SKU with an entirely empty sales series. A headers-only or partially populated workbook FAILS.
2. **Scenario readiness (A, B, C, D).** A scenario is READY only if the workbook is valid, every record tab it needs has
   data (empty non-core tabs are warnings, not errors) and the optional columns its calculations need are present
   (e.g. scenario A needs `Items.minLevel` and `Items.isTender`). Absent optional columns are reported, never silently
   treated as mandatory or ignored.

Sales history distinguishes an explicit **0** (a valid observation), an **empty cell** (a missing observation: kept as
`null`, counted, never converted to 0) and an **invalid value** (an error). Negative values are warnings, except negative
stock quantities, which are errors; a contract can declare negatives legitimate only with `allowNegative`.

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
npx tsx scripts/rwtsa-demo/validate.ts --file "/path/outside/repo/workbook.xlsx" [--header-map "/path/outside/repo/map.json"] [--reconcile]
```

Terminal output is structure only (tab presence, parsed row counts, missing canonical field names, value-free
findings). `--reconcile` writes control totals to the local output directory for you to compare with the
advisor's figures; they are derived from protected data, so keep them local.

If the real headers differ from the contract's aliases, supply a local header map (JSON outside the repo):

```json
{ "Stock": { "committed": "The real header text" } }
```

Keys are our tab names and canonical field keys (see `contracts/tabs.ts`).

## Deferred review findings (P3, tracked for later; none blocks merge)

- Path guard tests `.git` presence only (a bare/detached repo or dangling `.git` symlink would not be detected;
  `$HOME` being a dotfiles repo fails closed).
- `local-workbook` provenance is a convention: a synthetic file saved to disk and validated is labelled
  `local-workbook`. Consider stamping synthetic workbooks and refusing that label.
- Library exceptions thrown inside `readWorkbook` itself (not the CLI) are not wrapped; the CLI reports only the class name.
- Only the compressed size (25 MB) is capped; a decompression bomb is bounded only by memory.
- Date strings with trailing text are accepted after the date; any Date used as a header collapses to `YYYY-MM`.
- The boundary test uses the `typescript` JS API (`createSourceFile`); a TypeScript 7 upgrade (Dependabot #53) must be
  checked against it.
- No range check on huge values (e.g. 1e15); only negatives are reported.

## Known unknowns (not guessed here)

Real header strings; status vocabulary; date and percent formats; the tender marker column; whether `Quotes` has a
product dimension; meaning of overhead/efficiency/margin; customs value and duty definitions; the unnamed 12th
tab; where the size curve lives. Each is resolved from **local** inspection, not by assumption.
