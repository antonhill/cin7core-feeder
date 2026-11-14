# RWTSA live Cin7 snapshot (Phase 1)

A **separate, read-only** module that takes an owner-triggered snapshot of the **dedicated RWTSA Cin7 instance** and reconciles it,
offline, against the protected workbook. It lives **outside** the RWTSA standalone-shell import boundary (`src/rwtsa-demo`,
`rwtsa-demo/`, `scripts/rwtsa-demo`), which still forbids any network or Cin7 code. Nothing in the shell, the engines or Scenarios A-D
imports this module (tested), so a snapshot can never silently replace a workbook-driven input.

## What it does and does not do
| | |
|---|---|
| Network | `GET` only; three allowlisted paths (`/ref/location`, `/ref/productavailability`, `/product`); the one fixed Cin7 origin; redirects refused. Phase 3 adds the production read paths to `policy.ts` only. |
| Trigger | Explicit: `--i-confirm-read-only-snapshot`. No polling, timers, page-load calls or startup connections. |
| Pacing | Process-local pacer (about 48 requests/min); 429/503 retried with bounded backoff, then a clear `RATE_LIMITED` error. It does **not** use the Toolbox's database-backed limiter (no Supabase). |
| Credentials | `~/rwtsa-local/credentials/cin7.env` only; owner-only permissions (dir 700, file 600), real file, not in a git tree, three allowed keys, no environment variables read. |
| Output | `~/rwtsa-local/cin7-snapshots/`, atomic, `0600`, never overwritten, content-hashed, credentials refused. |
| Logs | Counts and error codes only: no SKU, location name, quantity, credential or response body. |

## Setup (owner)
```
mkdir -p ~/rwtsa-local/credentials && chmod 700 ~/rwtsa-local/credentials
# cin7.env  (chmod 600)
RWTSA_CIN7_ACCOUNT_ID=...
RWTSA_CIN7_APPLICATION_KEY=...
RWTSA_CIN7_INSTANCE_LABEL=rwtsa-demo-instance      # a non-secret label recorded in each snapshot
# locations.json  (chmod 600)  - location GUIDs from the dedicated instance; Bond is required
{ "BOND": "<guid>", "JHB": "<guid>", "DURBAN": "<guid>", "CAPE_TOWN": "<guid>", "FACTORY_STORE": "<guid>" }
# identity.json  (chmod 600)  - account identity: NOT the label
{ "accountIdSha256": "<sha256 of the RWTSA account ID>" }       # compute: printf %s "$ACCOUNT_ID" | shasum -a 256
# after the first run reports the fingerprint, and ONLY if it is the intended RWTSA instance, the owner adds:
{ "accountIdSha256": "...", "approvedFingerprint": "<64-hex fingerprint of the account's location-ID set>" }
```
Use a **read-only** Cin7 API application on the **dedicated RWTSA instance**. Never reuse NewQuip or production credentials.

```
npx tsx scripts/rwtsa-live/snapshot.ts --i-confirm-read-only-snapshot
npx tsx scripts/rwtsa-live/reconcile.ts --snapshot <file> --workbook <protected workbook> [--known known-transactions.json]
```

## Account identity (fails closed; never just a label)
The run first makes ONE bounded GET of the location list and computes a fingerprint of the account's location-ID set (GUIDs unique to a
Cin7 account). It then proceeds to stock only if (a) SHA-256 of the configured account ID equals `accountIdSha256` and (b) the fingerprint
equals the owner-approved `approvedFingerprint`. There is **no trust-on-first-use**: with no approved fingerprint the run stops, writes
`identity-check-<time>.json` (hashes and counts only), and prints the fingerprint for the owner to confirm. Any mismatch stops the run with
the same evidence file; no stock or product endpoint is called (tested).

## Location identity
Bond (and the other four roles) are identified by **location ID** from `locations.json`, and each ID must exist in the account's own
`/ref/location` list. The confirmed `/ref/productavailability` row names its location by **display name**, so the join is name -> ID
using the same snapshot's location list. If any display name is shared by two locations, or a stock row's location cannot be resolved
to exactly one known ID, the snapshot is marked **INCOMPLETE** (fail closed). If a live response carries a location ID field, it is preferred.
The field names actually seen are recorded in the snapshot (`contract`) as verification evidence. The first live run (14 Nov 2026, dedicated RWTSA POC instance) verified the contract: 3 GET requests, complete, no duplicates, identity VERIFIED, every location resolved by ID. Instance label is metadata only; identity is the account-ID hash plus the owner-approved location-ID fingerprint.

## Stock definitions (same as the workbook's rule)
- `physical` = sum of OnHand over the five mapped roles (Bond included); locations outside the map are reported (`unmapped`), never merged.
- `bond` = OnHand at the Bond location. `unrestricted` = physical - bond.
- `usable` = unrestricted - allocated at the four non-Bond roles. **Bond is never usable before release.** Phase 2 owns the full rule.

## Boundary enforcement
`src/rwtsa-live/__tests__/boundary.test.ts` parses every file with the TypeScript AST (not text), so comment/string tricks cannot hide an
import or call. Only `client.ts` may touch `fetch` or hold the Cin7 auth header names; every `method` must be the literal `"GET"`; imports are
allowlisted; `process.env`, dynamic loading and `setInterval` are banned; and no file in `src/`, `scripts/` or `rwtsa-demo/` may import this
module. The repo-wide gateway test allows the header names in exactly two files: `cin7/http.ts` and `rwtsa-live/client.ts`.

## Reconciliation
Report only; never forces agreement and never substitutes workbook values into Cin7 quantities. Each SKU gets four separate verdicts plus an overall status.

| Dimension | Statuses | Rule |
|---|---|---|
| Physical | `MATCH` / `EXPLAINED_KNOWN` / `UNEXPLAINED` | delta equals the owner-supplied known transactions (physicalDelta) or it is unexplained. A known transaction that Cin7 does **not** show is `UNEXPLAINED` (the claim is not taken on trust). |
| Bond | same | delta equals the known `bondDelta`. |
| Allocation | `MATCH` / `SOURCE_ONLY_ALLOCATION` / `UNEXPLAINED` | `SOURCE_ONLY_ALLOCATION` only when the owner passed `--accept-source-only-allocations`, the workbook commits units, **and Cin7 has no allocation at all**. A partial or larger Cin7 allocation, or a Cin7 allocation with no commitment, stays `UNEXPLAINED`. |
| Usable | `MATCH` / `EXPLAINED` / `UNEXPLAINED` | delta usable = known non-Bond movement + accepted source-only allocation. A Bond receipt never explains usable stock. |

Overall `status`: `UNEXPLAINED` if any dimension is; else `KNOWN_SOURCE_ONLY_ALLOCATION` if the allocation is source-only; else `EXPLAINED` / `MATCH`. `ONLY_IN_WORKBOOK` / `ONLY_IN_CIN7` are unchanged.
Both availabilities are shown: **Cin7 operational** (the snapshot's own usable) and **RWTSA planning** (derived: Cin7 non-Bond stock less the source workbook's committed units; a planning figure, never written into Cin7 numbers).
The source-only acceptance is recorded in the output (`summary.sourceOnlyAllocationsAccepted`); without the flag the same SKUs are reported `UNEXPLAINED`.

```
npx tsx scripts/rwtsa-live/reconcile.ts --snapshot <file> --workbook <protected workbook> --known <known-transactions.json> [--accept-source-only-allocations]
```
The module does not assume what the known transactions did; raw-material (component) consumption is **not** verified by a stock snapshot (Cin7's availability list omits zero-stock rows) and needs an independent movement report.
