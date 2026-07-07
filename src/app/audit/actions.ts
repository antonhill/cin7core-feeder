"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import { logActivity } from "@/lib/activity-log";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllProductsWithBom } from "@/cin7/products";
import { fetchAllCustomers } from "@/cin7/customers";
import { fetchAllSuppliers } from "@/cin7/suppliers";
import { runProductAudit, type ProductAuditResult } from "@/audit/product-audit";
import { runPartyAudit, type PartyAuditResult, type PartyKind } from "@/audit/party-audit";
import {
  applyProductFixes,
  mergeCategoryNames,
  mergeBrandNames,
  mergeUOMNames,
  mergeTagNames,
  applyAttributeTemplate,
  type ApplyFixesResult,
  type ProductFix,
} from "@/audit/apply-fixes";
import { applyPartyFixes, type ApplyPartyFixesResult, type PartyFix } from "@/audit/apply-party-fixes";

export interface AuditActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

/** "3 succeeded, 1 failed" / "3 succeeded" — the common suffix for every activity-log summary below. */
function resultSuffix(result: { succeeded: number; failed: unknown[] }): string {
  return result.failed.length > 0 ? `${result.succeeded} succeeded, ${result.failed.length} failed` : `${result.succeeded} succeeded`;
}

/** Pulls every product live from the chosen instance and runs the consistency/accuracy checks — read-only, nothing is written. */
export async function runProductAuditAction(instanceId: string): Promise<AuditActionResult<ProductAuditResult>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);
    const products = await fetchAllProductsWithBom(creds);
    return { ok: true, data: runProductAudit(products) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function applyProductFixesAction(instanceId: string, fixes: ProductFix[]): Promise<AuditActionResult<ApplyFixesResult>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  if (!fixes.length) return { ok: false, error: "Nothing to apply." };
  try {
    const { orgId, userId, email } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);
    const result = await applyProductFixes(creds, fixes);

    const fieldNames = [...new Set(fixes.flatMap((f) => Object.keys(f.fields)))];
    await logActivity(db, {
      orgId,
      instanceId,
      actor: { userId, email },
      action: "audit.apply_fixes",
      summary: `Set ${fieldNames.join(", ")} on ${resultSuffix(result)}`,
      detail: { fields: fieldNames, productIds: fixes.map((f) => f.productId), failed: result.failed },
    });

    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Shared by the 4 near-duplicate-value merge actions below — same request shape, same activity-log entry shape. */
async function mergeAction(
  instanceId: string,
  fromNames: string[],
  toName: string,
  fieldLabel: string,
  action: string,
  merge: (creds: Awaited<ReturnType<typeof loadCin7Credentials>>, fromNames: string[], toName: string) => Promise<ApplyFixesResult>
): Promise<AuditActionResult<ApplyFixesResult>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  if (!toName.trim()) return { ok: false, error: `Choose which ${fieldLabel} to keep.` };
  try {
    const { orgId, userId, email } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);
    const result = await merge(creds, fromNames, toName);

    await logActivity(db, {
      orgId,
      instanceId,
      actor: { userId, email },
      action,
      summary: `Merged ${fieldLabel}s ${fromNames.map((n) => `"${n}"`).join(", ")} into "${toName}" (${resultSuffix(result)})`,
      detail: { fromNames, toName, failed: result.failed },
    });

    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

// Standing rule for this codebase: a "use server" file may only export async
// functions (see docs/PROJECT-NOTES.md) — these delegate to mergeAction but
// are still declared `async function`, not a plain function returning a
// Promise, to stay unambiguously inside that rule.
export async function mergeCategoryAction(instanceId: string, fromNames: string[], toName: string): Promise<AuditActionResult<ApplyFixesResult>> {
  return mergeAction(instanceId, fromNames, toName, "category", "audit.merge_category", mergeCategoryNames);
}

export async function mergeBrandAction(instanceId: string, fromNames: string[], toName: string): Promise<AuditActionResult<ApplyFixesResult>> {
  return mergeAction(instanceId, fromNames, toName, "brand", "audit.merge_brand", mergeBrandNames);
}

export async function mergeUOMAction(instanceId: string, fromNames: string[], toName: string): Promise<AuditActionResult<ApplyFixesResult>> {
  return mergeAction(instanceId, fromNames, toName, "UOM", "audit.merge_uom", mergeUOMNames);
}

export async function mergeTagAction(instanceId: string, fromNames: string[], toName: string): Promise<AuditActionResult<ApplyFixesResult>> {
  return mergeAction(instanceId, fromNames, toName, "tag", "audit.merge_tag", mergeTagNames);
}

export async function applyAttributeTemplateAction(
  instanceId: string,
  templateProductId: string,
  targetProductIds: string[]
): Promise<AuditActionResult<ApplyFixesResult>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  if (!templateProductId) return { ok: false, error: "Choose a product to copy attribute values from." };
  if (!targetProductIds.length) return { ok: false, error: "Nothing to apply." };
  try {
    const { orgId, userId, email } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);
    const result = await applyAttributeTemplate(creds, templateProductId, targetProductIds);

    await logActivity(db, {
      orgId,
      instanceId,
      actor: { userId, email },
      action: "audit.apply_attribute_template",
      summary: `Copied attribute values from one product to ${resultSuffix(result)}`,
      detail: { templateProductId, targetProductIds, failed: result.failed },
    });

    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Pulls every customer or supplier live from the chosen instance and runs the consistency/accuracy checks — read-only, nothing is written. */
export async function runPartyAuditAction(instanceId: string, kind: PartyKind): Promise<AuditActionResult<PartyAuditResult>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);
    const parties = kind === "customer" ? await fetchAllCustomers(creds) : await fetchAllSuppliers(creds);
    return { ok: true, data: runPartyAudit(parties, kind) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function applyPartyFixesAction(
  instanceId: string,
  kind: PartyKind,
  fixes: PartyFix[]
): Promise<AuditActionResult<ApplyPartyFixesResult>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  if (!fixes.length) return { ok: false, error: "Nothing to apply." };
  try {
    const { orgId, userId, email } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);
    const result = await applyPartyFixes(creds, kind, fixes);

    const fieldNames = [...new Set(fixes.flatMap((f) => Object.keys(f.fields)))];
    await logActivity(db, {
      orgId,
      instanceId,
      actor: { userId, email },
      action: `audit.apply_${kind}_fixes`,
      summary: `Set ${fieldNames.join(", ")} on ${resultSuffix(result)} ${kind}${result.succeeded === 1 ? "" : "s"}`,
      detail: { fields: fieldNames, partyIds: fixes.map((f) => f.partyId), failed: result.failed },
    });

    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
