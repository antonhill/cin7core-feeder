import "server-only";
// UAT-029 persistence: updates ONLY the project manager, start date and target completion date of a project. LOCAL ONLY (no Cin7). Org-scoped like every Projects query.
// The patch type carries exactly those three columns, so the approved quotation, contract value, tax set-up, stages and claims cannot be reached from here.
import type { createServiceRoleClient } from "@/supabase/server";
import type { ProjectDetailsPatch } from "./project-details";

type Db = ReturnType<typeof createServiceRoleClient>;
export interface ProjectDetailsRow extends ProjectDetailsPatch { billing_scope: string; parent_project_id: string | null }

const COLUMNS = "project_manager, start_date, target_completion_date, billing_scope, parent_project_id";

export async function loadProjectDetails(db: Db, orgId: string, projectId: string): Promise<ProjectDetailsRow | null> {
  const r = await db.from("projects").select(COLUMNS).eq("org_id", orgId).eq("id", projectId).maybeSingle();
  if (r.error) throw new Error(`load project details: ${r.error.message}`);
  return (r.data as ProjectDetailsRow | null) ?? null;
}

/** Applies the patch and returns what it replaced. A variation's internal billing project has no details of its own: it belongs to the original project. */
export async function updateProjectDetails(db: Db, orgId: string, projectId: string, patch: ProjectDetailsPatch): Promise<{ before: ProjectDetailsPatch; after: ProjectDetailsPatch }> {
  const cur = await loadProjectDetails(db, orgId, projectId);
  if (!cur) throw new Error("Project not found.");
  if (cur.billing_scope === "VARIATION" || cur.parent_project_id) throw new Error("A variation's billing project has no details of its own; edit the original project.");
  const before: ProjectDetailsPatch = { project_manager: cur.project_manager, start_date: cur.start_date, target_completion_date: cur.target_completion_date };
  const r = await db.from("projects").update({ project_manager: patch.project_manager, start_date: patch.start_date, target_completion_date: patch.target_completion_date })
    .eq("org_id", orgId).eq("id", projectId).select("id");
  if (r.error) throw new Error(`update project details: ${r.error.message}`);
  if (!r.data || r.data.length !== 1) throw new Error("Project not found.");
  return { before, after: patch };
}
