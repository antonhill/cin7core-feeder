import { canPriceAnything, fxFresh, type CommercialSettings } from "./commercial-settings";

// WHETHER AUTOMATIC REP PRICING IS GENUINELY ACTIVE, derived on the server from the deployment's activation flags, the effective timestamp and the readiness of the Manager's commercial settings. Pure: the caller supplies the
// already-read facts, so nothing here touches the environment. Shown to a Manager only; it carries no variable names, values or secrets, and nothing about the Estimator's own "Price from Cin7" (which does not depend on it).
export type ActivationState = "enabled" | "disabled" | "incomplete";
export interface ActivationFx { currency: string; status: "current" | "expired"; ageDays: number }
export interface ActivationStatus {
  state: ActivationState;
  label: "Enabled" | "Disabled" | "Configuration incomplete";
  summary: string;
  /** What stops it, or what to know, in plain words. */
  issues: string[];
  /** ISO instant from which new Rep drafts are priced automatically; null unless the switch is on with a valid effective time. */
  effectiveFrom: string | null;
  /** TEST-ONLY = a freight or exchange-rate source is labelled TEST-ONLY. The application cannot tell whether other values are approved policy, and says so. */
  testOnly: boolean;
  policyNote: string;
  fx: ActivationFx[];
}
export interface ActivationFacts { flagOn: boolean; cutoffMs: number | null }

const DAY_MS = 86_400_000;
const isTestOnly = (t: string | null | undefined): boolean => !!t && /test-only/i.test(t);

export function activationStatus(f: ActivationFacts, settings: CommercialSettings | null, nowMs: number): ActivationStatus {
  const fx: ActivationFx[] = settings ? Object.entries(settings.fx).sort(([a], [b]) => a.localeCompare(b)).map(([currency, q]) => {
    const t = Date.parse(q.asOf);
    return { currency, status: fxFresh(q, settings.fxMaxAgeDays, nowMs) ? "current" as const : "expired" as const, ageDays: Number.isFinite(t) ? Math.max(0, Math.floor((nowMs - t) / DAY_MS)) : -1 };
  }) : [];
  const testOnly = !!settings && (isTestOnly(settings.freight?.source) || Object.values(settings.fx).some((q) => isTestOnly(q.source)));
  const policyNote = !settings ? "No commercial settings have been saved."
    : testOnly ? "TEST-ONLY settings: these values are labelled as test data and are not approved commercial policy."
    : "These values were entered by a Manager. The application does not record whether they are approved commercial policy.";

  const issues: string[] = [];
  if (!settings || !canPriceAnything(settings)) issues.push("The freight policy is not set, so nothing can be priced automatically.");
  if (settings && fx.length === 0) issues.push("No exchange rate is entered, so products costed in a foreign currency cannot be priced.");
  else if (fx.some((x) => x.status === "expired")) issues.push(`Expired exchange rate${fx.filter((x) => x.status === "expired").length === 1 ? "" : "s"}: ${fx.filter((x) => x.status === "expired").map((x) => x.currency).join(", ")}. Products costed in ${fx.filter((x) => x.status === "expired").length === 1 ? "that currency are" : "those currencies are"} not priced until a Manager refreshes ${fx.filter((x) => x.status === "expired").length === 1 ? "it" : "them"}.`);

  if (!f.flagOn) {
    return { state: "disabled", label: "Disabled", summary: "Automatic pricing of new Rep drafts is switched off in the deployment. Quotations are not priced automatically. The Estimator can still use Price from Cin7.", issues, effectiveFrom: null, testOnly, policyNote, fx };
  }
  if (f.cutoffMs === null) {
    return { state: "incomplete", label: "Configuration incomplete", summary: "Automatic pricing is switched on but has no valid effective time, so it is not running.", issues: ["The effective time is missing or not a valid timestamp with a time zone.", ...issues], effectiveFrom: null, testOnly, policyNote, fx };
  }
  const effectiveFrom = new Date(f.cutoffMs).toISOString();
  const blocking = !settings || !canPriceAnything(settings) || fx.length === 0;
  if (blocking) {
    return { state: "incomplete", label: "Configuration incomplete", summary: `Automatic pricing is switched on from ${effectiveFrom}, but the commercial settings are not ready, so it cannot price.`, issues, effectiveFrom, testOnly, policyNote, fx };
  }
  return { state: "enabled", label: "Enabled", summary: `Automatic pricing prices new Rep drafts created on or after ${effectiveFrom}. Older quotations are never repriced.`, issues, effectiveFrom, testOnly, policyNote, fx };
}
