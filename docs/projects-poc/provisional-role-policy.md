# Projects POC — provisional role policy

**Provisional production policy** (owner-approved for the POC, 2026-10). Not a general RBAC system; no Rep / Estimator / Manager roles are modelled yet.

| Capability | Who | Enforced where |
|---|---|---|
| View projects, stages, claims, components | Any member with **module access** to `/projects` | `requireModuleAccess` in every action (CCT-ADR-0010) |
| Report **physical** progress | Module user | `recordProgressAction` with `approvedPct = null` |
| Prepare / submit / cancel / **recalculate** draft claims | Module user | `createClaimDraftAction`, `submitClaimForApprovalAction`, `cancelDraftClaimAction`, `recalculateStaleDraftAction` |
| Approve **commercial completion** | Org **owner / admin** (or super-admin) | `requireOrgAdmin` when `approvedPct !== null` |
| Approve a **progress claim** | Org **owner / admin** | `approveClaimAction` → `requireOrgAdmin` |
| Create the golden fixture project | Org owner / admin | `seedGoldenProjectAction` |

Every action additionally proves, server-side and from the session only: authenticated user → module access → active organisation (never a caller argument) → the project belongs to that organisation (all queries scoped by `org_id`; another org's project is indistinguishable from "not found") → the requested status transition is legal (engine + DB trigger). RLS stays restrictive: members may only SELECT; there are no write policies, so the service role (allowlisted, `src/app/projects/actions.ts` only) is the sole writer.

Open for later: a finer Rep / Estimator / Manager split, and whether claim *drafting* should be narrower than module access.
