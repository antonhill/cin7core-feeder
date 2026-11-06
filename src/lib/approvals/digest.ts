// The content digest of a submission: a SHA-256 over exactly the commercial values a manager is shown and approves. If any of them changes after
// submission the digest changes, and the decision is refused as stale (the preparer must resubmit). Pure.
import { hashOf } from "@/newquip/quote/baseline";

export const quoteDigest = (q: { quoteRef: string; revision: number; draftHash: string; confirmedCents: number }): string => hashOf({ t: "QUOTE", ...q });
export const claimDigest = (c: { claimId: string; claimNumber: string; snapshotHash: string; baselineHash: string; subtotalCents: number; taxCents: number }): string => hashOf({ t: "CLAIM", ...c });
export const variationDigest = (v: { variationId: string; code: string; title: string; description: string | null; amountCents: number; estimatedCostCents: number | null; stages: Array<{ name: string; bps: number }> }): string =>
  hashOf({ t: "VARIATION", ...v });
