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
```
Use a **read-only** Cin7 API application on the **dedicated RWTSA instance**. Never reuse NewQuip or production credentials.

```
npx tsx scripts/rwtsa-live/snapshot.ts --i-confirm-read-only-snapshot
npx tsx scripts/rwtsa-live/reconcile.ts --snapshot <file> --workbook <protected workbook> [--known known-transactions.json]
```

## Location identity
Bond (and the other four roles) are identified by **location ID** from `locations.json`, and each ID must exist in the account's own
`/ref/location` list. The confirmed `/ref/productavailability` row names its location by **display name**, so the join is name -> ID
using the same snapshot's location list. If any display name is shared by two locations, or a stock row's location cannot be resolved
to exactly one known ID, the snapshot is marked **INCOMPLETE** (fail closed). If a live response carries a location ID field, it is preferred.
The field names actually seen are recorded in the snapshot (`contract`) as verification evidence; **no live contract has been verified yet**.

## Stock definitions (same as the workbook's rule)
- `physical` = sum of OnHand over the five mapped roles (Bond included); locations outside the map are reported (`unmapped`), never merged.
- `bond` = OnHand at the Bond location. `unrestricted` = physical - bond.
- `usable` = unrestricted - allocated at the four non-Bond roles. **Bond is never usable before release.** Phase 2 owns the full rule.

## Reconciliation
Report only; never forces agreement. A difference is `EXPLAINED` only by an owner-supplied known-transactions file (e.g. MO-00001,
PO-00002 with their SKU quantities); otherwise it is `UNEXPLAINED`. The module does not assume what those transactions did.
