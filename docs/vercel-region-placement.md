# Vercel function region placement

- The application's functions run in **dub1** (Dublin), next to the Supabase database (eu-west-1). Measured on isolated probes: one database round trip about 27 ms from dub1 versus about 131 ms from iad1.
- The Cin7 sync routes (`src/app/api/sync*/route.ts`) are pinned to **iad1**. They page through the Cin7 API, which is about +300 ms per request from Europe, and gain nothing from database proximity.
- `preferredRegion` cannot express this on Vercel (deprecated; accepts only auto/global/home), so the override is `functions[...].regions` in `vercel.json`. `src/lib/__tests__/vercel-regions.test.ts` keeps the pin in step with the cron list and route folders.

## Rollback

Delete the `regions` and `functions` keys from `vercel.json` (or revert the commit that added them) and redeploy. Functions return to the project default region (iad1). No data or schema is involved.

## Checking placement

`x-vercel-id` on any response ends with the region that ran the function (`<edge>::<function-region>::<id>`).
