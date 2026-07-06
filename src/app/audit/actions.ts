"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllProductsWithBom } from "@/cin7/products";
import { runProductAudit, type ProductAuditResult } from "@/audit/product-audit";
import {
  applyProductFixes,
  mergeCategoryNames,
  mergeUOMNames,
  mergeTagNames,
  type ApplyFixesResult,
  type ProductFix,
} from "@/audit/apply-fixes";

export interface AuditActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
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
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);
    return { ok: true, data: await applyProductFixes(creds, fixes) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function mergeCategoryAction(
  instanceId: string,
  fromNames: string[],
  toName: string
): Promise<AuditActionResult<ApplyFixesResult>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  if (!toName.trim()) return { ok: false, error: "Choose which category name to keep." };
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);
    return { ok: true, data: await mergeCategoryNames(creds, fromNames, toName) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function mergeUOMAction(
  instanceId: string,
  fromNames: string[],
  toName: string
): Promise<AuditActionResult<ApplyFixesResult>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  if (!toName.trim()) return { ok: false, error: "Choose which UOM to keep." };
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);
    return { ok: true, data: await mergeUOMNames(creds, fromNames, toName) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function mergeTagAction(
  instanceId: string,
  fromNames: string[],
  toName: string
): Promise<AuditActionResult<ApplyFixesResult>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  if (!toName.trim()) return { ok: false, error: "Choose which tag to keep." };
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);
    return { ok: true, data: await mergeTagNames(creds, fromNames, toName) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
