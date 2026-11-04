import { isNewquipPocOrg } from "@/newquip/access";
import { supabaseWiring } from "@/lib/projects/write-flag";
import type { QuoteDraft } from "@/newquip/grower/draft";
import type { ScopeItem } from "@/lib/projects/product-scope";

// NEWQUIP POC PRESENTATION MODE (pure). For the designated demonstration only: a quotation CREATED while the mode is on carries a POC marker and is seeded with the Estimator inputs the
// workbook cannot supply, so the presenter never types prices or mappings live. At sign-off / approval the SAME audited mechanisms the business already uses (the Estimator's incomplete-cost
// exception, the Manager's recorded baseline exception) are recorded automatically with a reason that says "POC PRESENTATION". No gate is removed, no normal quotation is touched, and nothing here
// marks a price or cost as commercially validated: the marker is carried into the audit trail and the frozen baseline.

export const POC_MARKER = "POC PRESENTATION";
export const POC_COST_REASON = "POC PRESENTATION: supplier costs are not captured for this demonstration; the margin is indicative only and is not commercially validated.";
export const POC_BASELINE_REASON = "POC PRESENTATION: M75 and penning are Estimator-priced by design and have no Cin7 SKU; accepted for the demonstration only, not commercially validated.";

export interface PocEnv { VERCEL_ENV?: string; NEWQUIP_POC_PRESENTATION?: string; SUPABASE_URL?: string; NEXT_PUBLIC_SUPABASE_URL?: string }

/** ALL of: a Vercel Preview, the explicit switch, the NewQuip Supabase project wiring, and the NewQuip POC organisation. Everything else is off. */
export function pocPresentationEnabled(env: Record<string, string | undefined>, orgId: string): boolean {
  if (env.VERCEL_ENV !== "preview" || env.NEWQUIP_POC_PRESENTATION !== "true") return false;
  if (!supabaseWiring(env).ok) return false;
  return isNewquipPocOrg(orgId);
}

/** A quotation created in POC Presentation Mode (and only such a quotation) is marked in its assumptions. */
export const isPocQuote = (draft: Pick<QuoteDraft, "estimator">): boolean => (draft.estimator.assumptions ?? "").startsWith(POC_MARKER);

const RES = (unitPriceExVat: number, at: string) => ({ at, by: "poc-presentation-seed", reason: "POC PRESENTATION: illustrative demonstration price, not a validated commercial price.", unitPriceExVat });

/** Estimator inputs for the full Grower House configuration that the Master workbook cannot price or map (same verified SKUs the approved quotations used). Never touches the shared catalogue or library. */
export function seedPocEstimator(draft: QuoteDraft, nowIso: string): QuoteDraft {
  return {
    ...draft,
    quoteType: "project",
    estimator: {
      ...draft.estimator,
      confirmedMappings: { feeder: "PNQ082", pvc_door: "NQ2114", bulk_tank: "SYSH-2750-3", concrete_slat: "NQ1161", feed_saver_mat: "ERT053" },
      confirmedPackages: ["cup_drinker", "led_light"],
      charges: { delivery: 979992, installation: 1200000, concrete_slat_delivery: 250000 },
      unitPrices: { flex_auger: 45000 },
      priceResolutions: { pvc_door: RES(3000, nowIso), led_light: RES(881, nowIso), cup_drinker: RES(548, nowIso), concrete_slat: RES(203, nowIso), feed_saver_mat: RES(919, nowIso) },
      assumptions: `${POC_MARKER}: demonstration quotation. Estimator inputs are illustrative and not commercially validated.`,
    },
  };
}

export const POC_SCOPE_REASON = "POC PRESENTATION: product mapping not verified for this demonstration, so no Cin7 product line is sent; the value is carried by the contract charges. Not fulfilled stock.";

/**
 * Project creation from a POC-approved quotation: every scope item that is still UNMAPPED is recorded as EXCLUDED from the Cin7 Sales Order's physical lines (the project's existing,
 * audited EXCLUDE resolution), so no invalid product ID is ever sent. The item stays in the register with its reason; nothing is represented as mapped, shipped or fulfilled.
 */
export function excludeUnverifiedScope(items: readonly ScopeItem[], nowIso: string): ScopeItem[] {
  return items.map((it) => (!it.resolution && it.mapping.status === "UNMAPPED" ? { ...it, resolution: { kind: "EXCLUDE" as const, reason: POC_SCOPE_REASON, by: "POC PRESENTATION", at: nowIso } } : it));
}

/** The sealed baseline's own record that this quotation was approved in POC Presentation Mode. */
export const approvedInPocMode = (baseline: { exceptions?: Array<{ reason?: string }> } | null | undefined): boolean => !!baseline?.exceptions?.some((e) => (e.reason ?? "").startsWith(POC_MARKER));
