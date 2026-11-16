import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { emptyCommercialSettings, type CommercialSettings } from "@/newquip/pricing/commercial-settings";
import { saveProfile, latestProfile, latestCommercialSettings } from "@/lib/newquip-quotes/document-store";
import { missingProfileFields } from "@/lib/newquip-quotes/company-profile";
import type { Actor } from "../actor";
import * as actions from "../auto-pricing-actions";

// ALL FIGURES ARE FICTITIOUS TEST NUMBERS. Authorisation is re-established inside each action: only a Manager changes the settings; an Estimator sees the unresolved list alone; a Rep gets nothing.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/projects/latest-cost-adapter", () => ({ listCin7Suppliers: vi.fn(), readRawProductsForSurvey: vi.fn() }));
let db: FakeDb;
let actor: Actor;
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
const audits: Array<{ action: string; detail: Record<string, unknown> }> = [];
vi.mock("../actor", async (orig) => ({ ...(await orig<typeof import("../actor")>()), authoriseActor: vi.fn(async () => actor), auditActor: vi.fn(async (_d: unknown, _a: unknown, i: { action: string; detail: Record<string, unknown> }) => { audits.push(i); }) }));

const ORG = "org-nq";
const asActor = (email: string, roles: Array<"rep" | "estimator" | "manager">): Actor => ({ orgId: ORG, userId: `u-${email}`, email, tier: roles.includes("manager") ? "admin" : "member", roles: new Set(roles), canSeeCost: true, activeRole: null, demo: null });
const MGR = () => asActor("mgr@nq", ["manager"]);
const settings = (over: Partial<CommercialSettings> = {}): CommercialSettings => ({ ...emptyCommercialSettings(), freight: { factorMicro: 1_100_000, addOnCents: 250, source: "test freight policy" }, fx: { EUR: { rateMicro: 20_000_000, source: "test fixing", asOf: new Date(Date.now() - 3_600_000).toISOString() } }, ...over });
const PROFILE = { brandName: "TestBrand", legalName: "Test Company (Pty) Ltd", registrationNumber: "0000/000000/00", vatNumber: "0000000000", addressLines: ["1 Test Street", "Testville 0001"], phone: "000", email: "sales@testbrand.example", website: "", validityDays: 30, paymentTerms: "p", deliveryInstallationConditions: "d", termsAndConditions: "t", acceptanceInstructions: "a" };
const rowsCount = () => db.rows("newquip_company_profiles").length;

beforeEach(() => { db = new FakeDb(); db.deliveryApplied = true; actor = MGR(); audits.length = 0; });

describe("commercial settings: who may read and who may change", () => {
  it("a Rep (or an Estimator) cannot save: refused, nothing written", async () => {
    for (const a of [asActor("rep@nq", ["rep"]), asActor("est@nq", ["rep", "estimator"])]) {
      actor = a;
      expect(await actions.saveCommercialSettingsAction(settings(), null)).toMatchObject({ ok: false, error: expect.stringMatching(/Only a Manager/) });
    }
    expect(rowsCount()).toBe(0);
  });
  it("a Rep cannot even read; an Estimator gets the unresolved list and NO values", async () => {
    actor = asActor("rep@nq", ["rep"]);
    expect(await actions.getCommercialSettingsAction()).toMatchObject({ ok: false });
    await actions.saveCommercialSettingsAction(settings(), null).catch(() => undefined);
    actor = MGR(); expect((await actions.saveCommercialSettingsAction(settings(), null)).ok).toBe(true);
    actor = asActor("est@nq", ["rep", "estimator"]);
    const r = await actions.getCommercialSettingsAction();
    expect(r.ok).toBe(true);
    expect(r.data!.settings).toBeNull();
    expect(r.data!.canEdit).toBe(false);
    expect(JSON.stringify(r.data)).not.toMatch(/test freight policy|20000000|1100000/);
    expect(r.data!.unresolved.map((u) => u.code)).toEqual(["markup_default"]);
  });
  it("a Manager sees the values and the red unresolved list for an empty store (nothing invented)", async () => {
    const r = await actions.getCommercialSettingsAction();
    expect(r.data).toMatchObject({ available: true, canEdit: true, revision: null });
    expect(r.data!.settings!.freight).toBeNull();
    expect(r.data!.settings!.fx).toEqual({});
    expect(r.data!.unresolved.filter((u) => u.severity === "blocking").map((u) => u.code)).toEqual(["freight_not_set", "fx_none_set"]);
  });
});

describe("every Manager save is a NEW append-only version", () => {
  it("versions 1, 2, 3 with entered_by and a timestamp; earlier rows are never changed; stale forms are refused", async () => {
    const a = await actions.saveCommercialSettingsAction(settings(), null);
    expect(a.data).toMatchObject({ revision: 1, enteredBy: "mgr@nq" });
    const first = JSON.stringify(db.rows("newquip_company_profiles")[0]);
    const b = await actions.saveCommercialSettingsAction(settings({ markupBps: 2200 }), 1);
    expect(b.data).toMatchObject({ revision: 2 });
    const stale = await actions.saveCommercialSettingsAction(settings({ markupBps: 9999 }), 1);
    expect(stale).toMatchObject({ ok: false, error: expect.stringMatching(/changed by someone else/) });
    expect((await actions.saveCommercialSettingsAction(settings({ markupBps: 2300 }), 2)).data!.revision).toBe(3);
    expect(rowsCount()).toBe(3);
    expect(JSON.stringify(db.rows("newquip_company_profiles")[0])).toBe(first);
    expect(db.rows("newquip_company_profiles").every((r) => r.entered_by_email === "mgr@nq" && r.created_at)).toBe(true);
    expect((await latestCommercialSettings(db as never, ORG))!.settings.markupBps).toBe(2300);
    expect(audits.map((x) => x.action)).toEqual(Array(3).fill("newquip.commercial_settings_saved"));
    expect(JSON.stringify(audits)).not.toMatch(/test freight policy|1100000/); // the audit names what changed, not the figures
  });
  it("an invalid submission is refused with plain reasons and writes nothing", async () => {
    expect(await actions.saveCommercialSettingsAction({ ...settings(), fx: { EUR: { rateMicro: 0, source: "x", asOf: "bad" } } }, null)).toMatchObject({ ok: false });
    expect(await actions.saveCommercialSettingsAction("junk", null)).toMatchObject({ ok: false });
    expect(await actions.saveCommercialSettingsAction(settings(), 1.5 as never)).toMatchObject({ ok: false });
    expect(rowsCount()).toBe(0);
  });
});

describe("the interim store stays apart from the customer-facing company details", () => {
  it("the customer-facing profile never carries the commercial block, and neither save path disturbs the other", async () => {
    await saveProfile(db as never, ORG, PROFILE, "m@nq");
    await actions.saveCommercialSettingsAction(settings(), null);
    const p = (await latestProfile(db as never, ORG))!;
    expect(Object.keys(p.profile)).not.toContain("commercial");
    expect(JSON.stringify(p.profile)).not.toMatch(/test freight policy|20000000/);
    expect(p.profile).toMatchObject(PROFILE); // the customer-facing fields were carried forward untouched
    expect(missingProfileFields(p.profile)).toEqual([]);
    await saveProfile(db as never, ORG, { ...PROFILE, paymentTerms: "changed" }, "m@nq"); // a company-details save carries the settings forward
    const c = (await latestCommercialSettings(db as never, ORG))!;
    expect(c).toMatchObject({ revision: 1, enteredBy: "mgr@nq" });
    expect(c.settings.freight!.source).toBe("test freight policy");
    expect((await latestProfile(db as never, ORG))!.profile.paymentTerms).toBe("changed");
    await actions.saveCommercialSettingsAction(settings({ markupBps: 2100 }), 1); // and a settings save carries the details forward
    expect((await latestProfile(db as never, ORG))!.profile.paymentTerms).toBe("changed");
    expect(rowsCount()).toBe(4);
  });
  it("a company-details form that was never given the block cannot erase it, and a damaged block reads as not set", async () => {
    await actions.saveCommercialSettingsAction(settings(), null);
    await saveProfile(db as never, ORG, PROFILE, "m@nq");
    expect((await latestCommercialSettings(db as never, ORG))!.revision).toBe(1);
    (db.rows("newquip_company_profiles").at(-1) as unknown as { profile: { commercial: unknown } }).profile.commercial = { schema: 1, revision: 5, settings: "bad" };
    expect(await latestCommercialSettings(db as never, ORG)).toBeNull();
  });
});

describe("ensureAutoPricingAction never hands a Rep cost detail", () => {
  it("the Rep outcome carries neutral wording only", async () => {
    actor = asActor("rep@nq", ["rep"]);
    const r = await actions.ensureAutoPricingAction("no-such-quote");
    expect(r).toMatchObject({ ok: true, data: { status: "not_applicable", internal: [] } });
    expect(await actions.ensureAutoPricingAction("")).toMatchObject({ ok: false });
  });
});
