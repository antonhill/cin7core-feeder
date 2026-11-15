import { isNewquipPocOrg } from "@/newquip/access";
import { supabaseWiring } from "@/lib/projects/write-flag";
import type { QuoteDraft } from "@/newquip/grower/draft";
import type { ScopeItem } from "@/lib/projects/product-scope";

// NEWQUIP POC PRESENTATION MODE (pure). For the designated demonstration only: a quotation CREATED while the mode is on carries a POC marker and is seeded with the Estimator inputs the
// workbook cannot supply, so the presenter never types prices or mappings live. At approval the Manager's recorded baseline exception (M75 / penning, Estimator-priced by design) is recorded automatically with a reason that says
// "POC PRESENTATION" and the sealed baseline records pocPresentation. The mode is keyed on a SERVER-OWNED flag, never on assumptions text. There is NO automatic incomplete-COSTING waiver: that always needs an authorised person's recorded decision. No gate is removed, no normal quotation is touched, and nothing here
// marks a price or cost as commercially validated: the marker is carried into the audit trail and the frozen baseline.

export const POC_MARKER = "POC PRESENTATION";
/** LEGACY: the reason text of costing waivers recorded by an earlier POC build. Nothing writes it any more; stored waivers carrying it are honoured unchanged. */
export const POC_COST_REASON = "POC PRESENTATION: supplier costs are not captured for this demonstration; the margin is indicative only and is not commercially validated.";
export const POC_BASELINE_REASON = "POC PRESENTATION: M75 and penning are Estimator-priced by design and have no Cin7 SKU; accepted for the demonstration only, not commercially validated.";

export interface PocEnv { VERCEL_ENV?: string; NEWQUIP_POC_PRESENTATION?: string; SUPABASE_URL?: string; NEXT_PUBLIC_SUPABASE_URL?: string }

/** ALL of: a Vercel Preview, the explicit switch, the NewQuip Supabase project wiring, and the NewQuip POC organisation. Everything else is off. */
export function pocPresentationEnabled(env: Record<string, string | undefined>, orgId: string): boolean {
  if (env.VERCEL_ENV !== "preview" || env.NEWQUIP_POC_PRESENTATION !== "true") return false;
  if (!supabaseWiring(env).ok) return false;
  return isNewquipPocOrg(orgId);
}

/**
 * The SERVER-OWNED flag on a stored draft: set ONLY by createGrowerQuoteAction while pocPresentationEnabled(...) holds. It is NOT the assumptions text (Rep-owned free text, which now has NO effect).
 * Whatever a client sends for it is discarded on every path (createQuote / saveDraft / sanitiseSubmittedDraft); it is carried from the stored draft only.
 */
export const hasPocFlag = (draft: Pick<QuoteDraft, "estimator"> | null | undefined): boolean => draft?.estimator?.pocPresentation === true;

/**
 * Is POC Presentation Mode IN FORCE for this quotation right now? The stored server flag AND the environment/organisation gate, re-checked at every use, so the flag is inert in
 * Production, when the switch is off, and outside the NewQuip POC organisation.
 */
export const isPocQuote = (draft: Pick<QuoteDraft, "estimator"> | null | undefined, orgId: string, env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): boolean =>
  hasPocFlag(draft) && pocPresentationEnabled(env, orgId);

/** A client-supplied draft never decides the flag: the STORED value (if any) is carried over, otherwise it is removed. */
export function keepServerOwnedPocFlag<D extends QuoteDraft>(draft: D, prior: Pick<QuoteDraft, "estimator"> | null | undefined): D {
  const next = structuredClone(draft);
  if (hasPocFlag(prior)) next.estimator.pocPresentation = true; else delete next.estimator.pocPresentation;
  return next;
}

const RES = (unitPriceExVat: number, at: string) => ({ at, by: "poc-presentation-seed", reason: "POC PRESENTATION: illustrative demonstration price, not a validated commercial price.", unitPriceExVat });

/** Estimator inputs for the full Grower House configuration that the Master workbook cannot price or map (same verified SKUs the approved quotations used). Never touches the shared catalogue or library. */
export function seedPocEstimator(draft: QuoteDraft, nowIso: string): QuoteDraft {
  return {
    ...draft,
    quoteType: "project",
    estimator: {
      ...draft.estimator,
      pocPresentation: true,
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

/**
 * The sealed baseline's own record that this quotation was approved in POC Presentation Mode: `pocPresentation`, set by the server at approval from the server flag (never from a typed reason).
 *
 * READ-COMPAT, sealed baselines ONLY: a baseline sealed BEFORE this field existed (no boolean `pocPresentation` at all) is still recognised by the old exception-reason prefix, so quotations
 * already approved in POC mode keep their scope exclusion at project creation. Every baseline sealed from now on carries an explicit boolean (see buildAcceptedBaseline), so this path can
 * never apply to a new approval and a Manager-typed reason can never trigger it. It reads stored data only; nothing is rewritten.
 */
export const approvedInPocMode = (baseline: { pocPresentation?: boolean; exceptions?: Array<{ reason?: string }> } | null | undefined): boolean => {
  if (!baseline) return false;
  if (typeof baseline.pocPresentation === "boolean") return baseline.pocPresentation;
  return !!baseline.exceptions?.some((e) => (e.reason ?? "").startsWith(POC_MARKER));
};
