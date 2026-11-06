"use server";

// NewQuip: manage reusable project (billing milestone) templates. Authorisation is re-established inside EVERY action; reads need NewQuip + Quotes
// access, every write needs an org manager (owner/admin). Nothing here touches an existing project or Cin7. Only async functions and erased types are exported.
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { logActivity } from "@/lib/activity-log";
import { createServiceRoleClient } from "@/supabase/server";
import { QUOTES_MODULE } from "@/app/module-nav";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import type { TemplateStageInput } from "@/newquip/quote/project-template";
import {
  createTemplate, duplicateTemplate, listTemplates, listTemplateVersions, saveTemplateVersion, setDefaultTemplate, setTemplateStatus, updateTemplateDetails,
  type ProjectTemplate, type TemplateVersion,
} from "@/lib/projects/project-template-store";

export interface TemplateActionResult<T> { ok: boolean; error?: string; data?: T }
const msg = (e: unknown) => (e instanceof Error ? e.message : "Unexpected error");

async function actor() {
  const { orgId } = await requireNewquipPocOrg();
  const access = await requireModuleAccess(QUOTES_MODULE.href);
  let manager = false;
  try { await requireOrgAdmin("manage NewQuip project templates"); manager = true; } catch { manager = false; } // fail closed
  return { orgId, userId: access.userId, email: access.email ?? "unknown", manager };
}

async function audit(a: Awaited<ReturnType<typeof actor>>, action: string, summary: string, detail: Record<string, unknown>) {
  await logActivity(createServiceRoleClient(), { orgId: a.orgId, actor: { userId: a.userId, email: a.email }, action, summary, detail }).catch(() => undefined);
}

export async function listProjectTemplatesAction(): Promise<TemplateActionResult<{ templates: ProjectTemplate[]; unavailable: boolean; canManage: boolean }>> {
  try {
    const a = await actor();
    const t = await listTemplates(createServiceRoleClient(), a.orgId);
    return { ok: true, data: { templates: t ?? [], unavailable: t === null, canManage: a.manager } };
  } catch (e) { return { ok: false, error: msg(e) }; }
}

export async function listTemplateVersionsAction(templateId: string): Promise<TemplateActionResult<TemplateVersion[]>> {
  try {
    const a = await actor();
    return { ok: true, data: (await listTemplateVersions(createServiceRoleClient(), a.orgId, templateId)) ?? [] };
  } catch (e) { return { ok: false, error: msg(e) }; }
}

export async function createProjectTemplateAction(input: { name: string; description?: string; stages: TemplateStageInput[]; makeDefault?: boolean }): Promise<TemplateActionResult<ProjectTemplate>> {
  try {
    const a = await actor();
    const t = await createTemplate(createServiceRoleClient(), { isManager: a.manager }, a.email, { orgId: a.orgId, ...input });
    await audit(a, "newquip.project_template_created", `Created project template "${t.name}"`, { templateId: t.id, stages: input.stages.length });
    return { ok: true, data: t };
  } catch (e) { return { ok: false, error: msg(e) }; }
}

export async function saveProjectTemplateVersionAction(templateId: string, stages: TemplateStageInput[], reason: string): Promise<TemplateActionResult<TemplateVersion>> {
  try {
    const a = await actor();
    const v = await saveTemplateVersion(createServiceRoleClient(), { isManager: a.manager }, a.email, { orgId: a.orgId, templateId, stages, reason });
    await audit(a, "newquip.project_template_versioned", `Saved version ${v.version} of a project template`, { templateId, version: v.version, reason });
    return { ok: true, data: v };
  } catch (e) { return { ok: false, error: msg(e) }; }
}

export async function updateProjectTemplateDetailsAction(templateId: string, name: string, description: string): Promise<TemplateActionResult<null>> {
  try {
    const a = await actor();
    await updateTemplateDetails(createServiceRoleClient(), { isManager: a.manager }, { orgId: a.orgId, templateId, name, description });
    await audit(a, "newquip.project_template_renamed", `Updated project template "${name.trim()}"`, { templateId });
    return { ok: true, data: null };
  } catch (e) { return { ok: false, error: msg(e) }; }
}

export async function duplicateProjectTemplateAction(templateId: string, name: string): Promise<TemplateActionResult<ProjectTemplate>> {
  try {
    const a = await actor();
    const t = await duplicateTemplate(createServiceRoleClient(), { isManager: a.manager }, a.email, { orgId: a.orgId, templateId, name });
    await audit(a, "newquip.project_template_duplicated", `Duplicated a project template as "${t.name}"`, { from: templateId, templateId: t.id });
    return { ok: true, data: t };
  } catch (e) { return { ok: false, error: msg(e) }; }
}

export async function setProjectTemplateStatusAction(templateId: string, status: "ACTIVE" | "RETIRED"): Promise<TemplateActionResult<null>> {
  try {
    const a = await actor();
    await setTemplateStatus(createServiceRoleClient(), { isManager: a.manager }, { orgId: a.orgId, templateId, status });
    await audit(a, "newquip.project_template_status", `${status === "RETIRED" ? "Retired" : "Activated"} a project template`, { templateId, status });
    return { ok: true, data: null };
  } catch (e) { return { ok: false, error: msg(e) }; }
}

export async function setDefaultProjectTemplateAction(templateId: string | null): Promise<TemplateActionResult<null>> {
  try {
    const a = await actor();
    await setDefaultTemplate(createServiceRoleClient(), { isManager: a.manager }, { orgId: a.orgId, templateId });
    await audit(a, "newquip.project_template_default", templateId ? "Set the default project template" : "Cleared the default project template", { templateId });
    return { ok: true, data: null };
  } catch (e) { return { ok: false, error: msg(e) }; }
}
