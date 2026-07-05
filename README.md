# Cin7 Core Toolbox — Do amazing things that you cannot do in Cin7 Core

Import product/BOM data once via CSV, keep multiple Cin7 Core instances (and, later, other clients) in sync from a single canonical source.

## Origin

Built for Casa das Natas (see `docs/`), designed to be reused across clients — org-scoped from the start.

## Stack

Next.js (App Router) + TypeScript on Vercel, Supabase (Postgres) for the canonical store, Vercel Cron for scheduled sync.

## Scope (current phase)

1. CSV import of products (`InventoryList` template), Assembly BOMs and Production BOMs into the canonical schema.
2. Settings UI to connect multiple Cin7 Core instances per organization.
3. Sync engine: idempotent upsert (create/update) of products + both BOM types into every connected instance.
4. Reporting consolidator — **later phase**, after the feeder is working.

## Data model

See `supabase/migrations/0001_canonical_schema.sql`. Key tables: `organizations`, `cin7_instances`, `products`, `price_tiers`, `assembly_bom_lines` (flat BOM), `production_bom_versions` / `production_bom_operations` / `production_bom_items` (routed BOM with work centres and resources), `sync_state` (per-instance sku → cin7_id map), `import_batches` / `import_rows` (CSV staging).

`content_hash` on `products` and `production_bom_versions` is trigger-maintained; the sync engine only pushes when it differs from `sync_state.synced_hash` for a given instance.

## Reference CSV templates

`docs/cin7-templates/` holds the exact Cin7 Core export templates the import parser targets: `InventoryList` (products), `AssemblyBOM`, `ProductionBOM`.

## Cin7 Core API

Reference: https://dearinventory.docs.apiary.io/. See `docs/cin7-api-findings.md` for verified
auth scheme, endpoints, pagination and rate limits — including that Production BOM push **is**
supported via API (`ProductionBom` resource), correcting the original proposal's assumption that
only Assembly BOMs would be needed. A few fields (Production BOM payload shape, Category/UOM
write support) are still unverified against a live sandbox — confirm those before extending
`src/cin7/`.

## Setup

```
cp .env.example .env.local   # fill in SUPABASE_SERVICE_ROLE_KEY and ENCRYPTION_KEY
npm install
npm run dev
```

Supabase project: `cin7core-feeder` (`pnzwjqjovxxdikxtfngq`, Spark org, eu-west-1).
