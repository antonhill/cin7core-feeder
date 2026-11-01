// What a Rep may receive about a quotation. ALLOWLIST-BASED: the response is BUILT from named fields, so a column added to the quotation tomorrow is not exposed by accident.
// It never carries the estimator state (cost overrides, captured physical costs, cost basis), the frozen margin sheet or baseline, or any estimated cost / gross profit / margin,
// and this holds whoever the Rep also is: an administrator using the Rep boundary gets the same cost-free response. The evaluation inside it is produced with cost withheld, and
// a final recursive pass drops - and then asserts the absence of - every cost-bearing key, so even a future field cannot leak through this boundary unnoticed.
import type { QuoteRecord } from "@/lib/newquip-quotes/quote-store";
import type { QuoteEvaluation } from "@/newquip/grower/evaluate";
import type { GrowerConfigurationInput } from "@/newquip/grower/types";
import type { QuoteType } from "@/newquip/grower/pricing-source";

export interface RepQuoteListItem {
  id: string; quoteRef: string; revision: number; state: QuoteRecord["state"]; customerName: string; siteName: string; quoteType: QuoteType;
  /** The ex-VAT contract total the customer is quoted (a selling price, not a cost). Null until approved. */
  contractCents: number | null; projectId: string | null; createdAt: string; updatedAt: string;
}
export interface RepQuoteView {
  quote: RepQuoteListItem;
  draft: { customerName: string; siteName: string; quoteType: QuoteType; config: GrowerConfigurationInput };
  evaluation: QuoteEvaluation;
  /** Where the quotation stands with the customer (issued / sent / responded / verified), as the existing commercial-status derivation reports it. */
  commercial: { status: string; statusLabel: string } | null;
}

export const toRepListItem = (q: QuoteRecord): RepQuoteListItem => ({
  id: q.id, quoteRef: q.quote_ref, revision: q.revision, state: q.state, customerName: q.customer_name, siteName: q.site_name, quoteType: q.quote_type,
  contractCents: q.contract_cents, projectId: q.project_id, createdAt: q.created_at, updatedAt: q.updated_at,
});

/** Keys that carry cost, margin or supplier information anywhere in a response. Matched on the lower-cased key. */
const COST_KEY = /cost|margin|landed|markup|supplier|freight|gp$|^roe$/;
export const isCostKey = (k: string): boolean => COST_KEY.test(k.toLowerCase());

/** Returns a copy with every cost-bearing key removed, at any depth. */
export function stripCostKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripCostKeys) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (!isCostKey(k)) out[k] = stripCostKeys(v);
    return out as T;
  }
  return value;
}

/** The first cost-bearing key path found, or null. Used as a fail-closed assertion on the finished response. */
export function findCostKey(value: unknown, path = "$"): string | null {
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) { const f = findCostKey(value[i], `${path}[${i}]`); if (f) return f; } return null; }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) { if (isCostKey(k)) return `${path}.${k}`; const f = findCostKey(v, `${path}.${k}`); if (f) return f; }
  }
  return null;
}

export function toRepQuoteView(q: QuoteRecord, evaluation: QuoteEvaluation, commercial: RepQuoteView["commercial"]): RepQuoteView {
  const view: RepQuoteView = {
    quote: toRepListItem(q),
    draft: { customerName: q.draft.customerName, siteName: q.draft.siteName, quoteType: q.draft.quoteType, config: q.draft.config },
    evaluation: stripCostKeys(evaluation),
    commercial,
  };
  const leak = findCostKey(view);
  if (leak) throw new Error(`Refusing to return a Rep response containing ${leak}.`); // unreachable after stripping; guards future edits
  return view;
}
