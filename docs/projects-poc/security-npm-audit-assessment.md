# npm audit assessment (integration branch `feature/newquip-poc-integration` @ 903290a)

Assessment only. No dependency was changed on any product branch and `npm audit fix` was **not** run for real. The remediation below was trialled in a throwaway worktree (since removed) from the integration head; the result is a recommendation for a separate, owner-approved security PR.

Totals today: **11** (1 critical, 6 high, 4 moderate). Production-only (`--omit=dev`): **7** (1 critical, 4 high, 2 moderate). CI's `npm audit --audit-level=high` therefore fails on every branch that carries these versions (#121, #122, #123).

| Package (installed) | Severity | Direct? | Prod/dev | Advisory (summary) | Fixed in | Breaking risk | Exposure for us |
|---|---|---|---|---|---|---|---|
| **next 16.3.0** | **critical** | direct | prod | Unauthenticated RCE: Windows-hosted servers (GHSA-p293-qw3h-jr36); RCE in Image Optimization API with AVIF (GHSA-2xp9-vwfh-vxw4); RCE in `next/og` ImageResponse (GHSA-vcvr-r3jv-pc5j). Vulnerable range 16.0.0 - 16.4.0 | **16.4.3** (npm: semver-ok minor) | Low-moderate: this repo's Next has non-standard breaking changes (AGENTS.md); trial passed | We deploy on Vercel (Linux) so the Windows item does not apply. `next/image` is used (marketing home, nav, middleware) so the image-optimization item is potentially reachable; `next/og` is unused. **Treat as real; patch.** |
| sharp 0.35.3 | high | transitive (next) | prod | libheif / librsvg vulnerabilities (GHSA-rgj7-g3m4-5g8c, GHSA-wq5f-xc86-pv6w) | 0.35.5 | Low (lockfile bump) | Image optimisation on user-supplied images only; we optimise our own static assets. Patch with Next. |
| zod 4.4.3 | high | direct | prod | Memory exhaustion validating oversized constrained collections (GHSA-mrhx-c7xc-m3w5) | 4.6.6 (latest 4.6.7) | Low (minor within 4.x; 2,477 tests pass) | Used in 11 files, mostly server-side input validation; patch. |
| brace-expansion 1.1.18 / 2.1.4 / 5.0.9 | high | transitive | prod (via tooling) + dev | Quadratic-time expansion DoS (GHSA-q2hr-2g5m-vwhr) | >1.1.20 / >2.1.6 / >5.0.11 | Low (lockfile) | Reached via glob/minimatch in tooling, not on request paths. |
| js-yaml 4.3.1 | high | transitive (eslint) | dev | CPU DoS with empty merge sources (GHSA-2883-xcg3-v3hh) | 4.3.2 | Low | Dev tooling only. |
| source-map-js 1.2.1 | high | transitive (postcss/vite) | prod build + dev | Event-loop DoS via indexed source-map offsets (GHSA-68fv-2mgg-jv7q) | 1.2.2 | Low | Build time only. |
| vite 8.1.3 | high | transitive (vitest) | dev | launch-editor command execution / Windows escapes; custom-middleware cross-origin script; `server.fs.allow` bypass | >8.1.5 (trial resolved 8.3.5) | Low | Dev server only; not shipped. |
| vitest 4.1.9 / @vitest/mocker | moderate | direct / transitive | dev | Path traversal / arbitrary file read via mocker redirect; code injection via manual mock registration (GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8) | 4.1.12 | Low (stay on 4.x; `vitest@latest` is 5.0.5 and conflicts with the vite peer range) | Dev/CI test runner only. |
| exceljs 4.4.0 -> uuid 8.3.2 | moderate | direct -> transitive | prod | uuid missing buffer bounds check in v3/v5/v6 when `buf` is supplied (GHSA-w5hq-g745-h8pq). Vulnerable `<11.1.1` | **no exceljs release fixes it** (4.4.0 is latest; npm's offered "fix" is a downgrade to exceljs 3.4.0, which is wrong) | Medium if forced; none if accepted | exceljs uses `uuid` v4 without a caller-supplied buffer, so the vulnerable path (v3/v5/v6 with `buf`) is not reachable; used only for our XLSX exports and the price-snapshot script. |

## Dependency paths (representative)
- next -> sharp (optional image engine); next -> postcss -> source-map-js.
- zod -> (direct, root).
- vitest -> vite -> (launch-editor), vitest -> @vitest/mocker; eslint -> js-yaml; typescript-eslint / glob -> brace-expansion.
- exceljs -> uuid@8.3.2 (also exceljs -> archiver -> glob -> minimatch -> brace-expansion).

## Trial result (not committed to any product branch)
In a clean worktree of this head: `next@16.4.3`, `eslint-config-next@16.4.3`, `zod@^4.6.7`, `vitest@^4.1.12`, then `npm update sharp js-yaml brace-expansion source-map-js vite @vitest/mocker`:
- `npm audit`: **11 -> 2** (only `uuid` / `exceljs`, both moderate); no critical or high remain.
- `tsc --noEmit` clean, **2,477 tests pass**, eslint 0 errors, `next build` succeeds, and `next start` answers `/` 200 and redirects `/projects` to `/login`.
- `package.json` changes: next, eslint-config-next, zod, vitest (4 lines) plus a lockfile refresh.

## Observation about the open security PR #109
#109 ("patch Next.js RCEs ... sharp/js-yaml") pins **next 16.3.4**. Against today's advisory range (16.0.0 - 16.4.0, fixed 16.4.3) 16.3.4 is **still inside the vulnerable range**. It should be re-targeted to 16.4.3 (or superseded) before it is merged; I did not touch it.

## Recommendation
1. One dedicated security PR from `main` (not stacked on the NewQuip work): `next` and `eslint-config-next` to **16.4.3**, `zod` to **^4.6.7**, `vitest` to **^4.1.12**, and a targeted lockfile update of sharp / js-yaml / brace-expansion / source-map-js / vite / @vitest/mocker. Never `npm audit fix --force` (it would downgrade exceljs).
2. For the residual `uuid` advisory: record a reasoned risk acceptance (unreachable path) or add an npm `overrides` for `uuid` ^11.1.1 only after exercising the XLSX export. Then relax CI to `--omit=dev --audit-level=high` for the production gate and keep a separate non-blocking dev report.
3. Merge #109's intent into that PR and close it or re-point it to 16.4.3.
4. Verify on a Preview (`next build`, a real `next start` request, XLSX export) before merging; Next here has non-standard conventions (AGENTS.md).
5. This is independent of the NewQuip POC and must not be bundled with it.

Not done / not decided: no dependency was upgraded on #121, #122, #123 or main; whether to accept the residual `uuid` risk is an owner decision.
