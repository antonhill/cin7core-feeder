import { pageContainerClass } from "@/app/PageContainer";
import { Alert } from "@/components/ui/Alert";
import { createServiceRoleClient } from "@/supabase/server";
import { requireModuleAccess } from "@/lib/authorization";
import { PROJECTS_MODULE } from "@/app/module-nav";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { listProjectViews } from "@/lib/projects/project-store";
import { claimListRows, type ClaimListRow } from "@/newquip/claims-list";
import { ClaimsTable } from "./ClaimsTable";

// Every progress claim across the organisation's projects, read-only. Claims are created, submitted and approved inside each project's workspace; this page only
// lists them and links there. Reads through the existing project store (same data and access as the Projects list); writes nothing and never calls Cin7.
export const dynamic = "force-dynamic";

export default async function ClaimsPage() {
  let rows: ClaimListRow[] = [];
  let error: string | null = null;
  try {
    await requireNewquipPocOrg();
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    rows = claimListRows(await listProjectViews(createServiceRoleClient(), orgId));
  } catch (e) {
    error = e instanceof Error ? e.message : "The claims could not be loaded.";
  }
  return (
    <main className={`${pageContainerClass("data")} space-y-4`}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Claims</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-700">Progress claims across all projects. Open a claim&rsquo;s project to prepare, submit or review it. Nothing on this page changes anything.</p>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : <ClaimsTable rows={rows} />}
    </main>
  );
}
