import "server-only";
// Reusable, versioned NewQuip project templates (migration 0111). A template only SEEDS the stages of a new project: the project keeps its own copy and a
// provenance record of the version, so editing or retiring a template later never changes an existing project. Until the migration is applied every read
// reports "unavailable" (never "no templates"), and the project-creation choices fall back to the built-in presets.
import type { createServiceRoleClient } from "@/supabase/server";
import type { ScheduleStageTemplate } from "@/newquip/quote/billing-schedule";
import { stagesFromInput, stagesFromStored, type TemplateStageInput } from "@/newquip/quote/project-template";

type Db = ReturnType<typeof createServiceRoleClient>;
function fail(message: string): never { throw new Error(message); }
const missingTable = (m: string) => /does not exist|schema cache|relation/i.test(m);
const PENDING = "Project templates are not available yet (database migration pending).";

export interface ProjectTemplate {
  id: string; name: string; description: string; status: "ACTIVE" | "RETIRED"; isDefault: boolean; createdByEmail: string; createdAt: string; updatedAt: string;
  latest: { version: number; stages: ScheduleStageTemplate[]; reason: string; createdByEmail: string; createdAt: string } | null;
}
export interface TemplateVersion { id: string; templateId: string; version: number; stages: ScheduleStageTemplate[]; reason: string; createdByEmail: string; createdAt: string }

interface TemplateRow { id: string; name: string; description: string; status: "ACTIVE" | "RETIRED"; is_default: boolean; created_by_email: string; created_at: string; updated_at: string }
interface VersionRow { id: string; template_id: string; version: number; stages: unknown; reason: string; created_by_email: string; created_at: string }
const toVersion = (v: VersionRow): TemplateVersion => ({ id: v.id, templateId: v.template_id, version: v.version, stages: stagesFromStored(v.stages), reason: v.reason, createdByEmail: v.created_by_email, createdAt: v.created_at });

/** Every template of the organisation with its newest version, or null when the table does not exist yet. */
export async function listTemplates(db: Db, orgId: string): Promise<ProjectTemplate[] | null> {
  const t = await db.from("newquip_project_templates").select("*").eq("org_id", orgId).order("name", { ascending: true });
  if (t.error) { if (missingTable(t.error.message)) return null; fail(t.error.message); }
  const v = await db.from("newquip_project_template_versions").select("*").eq("org_id", orgId).order("version", { ascending: false });
  if (v.error) fail(v.error.message);
  const latest = new Map<string, TemplateVersion>();
  for (const row of (v.data ?? []) as VersionRow[]) if (!latest.has(row.template_id)) latest.set(row.template_id, toVersion(row));
  return ((t.data ?? []) as TemplateRow[]).map((r) => {
    const l = latest.get(r.id);
    return { id: r.id, name: r.name, description: r.description, status: r.status, isDefault: r.is_default, createdByEmail: r.created_by_email, createdAt: r.created_at, updatedAt: r.updated_at,
      latest: l ? { version: l.version, stages: l.stages, reason: l.reason, createdByEmail: l.createdByEmail, createdAt: l.createdAt } : null };
  });
}

export async function listTemplateVersions(db: Db, orgId: string, templateId: string): Promise<TemplateVersion[] | null> {
  const v = await db.from("newquip_project_template_versions").select("*").eq("org_id", orgId).eq("template_id", templateId).order("version", { ascending: false });
  if (v.error) { if (missingTable(v.error.message)) return null; fail(v.error.message); }
  return ((v.data ?? []) as VersionRow[]).map(toVersion);
}

/** One template's NEWEST version, for applying to a project. Returns the template only if it belongs to the organisation and is ACTIVE. */
export async function loadActiveTemplateVersion(db: Db, orgId: string, templateId: string, version?: number): Promise<{ template: { id: string; name: string }; version: TemplateVersion } | null> {
  const t = await db.from("newquip_project_templates").select("*").eq("org_id", orgId).eq("id", templateId).maybeSingle();
  if (t.error) { if (missingTable(t.error.message)) fail(PENDING); fail(t.error.message); }
  const row = t.data as TemplateRow | null;
  if (!row) return null;
  if (row.status !== "ACTIVE") fail(`Template "${row.name}" is retired and cannot be used for a new project.`);
  let q = db.from("newquip_project_template_versions").select("*").eq("org_id", orgId).eq("template_id", templateId);
  if (version !== undefined) q = q.eq("version", version);
  const v = await q.order("version", { ascending: false }).limit(1);
  if (v.error) fail(v.error.message);
  const ver = ((v.data ?? []) as VersionRow[])[0];
  return ver ? { template: { id: row.id, name: row.name }, version: toVersion(ver) } : null;
}

function requireManager(gates: { isManager: boolean }) { if (!gates.isManager) fail("Only a manager (org owner/admin) can manage project templates."); }

function checkedStages(rows: readonly TemplateStageInput[]): ScheduleStageTemplate[] {
  const r = stagesFromInput(rows);
  if (!r.ok) fail(r.errors.join(" "));
  return r.stages;
}

async function insertVersion(db: Db, orgId: string, templateId: string, stages: ScheduleStageTemplate[], reason: string, email: string): Promise<TemplateVersion> {
  const ins = await db.from("newquip_project_template_versions").insert({ org_id: orgId, template_id: templateId, stages, reason, created_by_email: email }).select("*").single();
  if (ins.error || !ins.data) fail(missingTable(ins.error?.message ?? "") ? PENDING : `save template version: ${ins.error?.message ?? "no row"}`);
  return toVersion(ins.data as VersionRow);
}

/** Creates a template and its first version. The name must be unique in the organisation (case-insensitive). */
export async function createTemplate(db: Db, gates: { isManager: boolean }, email: string, input: { orgId: string; name: string; description?: string; stages: TemplateStageInput[]; makeDefault?: boolean }): Promise<ProjectTemplate> {
  requireManager(gates);
  const name = input.name.trim();
  if (!name) fail("A template needs a name.");
  const stages = checkedStages(input.stages);
  if (input.makeDefault) await clearDefault(db, input.orgId);
  const ins = await db.from("newquip_project_templates").insert({ org_id: input.orgId, name, description: (input.description ?? "").trim(), is_default: !!input.makeDefault, created_by_email: email }).select("*").single();
  if (ins.error || !ins.data) {
    const m = ins.error?.message ?? "";
    fail(missingTable(m) ? PENDING : /duplicate key|unique/i.test(m) ? `A template called "${name}" already exists.` : `create template: ${m || "no row"}`);
  }
  const row = ins.data as TemplateRow;
  const version = await insertVersion(db, input.orgId, row.id, stages, "Initial version", email);
  return { id: row.id, name: row.name, description: row.description, status: row.status, isDefault: row.is_default, createdByEmail: row.created_by_email, createdAt: row.created_at, updatedAt: row.updated_at,
    latest: { version: version.version, stages: version.stages, reason: version.reason, createdByEmail: version.createdByEmail, createdAt: version.createdAt } };
}

/** Saves the stages as a NEW version (the database numbers it). Earlier versions - and every project made from them - are untouched. */
export async function saveTemplateVersion(db: Db, gates: { isManager: boolean }, email: string, input: { orgId: string; templateId: string; stages: TemplateStageInput[]; reason: string }): Promise<TemplateVersion> {
  requireManager(gates);
  if (!input.reason.trim()) fail("A reason is required for a new template version.");
  const stages = checkedStages(input.stages);
  const t = await db.from("newquip_project_templates").select("id, status").eq("org_id", input.orgId).eq("id", input.templateId).maybeSingle();
  if (t.error) fail(missingTable(t.error.message) ? PENDING : t.error.message);
  if (!t.data) fail("Template not found.");
  if ((t.data as { status: string }).status !== "ACTIVE") fail("A retired template cannot be edited; activate it first.");
  return insertVersion(db, input.orgId, input.templateId, stages, input.reason.trim(), email);
}

export async function updateTemplateDetails(db: Db, gates: { isManager: boolean }, input: { orgId: string; templateId: string; name: string; description: string }): Promise<void> {
  requireManager(gates);
  const name = input.name.trim();
  if (!name) fail("A template needs a name.");
  const r = await db.from("newquip_project_templates").update({ name, description: input.description.trim() }).eq("org_id", input.orgId).eq("id", input.templateId).select("id");
  if (r.error) fail(/duplicate key|unique/i.test(r.error.message) ? `A template called "${name}" already exists.` : r.error.message);
  if (!r.data || r.data.length === 0) fail("Template not found.");
}

/** Copies the newest version of a template into a new template with the given name. */
export async function duplicateTemplate(db: Db, gates: { isManager: boolean }, email: string, input: { orgId: string; templateId: string; name: string }): Promise<ProjectTemplate> {
  requireManager(gates);
  const versions = await listTemplateVersions(db, input.orgId, input.templateId);
  if (versions === null) fail(PENDING);
  if (versions.length === 0) fail("Template not found.");
  const src = await db.from("newquip_project_templates").select("description").eq("org_id", input.orgId).eq("id", input.templateId).maybeSingle();
  const stages = versions[0].stages.map((s) => ({ name: s.name, percent: String(s.bps / 100), description: s.description, trigger: s.trigger }));
  return createTemplate(db, gates, email, { orgId: input.orgId, name: input.name, description: (src.data as { description?: string } | null)?.description ?? "", stages });
}

async function clearDefault(db: Db, orgId: string): Promise<void> {
  const r = await db.from("newquip_project_templates").update({ is_default: false }).eq("org_id", orgId).eq("is_default", true);
  if (r.error) fail(missingTable(r.error.message) ? PENDING : r.error.message);
}

export async function setTemplateStatus(db: Db, gates: { isManager: boolean }, input: { orgId: string; templateId: string; status: "ACTIVE" | "RETIRED" }): Promise<void> {
  requireManager(gates);
  const patch = input.status === "RETIRED" ? { status: "RETIRED", is_default: false } : { status: "ACTIVE" }; // a retired template can never stay the default
  const r = await db.from("newquip_project_templates").update(patch).eq("org_id", input.orgId).eq("id", input.templateId).select("id");
  if (r.error) fail(missingTable(r.error.message) ? PENDING : r.error.message);
  if (!r.data || r.data.length === 0) fail("Template not found.");
}

export async function setDefaultTemplate(db: Db, gates: { isManager: boolean }, input: { orgId: string; templateId: string | null }): Promise<void> {
  requireManager(gates);
  if (input.templateId === null) { await clearDefault(db, input.orgId); return; }
  const t = await db.from("newquip_project_templates").select("id, status").eq("org_id", input.orgId).eq("id", input.templateId).maybeSingle();
  if (t.error) fail(missingTable(t.error.message) ? PENDING : t.error.message);
  if (!t.data) fail("Template not found.");
  if ((t.data as { status: string }).status !== "ACTIVE") fail("Only an active template can be the default.");
  await clearDefault(db, input.orgId);
  const r = await db.from("newquip_project_templates").update({ is_default: true }).eq("org_id", input.orgId).eq("id", input.templateId).select("id");
  if (r.error) fail(r.error.message);
}
