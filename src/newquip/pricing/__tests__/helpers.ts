import { evaluateDraft, type QuoteEvaluation } from "../../grower/evaluate";
import { readyDraft } from "../../grower/__tests__/golden";
import { testPriceSource } from "../../grower/__tests__/test-snapshot";
import type { QuoteDraft } from "../../grower/draft";
import { buildIndicativeSnapshot } from "../indicative-snapshot";

export const evalOf = (draft: QuoteDraft, withholdCost: boolean): QuoteEvaluation => evaluateDraft(draft, { priceSource: testPriceSource(), withholdCost });
export const snapshotOf = (draft: QuoteDraft, revision = 1) =>
  buildIndicativeSnapshot({ quoteRef: "NQ-Q-0001", revision, draft, repEvaluation: evalOf(draft, true), internalEvaluation: evalOf(draft, false) });
export const cloneDraft = (over: (d: QuoteDraft) => void, base: QuoteDraft = readyDraft()): QuoteDraft => { const d = structuredClone(base); over(d); return d; };
