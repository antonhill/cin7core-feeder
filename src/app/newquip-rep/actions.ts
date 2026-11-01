"use server";

// The Rep-facing READ boundary (Slice 1A). Every action re-authorises, then scopes by the Rep's ACTIVE customer assignments before any quotation data is loaded: an unassigned,
// revoked, cross-organisation or non-existent quotation all give the same generic "not found". Responses are allowlist-built and cost-free. Nothing here writes, sends, approves or
// reaches Cin7, and it does not change the existing org-wide screens. Only async functions and erased types are exported.
import { authoriseRep, errText, type RepResult } from "./rep-actor";
import { loadQuote, type QuoteRecord } from "@/lib/newquip-quotes/quote-store";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { evaluationContext } from "@/lib/newquip-quotes/context";
import { assertRepAssignedToCustomer, assertRepCanSeeQuote, assignedCustomers, quoteIdsForCustomers, visibleQuoteIdsForRep, NotVisibleError } from "@/lib/newquip-assignments/visibility";
import { repCommercialStatus } from "@/lib/newquip-assignments/rep-commercial";
import { toRepListItem, toRepQuoteView, type RepQuoteListItem, type RepQuoteView } from "@/lib/newquip-assignments/rep-view";

export interface MyCustomer { cin7CustomerId: string; customerName: string; assignedAt: string }

const LIST_COLUMNS = "id, quote_ref, revision, customer_name, site_name, quote_type, state, contract_cents, project_id, created_at, updated_at";
const denial = (e: unknown): string => (e instanceof NotVisibleError ? e.message : errText(e));

async function listItems(db: Awaited<ReturnType<typeof authoriseRep>>["db"], orgId: string, ids: string[]): Promise<RepQuoteListItem[]> {
  const out: RepQuoteListItem[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const r = await db.from("newquip_quotes").select(LIST_COLUMNS).eq("org_id", orgId).in("id", ids.slice(i, i + 100));
    if (r.error) throw new Error(r.error.message);
    out.push(...((r.data ?? []) as unknown as QuoteRecord[]).map(toRepListItem));
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** The customers actively assigned to the signed-in Rep. */
export async function listMyCustomersAction(): Promise<RepResult<MyCustomer[]>> {
  try {
    const { actor, db } = await authoriseRep();
    const rows = await assignedCustomers(db, actor.orgId, actor.userId);
    return { ok: true, data: rows.map((a) => ({ cin7CustomerId: a.cin7_customer_id, customerName: a.customer_name, assignedAt: a.assigned_at })) };
  } catch (e) { return { ok: false, error: denial(e) }; }
}

/** Every quotation (any revision or state) of the Rep's assigned customers, whoever created it. */
export async function listMyQuotesAction(): Promise<RepResult<RepQuoteListItem[]>> {
  try {
    const { actor, db } = await authoriseRep();
    return { ok: true, data: await listItems(db, actor.orgId, await visibleQuoteIdsForRep(db, actor.orgId, actor.userId)) };
  } catch (e) { return { ok: false, error: denial(e) }; }
}

/** The quotation history of ONE assigned customer (previous revisions and issued quotations included). */
export async function getMyCustomerHistoryAction(cin7CustomerId: string): Promise<RepResult<RepQuoteListItem[]>> {
  try {
    const { actor, db } = await authoriseRep();
    const customer = String(cin7CustomerId ?? "");
    await assertRepAssignedToCustomer(db, actor.orgId, actor.userId, customer);
    return { ok: true, data: await listItems(db, actor.orgId, await quoteIdsForCustomers(db, actor.orgId, new Set([customer]))) };
  } catch (e) { return { ok: false, error: denial(e) }; }
}

/** One quotation of an assigned customer: inputs, priced result WITHOUT cost, and customer-response status. */
export async function getMyQuoteAction(quoteId: string): Promise<RepResult<RepQuoteView>> {
  try {
    const { actor, db } = await authoriseRep();
    const id = String(quoteId ?? "");
    await assertRepCanSeeQuote(db, actor.orgId, actor.userId, id); // BEFORE any quotation data is loaded
    const q = await loadQuote(db, actor.orgId, id);
    if (!q) throw new NotVisibleError();
    const evaluation = evaluateDraft(q.draft, evaluationContext(true)); // cost withheld whatever else this person is
    return { ok: true, data: toRepQuoteView(q, evaluation, await repCommercialStatus(db, actor.orgId, q)) };
  } catch (e) { return { ok: false, error: denial(e) }; }
}
