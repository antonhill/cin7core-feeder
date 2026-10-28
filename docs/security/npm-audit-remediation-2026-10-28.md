# npm audit remediation (2026-10-28)

Branch `security/dependency-remediation-next-16-4-3`, based on `origin/main` (3376bd1). Independent of the NewQuip work. **DRAFT, not for merge without owner approval.**

## Change set (4 declared dependencies + lockfile)
| Package | From | To | Why this version |
|---|---|---|---|
| `next` | 16.3.0 (exact pin) | **16.4.3** (exact pin) | Advisory range is 16.0.0 - 16.4.0 (critical: unauthenticated RCE, Windows-hosted servers GHSA-p293-qw3h-jr36; RCE in the Image Optimization API with AVIF GHSA-2xp9-vwfh-vxw4; RCE in `next/og` GHSA-vcvr-r3jv-pc5j). 16.4.3 is the fixed and current `latest` release; a minor within 16.x. |
| `eslint-config-next` | 16.3.0 | **16.4.3** | Must track `next`. |
| `zod` | ^4.4.3 | **^4.6.7** | Fixes GHSA-mrhx-c7xc-m3w5 (memory exhaustion validating oversized constrained collections), fixed in 4.6.6; 4.6.7 is `latest`. |
| `vitest` | ^4.1.9 | **^4.1.12** | Fixes the `@vitest/mocker` advisories (GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8; range <=4.1.11). 4.1.12 is the latest 4.x; `vitest@latest` is 5.0.5, which conflicts with this repo's vite peer range, so it is deliberately not used. |
| lockfile only (`npm update`) | sharp 0.35.3, js-yaml 4.3.1, source-map-js 1.2.1, vite 8.1.3, brace-expansion 1.1.18 / 2.1.4 / 5.0.9 | sharp **0.35.5**, js-yaml **4.3.2**, source-map-js **1.2.2**, vite **8.3.5**, brace-expansion **1.1.21 / 2.1.7 / 5.0.12**, @vitest/mocker **4.1.12** | Transitive; each is the first non-vulnerable release in range. No `package.json` change. |

These versions were re-validated today: each is the current release in its line, the advisory ranges end below them, and `npm audit` confirms it (below). No `npm audit fix --force` was used (it would downgrade exceljs to 3.4.0).

## Results
- `npm audit`: **11 -> 2** (both moderate, `uuid` via `exceljs`). `npm audit --audit-level=high` exits **0**, so the CI "Dependency vulnerability scan" gate passes.
- `tsc --noEmit` clean; **2,006 tests pass**; eslint 0 errors (2 pre-existing warnings); `next build` succeeds; a real `next start` answers `/` 200 and redirects `/projects` to `/login`.
- Breaking-change risk: low. Next 16.3 -> 16.4 is a minor; this repo documents non-standard Next conventions (AGENTS.md), so verify on the Vercel Preview before merging.

## The remaining advisory: `uuid` < 11.1.1 via `exceljs` 4.4.0 (moderate, GHSA-w5hq-g745-h8pq)
- **What it is:** missing buffer bounds check in uuid **v3/v5/v6** when the caller supplies a `buf` argument.
- **Dependency path:** `cin7core-feeder -> exceljs@4.4.0 -> uuid@8.3.2` (the only uuid in the tree; `npm ls uuid --all`). exceljs 4.4.0 is its latest release, pins `uuid ^8.3.0`, so no upstream fix exists. npm's offered "fix" is a downgrade to exceljs 3.4.0, which is not acceptable.
- **Evidence it is not reachable:**
  1. In exceljs the only `require('uuid')` is `lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`, which imports **`v4`** and calls `uuidv4()` **with no arguments** (two call sites). The vulnerable functions (v3, v5, v6) are never imported, and the `buf` argument is never passed (`grep -rn uuid node_modules/exceljs/lib`).
  2. That code generates ids for *conditional-formatting extensions*; the app never uses conditional formatting (`src/reports/xlsx-writer.ts` has no `conditionalFormatting`), and the only other exceljs consumer is the NewQuip price-snapshot script run by the owner.
  3. No user-controlled value reaches uuid at all: exceljs writes server-generated workbooks from our own report rows.
- **Status: not silently accepted.** Recorded here as a reasoned, evidence-backed *non-exploitable* finding. Options for the owner: (a) accept with this record; (b) add an npm `overrides` for `uuid` ^11.1.1 after exercising the XLSX export (exceljs's CJS `require('uuid')` with `{v4}` is compatible with uuid 11, but this is untested here); (c) replace exceljs. CI's gate (`--audit-level=high`) is unaffected because the advisory is moderate. This branch takes option (a) pending the owner's decision.

## PR #109 ("security: patch Next.js RCEs ... js-yaml/sharp", opened 2026-09-10)
Overlap and status: it pins `next 16.3.4`, sharp 0.35.4, js-yaml 4.3.2 and touches only `package.json` + the lockfile. Its CI was green when opened because the advisories listed above were published later. **Against today's advisory data it is insufficient**: next 16.3.4 and sharp 0.35.4 are still inside the vulnerable ranges, and it does not address zod, vitest, vite, source-map-js or brace-expansion. **Recommendation: supersede and close #109** in favour of this branch's PR (merging both would conflict in the lockfile and re-pin next to a vulnerable version). Updating #109 in place would produce the same diff as this branch with older history, so there is no reason to retain it. Close it only after this PR is approved and merged; do not merge #109.

## Not done / needs the owner
Approve or amend the dependency set; decide the `uuid` option; approve merging this PR and closing #109. The NewQuip integration/#121/#122 branches inherit the vulnerable versions until this is merged and they are merged or rebased.
