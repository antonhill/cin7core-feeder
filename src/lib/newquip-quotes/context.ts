import "server-only";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";
import type { EvaluationContext } from "@/newquip/grower/evaluate";

/**
 * The evaluation context the server uses. The POC price source is the NewQuip Master workbook snapshot, loaded here and only
 * here (server side): cost, ROE and freight never reach a browser, and swapping the source is a change to this one function.
 */
export function evaluationContext(withholdCost: boolean): EvaluationContext {
  return { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost };
}
