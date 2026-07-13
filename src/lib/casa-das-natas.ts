// Casa das Natas org id, looked up once (live, 2026-07-13) and hardcoded —
// the individual-nata sales + packaging-COGS report is explicitly a
// single-org feature per Anton's request, not a generic platform
// capability. Hardcoding the id (not the org name) since names are
// editable in Settings and ids aren't. If this ever needs to generalize
// to other orgs, replace this constant with a proper per-org
// report-visibility flag instead of adding more hardcoded ids here.
//
// Deliberately no server-only imports in this file (no requireCurrentOrg,
// no Supabase clients) — it's imported directly by the client-side
// ReportsNav to decide whether to show the nav link, and pulling a
// server-only module into a "use client" component breaks the client
// bundle. See src/lib/require-casa-das-natas-org.ts for the server-side
// guard that uses this constant.
export const CASA_DAS_NATAS_ORG_ID = "0242e481-0f2b-4bd9-a8ef-2d4a9554bc09";
