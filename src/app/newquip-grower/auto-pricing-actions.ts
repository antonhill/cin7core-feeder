"use server";

// NewQuip: automatic initial pricing of a Rep draft, and the Manager's commercial settings. LOCAL ONLY: Cin7 is read with GET only; nothing here writes to Cin7 or Xero, and nothing is approved.
// Every action re-establishes the same authority as the rest of the module (NewQuip organisation, module access) and then the role it needs:
//   - settings can be CHANGED by a Manager only (the same gate as company details); an Estimator may read only the list of unresolved items; a Rep gets nothing;
// The automatic pricing itself has NO action: its only entry is runAutoPricing (gated by flag, cutoff, non-demo and Rep role), called from the Rep draft save.
// Only async functions and erased types are exported.
import { createServiceRoleClient } from "@/supabase/server";
import { documentsAvailable, latestCommercialSettings, saveCommercialSettings } from "@/lib/newquip-quotes/document-store";
import { emptyCommercialSettings, parseCommercialSettings, unresolvedItems, type CommercialSettings, type UnresolvedItem } from "@/newquip/pricing/commercial-settings";
import { feedConfigured, refreshFxFromFeed, FEED_ACTOR, type FeedOutcome } from "@/lib/newquip-quotes/fx-feed";
import { activationFacts } from "@/lib/newquip-quotes/auto-pricing-service";
import { activationStatus, type ActivationStatus } from "@/newquip/pricing/activation-status";
import { auditActor, authoriseActor, errText as rawErrText, ownerEmailOf, type Actor } from "./actor";

const errText = (e: unknown): string => (e instanceof TypeError || e instanceof RangeError || e instanceof SyntaxError ? "The request was not valid." : rawErrText(e));
export interface AutoActionResult<T> { ok: boolean; error?: string; errors?: string[]; data?: T }

export interface CommercialSettingsView {
  available: boolean;
  /** Only a Manager receives the values; an Estimator receives the unresolved list alone. */
  settings: CommercialSettings | null;
  revision: number | null;
  enteredBy: string | null;
  enteredAt: string | null;
  unresolved: UnresolvedItem[];
  canEdit: boolean;
  /** Server-derived activation state of automatic Rep pricing: a Manager only (null for everyone else). */
  activation?: ActivationStatus | null;
  /** The deployment can reach the Open Exchange Rates feed (a yes/no only; never the credential). Manager only. */
  feedConfigured?: boolean;
}

const needManager = (a: Actor) => { if (!a.roles.has("manager")) throw new Error("Only a Manager can change the commercial settings."); };
const canView = (a: Actor) => a.roles.has("manager") || (a.roles.has("estimator") && a.canSeeCost);

export async function getCommercialSettingsAction(): Promise<AutoActionResult<CommercialSettingsView>> {
  try {
    const a = await authoriseActor();
    if (!canView(a)) throw new Error("Commercial settings are internal.");
    const db = createServiceRoleClient();
    if (!(await documentsAvailable(db))) return { ok: true, data: { available: false, settings: null, revision: null, enteredBy: null, enteredAt: null, unresolved: [], canEdit: false } };
    const now = new Date().toISOString();
    const v = await latestCommercialSettings(db, a.orgId, now);
    const manager = a.roles.has("manager");
    return { ok: true, data: { available: true, settings: manager ? (v?.settings ?? emptyCommercialSettings()) : null, revision: v?.revision ?? null, enteredBy: manager ? (v?.enteredBy ?? null) : null, enteredAt: manager ? (v?.enteredAt ?? null) : null, unresolved: unresolvedItems(v?.settings ?? null, now), canEdit: manager, activation: manager ? activationStatus(activationFacts(process.env), v?.settings ?? null, Date.parse(now)) : null, feedConfigured: manager ? feedConfigured() : false } };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

/** Saves the submitted settings as a NEW version (append-only). `expectedRevision` is the revision the form was loaded from (null = none): a stale form is refused, never last-write-wins. */
export async function saveCommercialSettingsAction(input: unknown, expectedRevision: number | null): Promise<AutoActionResult<CommercialSettingsView>> {
  try {
    const a = await authoriseActor(); needManager(a);
    if (expectedRevision !== null && !Number.isSafeInteger(expectedRevision)) throw new TypeError("bad request");
    const now = new Date().toISOString();
    const parsed = parseCommercialSettings(input, now);
    if (!parsed.ok) return { ok: false, error: parsed.errors[0], errors: parsed.errors };
    const db = createServiceRoleClient();
    if (!(await documentsAvailable(db))) throw new Error("Commercial settings are not available until the database update (migration 0115) is applied.");
    const current = await latestCommercialSettings(db, a.orgId, now);
    if ((current?.revision ?? null) !== expectedRevision) return { ok: false, error: "The commercial settings were changed by someone else since you loaded them. Reload to review. Nothing was saved." };
    const saved = await saveCommercialSettings(db, a.orgId, parsed.value, a.email, now);
    // The audit detail names what changed by field, never the figures themselves.
    await auditActor(db, a, { action: "newquip.commercial_settings_saved", summary: "Saved NewQuip commercial settings (new version; earlier versions kept)", detail: { revision: saved.revision, byOwner: ownerEmailOf(a), freightSet: saved.settings.freight !== null, currencies: Object.keys(saved.settings.fx).sort(), markupSet: saved.settings.markupBps !== null } });
    return { ok: true, data: { available: true, settings: saved.settings, revision: saved.revision, enteredBy: saved.enteredBy, enteredAt: saved.enteredAt, unresolved: unresolvedItems(saved.settings, now), canEdit: true, activation: activationStatus(activationFacts(process.env), saved.settings, Date.parse(now)), feedConfigured: feedConfigured() } };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

/**
 * The Manager's "Refresh from Open Exchange Rates": fetches fresh USD/ZAR and EUR/ZAR and saves them as a NEW settings version (exchange rates only). A rate the Manager entered by hand is an override and is KEPT unless `replaceManual`.
 * A provider problem is returned as the reason and nothing is saved: there is no fallback and an expired rate is never quietly used. Cin7 is not touched.
 */
export async function refreshFxFromFeedAction(replaceManual: boolean): Promise<AutoActionResult<FeedOutcome & { view: CommercialSettingsView }>> {
  try {
    const a = await authoriseActor(); needManager(a);
    if (typeof replaceManual !== "boolean") throw new TypeError("bad request");
    const db = createServiceRoleClient();
    if (!(await documentsAvailable(db))) throw new Error("Commercial settings are not available until the database update (migration 0115) is applied.");
    const out = await refreshFxFromFeed(db, a.orgId, `${FEED_ACTOR} (requested by ${a.email})`, { replaceManual });
    await auditActor(db, a, { action: "newquip.fx_feed_refresh", summary: out.ok ? "Refreshed exchange rates from Open Exchange Rates (new settings version; local only)" : "Exchange-rate refresh failed (nothing saved)", detail: { ok: out.ok, updated: out.updated, keptManual: out.keptManual, revision: out.revision ?? null, providerTimestamp: out.providerTimestamp ?? null } });
    const now = new Date().toISOString();
    const v = await latestCommercialSettings(db, a.orgId, now);
    const view: CommercialSettingsView = { available: true, settings: v?.settings ?? emptyCommercialSettings(), revision: v?.revision ?? null, enteredBy: v?.enteredBy ?? null, enteredAt: v?.enteredAt ?? null, unresolved: unresolvedItems(v?.settings ?? null, now), canEdit: true, activation: activationStatus(activationFacts(process.env), v?.settings ?? null, Date.parse(now)), feedConfigured: feedConfigured() };
    return out.ok ? { ok: true, data: { ...out, view } } : { ok: false, error: out.error, data: { ...out, view } };
  } catch (e) { return { ok: false, error: errText(e) }; }
}
