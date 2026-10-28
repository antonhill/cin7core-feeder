# Integration Preview configuration (verified read-only, 2026-10-28)

Method: Vercel CLI/API metadata for project `cin7core-feeder` (names, targets, branch scopes, variable *types*). No credential value was printed, written to disk or disclosed. Only non-secret facts were derived: a flag's equality with the string "true", and the Supabase **project ref** of a variable whose type allows reading it. Nothing was changed in Vercel or Supabase.

## What is configured
| Variable | Scope | Type | Finding |
|---|---|---|---|
| `NEWQUIP_CIN7_WRITES_ENABLED` | Preview, branch `feature/cin7-claim-posting` only | encrypted (readable) | Exactly `"true"`. **Writes are ON for the #122 Preview.** No entry for `feature/newquip-poc-integration`, none unscoped, none for Production or Development. |
| `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `ENCRYPTION_KEY` (unscoped) | Preview **and** Production (one entry covers both targets) | sensitive (Vercel never returns the value) | The integration branch inherits these. Their values **cannot be read back**, so the project they point at cannot be proven from outside. Because the same entry serves Production, they are Production's configuration. |
| Same five variables | Preview, branch `feature/newquip-projects-poc` (overrides) | `NEXT_PUBLIC_*` readable, others sensitive | `NEXT_PUBLIC_SUPABASE_URL` points at project ref `witulfbpotimvbfiqbwq`, which is **not** a project in the connected Supabase account (the account has `cin7toolbox` = `pnzwjqjovxxdikxtfngq`, `Cashflow App`, `tradingbot-control-plane`). A stale or foreign override; do not reuse it. |

## Conclusions
1. **Integration branch write flag: OFF** (unset). Additionally the code now forces writes OFF unless the flag is exactly `"true"`, the deployment is not Production, **and both Supabase URLs point at `pnzwjqjovxxdikxtfngq`** (`src/lib/projects/write-flag.ts`). A Preview wired to any other database cannot write to Cin7 even if the flag were turned on.
2. **Effective Supabase project: not provable from Vercel metadata** (sensitive values). It is verified **at runtime** by the P0 checklist (`ENV_SUPABASE_PROJECT`), which reads the deployment's own environment and reports PASS only when both URLs resolve to `pnzwjqjovxxdikxtfngq`, FAIL (naming the other project ref and nothing else) otherwise. The hosted project `pnzwjqjovxxdikxtfngq` is the app's database: the NewQuip POC organisation is one organisation in it, so a correctly wired Preview works on that organisation's data (and the same database serves Production).
3. **Needs the owner's attention:** the `feature/cin7-claim-posting` Preview has writes enabled. The integration work does not change that; unset it when finished with #122: `vercel env rm NEWQUIP_CIN7_WRITES_ENABLED preview feature/cin7-claim-posting --scope spark18` (owner action; not performed).

## If P0 reports `ENV_SUPABASE_PROJECT: FAIL` - the exact branch-scoped change
In Vercel, project `cin7core-feeder`, Settings, Environment Variables, add the following for **Preview only, Git branch `feature/newquip-poc-integration`** (do **not** edit or overwrite the unscoped entries):
- `SUPABASE_URL` = `https://pnzwjqjovxxdikxtfngq.supabase.co` (mark sensitive)
- `NEXT_PUBLIC_SUPABASE_URL` = `https://pnzwjqjovxxdikxtfngq.supabase.co`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` = that project's anon key (Supabase dashboard, Project Settings, API)
- `SUPABASE_SERVICE_ROLE_KEY` = that project's service-role key (sensitive; Preview only)
- `ENCRYPTION_KEY` = the key that encrypted the stored Cin7 credentials (without it a Preview cannot decrypt the Cin7 connection and P0 fails at the Cin7 reads)
Equivalent CLI: `vercel env add <NAME> preview feature/newquip-poc-integration --scope spark18` for each. Then redeploy the branch and re-run P0. Keys are entered by the owner; this document and the assistant never see them.
Keep `NEWQUIP_CIN7_WRITES_ENABLED` **unset** for this branch until a specific proof (P1+) is approved; then add it scoped to this branch only, and remove it afterwards.
