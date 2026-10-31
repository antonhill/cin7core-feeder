# RWTSA demonstration: local workbook adapter (PR-1)

Local, read-only, offline foundation for the RWTSA vendor demonstration. **No Supabase, no Cin7, no network, no
database migration, no credentials.** Nothing here changes the deployed Toolbox application.

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

## Known unknowns (not guessed here)

Real header strings; status vocabulary; date and percent formats; the tender marker column; whether `Quotes` has a
product dimension; meaning of overhead/efficiency/margin; customs value and duty definitions; the unnamed 12th
tab; where the size curve lives. Each is resolved from **local** inspection, not by assumption.
