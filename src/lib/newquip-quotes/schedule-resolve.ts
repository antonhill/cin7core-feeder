import "server-only";
// The billing schedule a quotation / project uses. Shared by customer-document issue and project creation so both resolve it identically.
import type { createServiceRoleClient } from "@/supabase/server";
import { resolveScheduleChoice, type ScheduleChoice, type ScheduleStageTemplate } from "@/newquip/quote/billing-schedule";
import { sameSchedule, type ScheduleSource } from "@/newquip/quote/project-template";
import { loadActiveTemplateVersion } from "@/lib/projects/project-template-store";

/**
 * The schedule a new project is created with. A TEMPLATE choice is re-read from the database (org-scoped, ACTIVE only) - the client's copy of the stages is
 * only honoured as a per-project customisation, which is re-validated to 100% - and the version used is recorded in the project's provenance.
 */
export async function resolveProjectSchedule(db: ReturnType<typeof createServiceRoleClient>, orgId: string, choice?: ScheduleChoice): Promise<{ schedule: readonly ScheduleStageTemplate[]; label: string; source: ScheduleSource }> {
  if (choice?.preset === "TEMPLATE") {
    if (!choice.templateId) throw new Error("Choose a project template.");
    const t = await loadActiveTemplateVersion(db, orgId, choice.templateId);
    if (!t) throw new Error("Project template not found.");
    let schedule: readonly ScheduleStageTemplate[] = t.version.stages;
    if (choice.stages) {
      const custom = resolveScheduleChoice(choice);
      if (!custom.ok) throw new Error(`Billing schedule: ${custom.errors.join(" ")}`);
      const byName = new Map(t.version.stages.map((s) => [s.name.trim().toLowerCase(), s]));
      schedule = custom.schedule.map((s) => { const o = byName.get(s.name.trim().toLowerCase()); return o ? { ...s, description: o.description, trigger: o.trigger } : s; });
    }
    const customised = !sameSchedule(schedule, t.version.stages);
    return { schedule, label: `${t.template.name} v${t.version.version}${customised ? " (customised for this project)" : ""}`,
      source: { kind: "TEMPLATE", templateId: t.template.id, templateName: t.template.name, templateVersion: t.version.version, customised } };
  }
  const resolved = resolveScheduleChoice(choice);
  if (!resolved.ok) throw new Error(`Billing schedule: ${resolved.errors.join(" ")}`);
  return { schedule: resolved.schedule, label: resolved.label, source: { kind: !choice || choice.preset === "STANDARD" ? "STANDARD" : choice.preset === "SIX_STAGE" ? "SIX_STAGE" : "CUSTOM" } };
}
