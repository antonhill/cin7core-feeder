"use server";

// NewQuip: automatic initial pricing of a Rep draft, and the Manager's commercial settings. LOCAL ONLY: Cin7 is read with GET only; nothing here writes to Cin7 or Xero, and nothing is approved.
// Every action re-establishes the same authority as the rest of the module (NewQuip organisation, module access) and then the role it needs:
//   - settings can be CHANGED by a Manager only (the same gate as company details); an Estimator may read only the list of unresolved items; a Rep gets nothing;
//   - the automatic pricing may be asked for by a Rep, Estimator or Manager for a Rep draft, and a Rep is only ever told neutral wording (never a cost, rate, freight or margin).
// Only async functions and erased types are exported.
import { createServiceRoleClient } from "@/supabase/server";
import { documentsAvailable, latestCommercialSettings, saveCommercialSettings } from "@/lib/newquip-quotes/document-store";
import { runAutoPricing, type AutoPricingOutcome } from "@/lib/newquip-quotes/auto-pricing-service";
import { emptyCommercialSettings, parseCommercialSettings, unresolvedItems, type CommercialSettings, type UnresolvedItem } from "@/newquip/pricing/commercial-settings";
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
    return { ok: true, data: { available: true, settings: manager ? (v?.settings ?? emptyCommercialSettings()) : null, revision: v?.revision ?? null, enteredBy: manager ? (v?.enteredBy ?? null) : null, enteredAt: manager ? (v?.enteredAt ?? null) : null, unresolved: unresolvedItems(v?.settings ?? null, now), canEdit: manager } };
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
    return { ok: true, data: { available: true, settings: saved.settings, revision: saved.revision, enteredBy: saved.enteredBy, enteredAt: saved.enteredAt, unresolved: unresolvedItems(saved.settings, now), canEdit: true } };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

/** What a viewer may be told: a Rep gets neutral wording only; the per-product internal detail goes to a cost-entitled viewer. */
const viewOfOutcome = (o: AutoPricingOutcome, canSeeCost: boolean): AutoPricingOutcome => (canSeeCost ? o : { ...o, internal: [] });

/** Prices the quotation's products from Cin7 and the commercial settings, if it is a Rep draft whose pricing is absent or still entirely automatic. Idempotent; never overwrites an Estimator's cost. */
export async function ensureAutoPricingAction(quoteId: string): Promise<AutoActionResult<AutoPricingOutcome>> {
  try {
    if (typeof quoteId !== "string" || quoteId.length === 0 || quoteId.length > 64) throw new TypeError("bad request");
    const a = await authoriseActor();
    if (!a.roles.has("rep") && !a.roles.has("estimator") && !a.roles.has("manager")) throw new Error("not allowed");
    const db = createServiceRoleClient();
    const o = await runAutoPricing(db, { orgId: a.orgId, userId: a.userId }, quoteId);
    if (o.status === "applied") await auditActor(db, a, { action: "newquip.auto_pricing", summary: "Priced a Rep draft automatically from Cin7 supplier costs (local only; Cin7 read only)", detail: { quoteId, added: o.added, stillPending: o.pendingCount } });
    return { ok: true, data: viewOfOutcome(o, a.canSeeCost) };
  } catch (e) { return { ok: false, error: errText(e) }; }
}
