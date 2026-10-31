import type { createServiceRoleClient } from "@/supabase/server";
import type { QuoteRecord } from "@/lib/newquip-quotes/quote-store";
import { documentsAvailable, listDocuments } from "@/lib/newquip-quotes/document-store";
import { listSends } from "@/lib/newquip-quotes/send-store";
import { COMMERCIAL_STATUS_LABEL, commercialStatus, evidenceCounts, listResponses, listReviews, portalAvailable } from "@/lib/newquip-quotes/acceptance";

type Db = ReturnType<typeof createServiceRoleClient>;

/** Where a quotation stands with the customer, from the SAME derivation the Toolbox uses (no second status logic). Null before migration 0115. Carries no cost and no personal data. */
export async function repCommercialStatus(db: Db, orgId: string, q: QuoteRecord): Promise<{ status: string; statusLabel: string } | null> {
  if (!(await documentsAvailable(db))) return null;
  const [docs, sends, responses] = await Promise.all([listDocuments(db, orgId, q.id), listSends(db, orgId, q.id), listResponses(db, orgId, q.id)]);
  const portal = await portalAvailable(db);
  const [reviews, evidence] = portal ? await Promise.all([listReviews(db, orgId, q.id), evidenceCounts(db, orgId, q.id)]) : [[], new Map<string, number>()];
  const status = commercialStatus(q, docs[0] ?? null, sends, responses, reviews, evidence);
  return { status, statusLabel: COMMERCIAL_STATUS_LABEL[status] };
}
