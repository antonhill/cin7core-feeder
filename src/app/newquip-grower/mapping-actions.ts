"use server";

// NewQuip: the reusable product mappings and the internal physical-scope view of a quotation. Nothing here writes to Cin7: the SKU check is a
// read-only catalogue lookup. Authorisation is re-established inside EVERY action. Only async functions and erased types are exported.
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { logActivity } from "@/lib/activity-log";
import { createServiceRoleClient } from "@/supabase/server";
import { QUOTES_MODULE } from "@/app/module-nav";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { NEWQUIP_POC_CIN7_INSTANCE_ID } from "@/newquip/access";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import type { QuoteDraft } from "@/newquip/grower/draft";
import { evaluationContext } from "@/lib/newquip-quotes/context";
import { loadQuote } from "@/lib/newquip-quotes/quote-store";
import { quoteScopeView, type QuoteScopeView } from "@/lib/newquip-quotes/scope-preview";
import { libraryOf, listActiveMappings, listMappingVersions, saveMappingVersion, type PackageMapping } from "@/lib/projects/package-mapping-store";
import { buildSaleCreationPort } from "@/lib/projects/cin7-sale-creation-adapter";

export interface MappingActionResult<T> { ok: boolean; error?: string; data?: T }
const msg = (e: unknown) => (e instanceof Error ? e.message : "Unexpected error");

async function actor() {
  const { orgId } = await requireNewquipPocOrg();
  const access = await requireModuleAccess(QUOTES_MODULE.href);
  let manager = false;
  try { await requireOrgAdmin("manage NewQuip product mappings"); manager = true; } catch { manager = false; } // fail closed
  return { orgId, userId: access.userId, email: access.email ?? "unknown", manager };
}

/**
 * The internal physical scope of a quote: what each package expands to, with the active reusable mappings applied, and every item that still has
 * no mapping. Pass the editor's current draft to see it live; an approved quote always shows its sealed register. Writes nothing.
 */
export async function getQuoteScopeAction(quoteId: string, draft?: QuoteDraft): Promise<MappingActionResult<QuoteScopeView & { canManageMappings: boolean }>> {
  try {
    const a = await actor();
    const db = createServiceRoleClient();
    const q = await loadQuote(db, a.orgId, quoteId);
    if (!q) throw new Error("Quote not found.");
    const final = q.state === "MANAGER_APPROVED_FINAL" ? q.accepted_baseline : null;
    const library = final ? null : await listActiveMappings(db, a.orgId);
    const evaluation = evaluateDraft(final ? q.draft : (draft ?? q.draft), evaluationContext(true)); // cost withheld: the scope carries none
    return { ok: true, data: { ...quoteScopeView({ finalBaseline: final, evaluation, library: library ? libraryOf(library) : null, now: new Date().toISOString() }), canManageMappings: a.manager } };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

/** Every version of one package's mapping (newest first) with who saved it and why. Read-only. */
export async function getMappingHistoryAction(packageKey: string): Promise<MappingActionResult<{ versions: PackageMapping[]; unavailable: boolean }>> {
  try {
    const a = await actor();
    const versions = await listMappingVersions(createServiceRoleClient(), a.orgId, packageKey);
    return { ok: true, data: { versions: versions ?? [], unavailable: versions === null } };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

/**
 * Manager only. Saves a NEW version of a package's reusable mapping (earlier versions are kept, never edited). Every SKU is verified to exist in
 * Cin7 by an exact, read-only lookup first. It affects FUTURE quotations only: approved quotations and existing projects keep their own sealed copy.
 */
export async function saveReusableMappingAction(packageKey: string, lines: Array<{ sku: string; factor: number; unit?: string; role?: "FINISHED_GOOD" | "BOM_COMPONENT" }>, reason: string): Promise<MappingActionResult<PackageMapping>> {
  try {
    const a = await actor();
    if (!a.manager) throw new Error("Only a manager (org owner/admin) can save a reusable mapping.");
    const db = createServiceRoleClient();
    const inst = await db.from("cin7_instances").select("id").eq("org_id", a.orgId).eq("active", true);
    if (inst.error) throw new Error(inst.error.message);
    const ids = ((inst.data ?? []) as Array<{ id: string }>).map((i) => i.id);
    if (ids.length !== 1 || ids[0] !== NEWQUIP_POC_CIN7_INSTANCE_ID) throw new Error("SKUs can only be verified against the single expected NewQuip POC Cin7 instance; it is not.");
    const saved = await saveMappingVersion(db, buildSaleCreationPort(db, a.orgId, ids[0]), { isManager: a.manager }, a.email, { orgId: a.orgId, packageKey, lines, reason });
    await logActivity(db, { orgId: a.orgId, actor: { userId: a.userId, email: a.email }, action: "newquip.package_mapping_saved", summary: `Saved reusable mapping ${saved.package_key} v${saved.version} (no Cin7 write)`, detail: { packageKey: saved.package_key, version: saved.version, lines: saved.lines, reason } });
    return { ok: true, data: saved };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}
