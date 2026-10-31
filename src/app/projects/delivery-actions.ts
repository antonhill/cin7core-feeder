"use server";

// Projects - DELIVERY ALLOCATION and commercial milestone confirmation: Server Actions. NewQuip only. Every action re-establishes authorization
// itself (CCT-ADR-0010); changes are manager-only. These write ONLY local Toolbox tables: no Cin7 call is made, nothing is reserved or shipped.
// This file may export ONLY async functions and erased interfaces ("use server" rule in CLAUDE.md).

import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { logActivity } from "@/lib/activity-log";
import { createServiceRoleClient } from "@/supabase/server";
import { PROJECTS_MODULE } from "@/app/module-nav";
import { assertNewquipOrg } from "@/lib/projects/newquip-gate";
import { callerIsOrgAdmin, guardBillingScope } from "@/lib/projects/scope-access";
import {
  confirmMilestone, createDelivery, listMilestoneConfirmations, loadDeliveryRegister, setAllocation, setDeliveryStatus,
  type DeliveryRegister, type MilestoneConfirmation,
} from "@/lib/projects/delivery-allocation-store";

export interface DeliveryActionResult<T> { ok: boolean; error?: string; data?: T }
const message = (e: unknown) => (e instanceof Error ? e.message : "Unexpected error");

async function managerContext(projectId: string) {
  const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href, { projectData: true });
  assertNewquipOrg(orgId);
  const db = createServiceRoleClient();
  await guardBillingScope(db, orgId, projectId, await callerIsOrgAdmin());
  await requireOrgAdmin("manage delivery allocation"); // throws unless an owner/admin
  return { orgId, userId, email: email ?? "unknown", db };
}

export async function getDeliveryRegisterAction(projectId: string): Promise<DeliveryActionResult<{ register: DeliveryRegister; confirmations: MilestoneConfirmation[] }>> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href, { projectData: true });
    assertNewquipOrg(orgId);
    const db = createServiceRoleClient();
    await guardBillingScope(db, orgId, projectId, await callerIsOrgAdmin());
    return { ok: true, data: { register: await loadDeliveryRegister(db, orgId, projectId), confirmations: await listMilestoneConfirmations(db, orgId, projectId) } };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

export async function createDeliveryAction(projectId: string, label: string, plannedDate?: string): Promise<DeliveryActionResult<{ id: string }>> {
  try {
    const { orgId, userId, email, db } = await managerContext(projectId);
    const d = await createDelivery(db, { orgId, projectId, actor: email, label, plannedDate });
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.delivery_created", summary: `Planned delivery "${d.label}"`, detail: { projectId, deliveryId: d.id } });
    return { ok: true, data: { id: d.id } };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

export async function setAllocationAction(projectId: string, deliveryId: string, sku: string, quantity: number, reason: string): Promise<DeliveryActionResult<null>> {
  try {
    const { orgId, userId, email, db } = await managerContext(projectId);
    await setAllocation(db, { orgId, projectId, actor: email, deliveryId, sku, quantity, reason });
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.delivery_allocation", summary: `Allocated ${quantity} x ${sku} to a delivery`, detail: { projectId, deliveryId, sku, quantity, reason } });
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

export async function setDeliveryStatusAction(projectId: string, deliveryId: string, status: "PLANNED" | "LOADING" | "DISPATCHED" | "CANCELLED", reason: string): Promise<DeliveryActionResult<null>> {
  try {
    const { orgId, userId, email, db } = await managerContext(projectId);
    await setDeliveryStatus(db, { orgId, projectId, actor: email, deliveryId, status, reason });
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.delivery_status", summary: `Delivery marked ${status}`, detail: { projectId, deliveryId, status, reason } });
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

export async function confirmMilestoneAction(projectId: string, stageId: string, note: string, evidenceRef?: string): Promise<DeliveryActionResult<null>> {
  try {
    const { orgId, userId, email, db } = await managerContext(projectId);
    await confirmMilestone(db, { orgId, projectId, stageId, actor: email, note, evidenceRef });
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.milestone_confirmed", summary: "Commercial milestone confirmed", detail: { projectId, stageId, evidenceRef: evidenceRef ?? null } });
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}
