# RWTSA demonstration shell (local only)

A standalone Next.js app that shows **data provenance, validation, per-scenario readiness, delivery layers and assumptions**
for the four RWTSA demonstration scenarios. It reads a **local** workbook (or explicitly selected synthetic data) through the
audited adapter in `src/rwtsa-demo/`. **Scenario A (Red Flag demand planning) has a working, tested calculation engine and an interactive dashboard; Scenarios B-D have no engine yet and show no results.**

It is not part of the deployed Toolbox. No Supabase, no Cin7, no Xero, no authentication, no database, no external API, no
remote fonts or analytics, nothing written to disk.

## Run it (production mode only)

```bash
# from the repository root, after `npm ci`
npm --prefix rwtsa-demo run build
RWTSA_WORKBOOK_PATH="/path/outside/any/repo/workbook.xlsx" npm --prefix rwtsa-demo run start   # http://127.0.0.1:3100
# or, with the synthetic test data, which must be chosen explicitly:
npm --prefix rwtsa-demo run build && npm --prefix rwtsa-demo run start:synthetic
```

| Variable | Meaning |
|---|---|
| `RWTSA_SOURCE=synthetic` | Use the deterministic synthetic dataset. Never a default or a fallback. |
| `RWTSA_WORKBOOK_PATH` | Local workbook (must be outside every git working tree). |
| `RWTSA_HEADER_MAP` | Optional local header-map JSON (see `src/rwtsa-demo/README.md`). |
| `RWTSA_FORECAST_WINDOW` | Months for scenario A's recent-history check (1-36, default 6). |

Setting both `RWTSA_SOURCE=synthetic` and `RWTSA_WORKBOOK_PATH` is a configuration error: nothing is loaded. With neither set the
shell shows NO DATA and every scenario NOT READY. A local workbook that is missing, unreadable or invalid is NOT READY on every
page and **never** falls back to synthetic data.

## What each page shows

Every page shows the data provenance (**SYNTHETIC**, **LOCAL WORKBOOK** or **NO DATA**), the scenario's **READY / NOT READY**
(taken only from the validator's per-scenario flag), its **delivery layer** (CIN7 CORE, TOOLBOX, XERO, FAST REACT / EXTERNAL),
and its assumptions and open inputs. **STRUCTURE PASS is shown separately and is never readiness.** Native Cin7 Core / Xero
claims are marked "to be verified independently" (owner decision D6).

## Scenario A: Red Flag demand planning

`/scenario-a` is a server-rendered page driven by the pure engine in `src/rwtsa-demo/engine/` (no Next.js, Supabase, Cin7 or network code in it).
It shows five separate facts: provenance, **STRUCTURE PASS/FAIL**, **READY / NOT READY** (validator only), **ENGINE AVAILABLE / UNAVAILABLE**
and the **forecast basis** (ANCHORED / ASSUMED / LIMITED). An available engine never makes data ready.

- Controls are a plain GET form (no client script): SKU/style view, forecast window (1-36 months), 13 or 26-week horizon, history anchor,
  overdue-on-water treatment, size curve, anomaly thresholds, style and shortage filters. Settings live in the URL and are not stored.
- Planner **exclusions** (a reason is mandatory; reversible) are POSTed to `/api/exclusions` (same-origin only) and saved in
  `$RWTSA_STATE_DIR` (default `~/.rwtsa-demo`), one small JSON file per data source, **outside every git working tree**. Nothing else is persisted.
- The page shows the SKU and style codes of the loaded data in your browser (that is the point of a planning screen). Nothing leaves the machine.
- Synthetic data supplies a size curve; a local workbook does not, so style-level purchase orders stay **unallocated** unless you choose the
  demand-proportional assumption on screen.

Run on a second port without disturbing a running demo: `RWTSA_SOURCE=synthetic npx next start -H 127.0.0.1 -p 3101` from `rwtsa-demo/`
(after `npm --prefix rwtsa-demo run build`).

## Why a standalone Next.js app (feasibility gate result)

The 3-hour feasibility gate was **passed in minutes**; the offline-HTML fallback was **not needed**. The standalone app:

- imports the merged `src/rwtsa-demo/` contracts, adapter and fixtures and the approved presentational Toolbox components
  (`Alert`, `Badge`, `EmptyState`, `Panel`, `Table`, which import nothing) via `turbopack.root` = repository root;
- starts on `127.0.0.1` with an **empty environment** (no Supabase/Cin7 variables) and serves all six pages;
- needs no change to any root configuration file, route, middleware or dependency;
- renders every page per request (`force-dynamic`), so no workbook-derived data can enter the build output.

The fallback (a self-contained HTML bundle built with the same engines) remains available if this approach ever fails.

## Findings made while building it (and what prevents them recurring)

1. **The Toolbox middleware leaked in.** With `turbopack.root` at the repo root, Turbopack's upward lookup found and bundled
   `src/middleware.ts` (Supabase session gate). In production mode every request returned HTTP 500 without Supabase credentials.
   `rwtsa-demo/proxy.ts` is a deliberate no-op that shadows it. `__tests__/standalone-build.test.ts` builds and starts the real app
   with a minimal environment and fails if the Toolbox middleware or any Supabase client reappears in the bundle.
2. **`next dev` calls out.** Next.js's development server fetches `https://registry.npmjs.org/-/package/next/dist-tags` for its update
   indicator, with no configuration switch and regardless of `NEXT_TELEMETRY_DISABLED`. (Observed under a macOS sandbox that denies
   non-loopback network; the production build and server made no denied attempts.) Therefore **there is no `dev` script**, and the
   shell refuses to serve a local workbook when it detects `NODE_ENV=development`. Synthetic data may still be viewed under `next dev`,
   but the supported way to run the shell is `build` + `start`.
3. **Build output location.** `distDir` is `node_modules/.cache/rwtsa-demo-next` (already ignored by git, ESLint and `tsc`), so running the
   shell never touches the Toolbox's own `.next`, root lint or the root type-check, and no workbook-derived data sits in the tree.

## Safety properties (each enforced by a test)

- Bound to `127.0.0.1` (scripts pass `-H 127.0.0.1`; `next start` otherwise binds all interfaces). Telemetry disabled.
- Import boundary (AST scanner, `src/rwtsa-demo/__tests__/boundary-scanner.ts`): this app may import only `react`, `next` (types),
  `next/link`, the audited RWTSA code and the five Toolbox UI files. **Not** `next/font`, `next/image`, `next/script`, `next/headers`,
  `next/server`, analytics, Supabase or Cin7. Environment access is limited to named `RWTSA_*` variables and `NODE_ENV`. The shell is server-rendered only: `"use client"`,
  browser globals (`document`, `location`, `Image`, storage) and protocol-relative `//host` URLs are rejected. Every stylesheet
  under `rwtsa-demo/` and the Toolbox stylesheet it imports are checked for remote references.
- Findings, reasons and errors are value-free: tab names, canonical field keys, counts and reason classes. Never a cell value, a file
  name or a path. A sentinel-poisoned workbook is rendered in every page test and the production build output is searched for it.
- In-memory memoisation only; nothing is cached to disk.

## Running it safely

Use the `npm --prefix rwtsa-demo run ...` scripts above. Do not run `next dev` (or `next start` without `-H 127.0.0.1` and
`NEXT_TELEMETRY_DISABLED=1`) directly: the scripts exist to guarantee loopback binding and no telemetry, and the development
server contacts the npm registry.

## Not here yet

Landed-cost, variance, BOM/costing, quote-conversion and Fast React engines. Scenarios B-D are labelled placeholders. The validator's
Scenario A check still uses the sheet's latest N months; the **engine** anchors its own window to the stock date (31 October 2026) and shows
the difference as an assumption. Scenario B-D readiness is preliminary.

## Build-test isolation, and deferred items

`standalone-build.test.ts` builds into its own unique directory (`node_modules/.cache/rwtsa-demo-next-test-<pid>-<id>`, selected by `RWTSA_DIST_SUFFIX`, validated by `lib/dist-dir.ts`) and removes only that directory. It never touches the default `rwtsa-demo-next` directory a running demo server uses, and concurrent runs cannot delete one another's output.

Deliberately deferred (not part of this PR): allowlisting bare `next` imports as type-only; the interaction of `RWTSA_HEADER_MAP` with the synthetic source (currently ignored); normalising `RWTSA_SOURCE` values (case-sensitive, trimmed); separate FAST REACT and EXTERNAL layer labels; POSIX-only `NEXT_TELEMETRY_DISABLED=1` script prefix.
