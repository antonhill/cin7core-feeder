import "server-only";
// Loads the INTERNAL snapshot a Budget Quotation was sent from (private, service-role-only storage, hash-verified) and compares it with the quotation as it stands now. Cost-bearing: the caller (the route)
// must already have established that the viewer may see cost. Read-only: nothing is written anywhere.
import { createHash } from "node:crypto";
import type { createServiceRoleClient } from "@/supabase/server";
import type { QuoteDraft } from "@/newquip/grower/draft";
import { attributeVariance, type VarianceReport } from "@/newquip/pricing/budget-variance";
import { loadQuote } from "./quote-store";
import { evaluationContext } from "./context";
import { BUDGET_SEND_ACTION } from "./budget-quotation";
import type { DocumentStorage } from "./document-store";

type Db = ReturnType<typeof createServiceRoleClient>;
export interface BudgetSnapshotFile { schema: 1; quoteId: string; quoteRef: string; draftHash: string; savedAt: string; draft: QuoteDraft; lines: unknown[]; subtotalExTax: number | null; provisional: Array<{ itemKey: string; qualifies: string; composition: Array<{ sku: string; qtyPerUnit: number }>; openQuestions: string[] }> }
export interface BudgetVarianceResult { quoteRef: string; quoteState: string; sentAt: string; sentTo: string; draftRef: string; finalIsApproved: boolean; provisional: BudgetSnapshotFile["provisional"]; report: VarianceReport }

export async function loadBudgetVariance(db: Db, orgId: string, quoteId: string, storage: Pick<DocumentStorage, "download">): Promise<BudgetVarianceResult> {
  const sent = await db.from("activity_log").select("detail, created_at").eq("org_id", orgId).eq("action", BUDGET_SEND_ACTION).filter("detail->>quoteId", "eq", quoteId).filter("detail->>status", "eq", "ACCEPTED").order("created_at", { ascending: false }).limit(1);
  if (sent.error) throw new Error(sent.error.message);
  const row = (sent.data ?? [])[0] as { detail: Record<string, unknown>; created_at: string } | undefined;
  const ref = row?.detail?.internalSnapshot as { path?: string; sha256?: string } | undefined;
  if (!row || !ref?.path || !ref.sha256) throw new Error("No budget quotation was sent from this quotation, so there is nothing to compare.");
  const bytes = await storage.download(ref.path);
  if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256) throw new Error("The stored budget snapshot does not match its recorded hash; it was not used.");
  const snap = JSON.parse(new TextDecoder().decode(bytes)) as BudgetSnapshotFile;
  if (snap.quoteId !== quoteId) throw new Error("The stored budget snapshot belongs to a different quotation.");
  const q = await loadQuote(db, orgId, quoteId);
  if (!q) throw new Error("Quotation not found.");
  return { quoteRef: q.quote_ref, quoteState: q.state, sentAt: row.created_at, sentTo: String(row.detail.to ?? ""), draftRef: String(row.detail.draftRef ?? ""), finalIsApproved: q.state === "MANAGER_APPROVED_FINAL", provisional: snap.provisional, report: attributeVariance(snap.draft, q.draft, evaluationContext(false)) };
}
