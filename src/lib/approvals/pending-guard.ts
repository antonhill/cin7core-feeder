import "server-only";
// A submitted item must not be silently modified while a manager is reviewing it. This tiny module has no dependency on the document stores, so
// they can import it without a cycle. Safe before migration 0110 exists (no table = nothing is pending).
import type { createServiceRoleClient } from "@/supabase/server";
import type { ApprovalDocType } from "./types";

type Db = ReturnType<typeof createServiceRoleClient>;

export async function hasPendingApproval(db: Db, orgId: string, docType: ApprovalDocType, docId: string): Promise<boolean> {
  const r = await db.from("approval_requests").select("id").eq("org_id", orgId).eq("doc_type", docType).eq("doc_id", docId).eq("status", "PENDING").limit(1);
  if (r.error) return false; // table not there yet
  return (r.data ?? []).length > 0;
}

export async function assertNotPendingApproval(db: Db, orgId: string, docType: ApprovalDocType, docId: string): Promise<void> {
  if (await hasPendingApproval(db, orgId, docType, docId)) throw new Error("This item is pending approval, so it cannot be edited. Withdraw the submission (or ask the manager to return it), then edit and resubmit.");
}
