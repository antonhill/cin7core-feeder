import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { emptyCommercialSettings, type CommercialSettings } from "@/newquip/pricing/commercial-settings";
import { latestCommercialSettings, saveCommercialSettings } from "../document-store";
import { feedEntries, refreshFxFromFeed } from "../fx-feed";
import { fetchOxrRates } from "@/newquip/pricing/fx/open-exchange-rates";
import { nextProfileWithCommercial } from "../commercial-block";

vi.mock("server-only", () => ({}));
// FICTITIOUS provider data. No network: fetch is faked.
const ORG = "org-nq";
const NOW = "2026-11-17T12:00:00Z";
const TS = Math.floor(Date.parse("2026-11-17T11:30:00Z") / 1000);
const body = (over: Record<string, unknown> = {}) => ({ base: "USD", timestamp: TS, rates: { ZAR: 17.5, EUR: 0.86 }, ...over });
const okFetch = (b: unknown = body(), status = 200): typeof fetch => (async () => ({ ok: status < 400, status, json: async () => b })) as unknown as typeof fetch;
const ENV = { OPENEXCHANGERATES_APP_ID: "test-app-id" };
let db: FakeDb;
const base = (over: Partial<CommercialSettings> = {}): CommercialSettings => ({ ...emptyCommercialSettings(), markupBps: 2500, freight: { factorMicro: 1_150_000, addOnCents: 0, source: "TEST-ONLY" }, ...over });
const manual = { rateMicro: 16_000_000, source: "TEST-ONLY rate", asOf: "2026-11-16T08:48:00Z", origin: "manual" as const };

beforeEach(() => { db = new FakeDb(); db.deliveryApplied = true; });

describe("Open Exchange Rates feed into the Manager's settings", () => {
  it("derives EUR/ZAR exactly from the USD base and records source, provider timestamp and retrieval time", async () => {
    const r = await fetchOxrRates("id", { fetchFn: okFetch(), now: () => new Date(NOW) });
    const e = feedEntries(r);
    expect(e.USD).toMatchObject({ rateMicro: 17_500_000, origin: "oxr", asOf: "2026-11-17T11:30:00.000Z", retrievedAt: NOW.replace("Z", ".000Z") });
    expect(e.EUR.rateMicro).toBe(20_348_837); // 17.5 / 0.86 = 20.348837...
    expect(e.EUR.source).toContain("derived from the USD base");
  });
  it("writes a NEW version with feed rates; a Manager's manual override is KEPT unless asked; replacing it is explicit", async () => {
    await saveCommercialSettings(db as never, ORG, base({ fx: { USD: manual, EUR: manual } }), "mgr@nq", NOW);
    const kept = await refreshFxFromFeed(db as never, ORG, "feed", { env: ENV, fetchFn: okFetch(), nowIso: NOW });
    expect(kept).toMatchObject({ ok: true, updated: [], keptManual: ["EUR", "USD"] });
    expect((await latestCommercialSettings(db as never, ORG, NOW))!.revision).toBe(1); // nothing written
    const replaced = await refreshFxFromFeed(db as never, ORG, "feed", { replaceManual: true, env: ENV, fetchFn: okFetch(), nowIso: NOW });
    expect(replaced).toMatchObject({ ok: true, updated: ["EUR", "USD"], revision: 2 });
    const v = (await latestCommercialSettings(db as never, ORG, NOW))!;
    expect(v.settings.fx.USD).toMatchObject({ origin: "oxr", rateMicro: 17_500_000 });
    expect(v.settings.freight).toMatchObject({ factorMicro: 1_150_000 }); // everything else untouched
    expect(v.epoch).toBe(1); // an exchange-rate refresh is not a pricing-relevant change
  });
  it("a provider problem writes NOTHING and says why; there is no fallback and an expired rate is not made current", async () => {
    await saveCommercialSettings(db as never, ORG, base({ fx: { USD: { ...manual, origin: "oxr" } } }), "mgr@nq", NOW);
    const stale = await refreshFxFromFeed(db as never, ORG, "feed", { env: ENV, fetchFn: okFetch(body({ timestamp: TS - 3 * 3600 })), nowIso: NOW });
    expect(stale).toMatchObject({ ok: false }); expect(stale.error).toMatch(/stale/);
    expect((await refreshFxFromFeed(db as never, ORG, "feed", { env: ENV, fetchFn: okFetch({ error: true, message: "invalid_app_id" }, 401), nowIso: NOW })).error).toMatch(/refused/);
    expect((await refreshFxFromFeed(db as never, ORG, "feed", { env: {}, fetchFn: okFetch(), nowIso: NOW })).error).toMatch(/not configured/);
    expect((await refreshFxFromFeed(db as never, ORG, "feed", { env: ENV, fetchFn: okFetch(body({ rates: { ZAR: 17.5 } })), nowIso: NOW })).error).toMatch(/EUR rate is missing/);
    const v = (await latestCommercialSettings(db as never, ORG, NOW))!;
    expect(v.revision).toBe(1); expect(v.settings.fx.USD.asOf).toBe("2026-11-16T08:48:00Z"); // still the old (now expired) rate, never silently refreshed or invented
  });
  it("automatic use (onlyIfStale) refreshes only a stale feed-owned or missing rate, and never a manual override", async () => {
    await saveCommercialSettings(db as never, ORG, base({ fx: { USD: manual, EUR: manual } }), "mgr@nq", NOW);
    expect(await refreshFxFromFeed(db as never, ORG, "feed", { onlyIfStale: true, env: ENV, fetchFn: okFetch(), nowIso: NOW })).toMatchObject({ updated: [] });
    const fetchSpy = vi.fn(okFetch());
    await saveCommercialSettings(db as never, ORG, base({ fx: { USD: { ...manual, origin: "oxr", asOf: "2026-11-17T11:00:00Z" }, EUR: { ...manual, origin: "oxr", asOf: "2026-11-17T11:00:00Z" } } }), "mgr@nq", NOW);
    expect(await refreshFxFromFeed(db as never, ORG, "feed", { onlyIfStale: true, env: ENV, fetchFn: fetchSpy, nowIso: NOW })).toMatchObject({ ok: true, updated: [] });
    expect(fetchSpy).not.toHaveBeenCalled(); // fresh: no provider call at all
  });
});

describe("settings epoch: only a pricing-relevant change moves it", () => {
  it("an exchange-rate-only save keeps the epoch; a freight/markup/band change moves it", () => {
    const v1 = { revision: 1, epoch: 1, enteredBy: "m", enteredAt: NOW, settings: base() };
    const fxOnly = nextProfileWithCommercial({}, v1, base({ fx: { USD: manual } }), "m", NOW) as { commercial: { revision: number; epoch: number } };
    expect(fxOnly.commercial).toMatchObject({ revision: 2, epoch: 1 });
    const changed = nextProfileWithCommercial({}, { ...v1, revision: 2, epoch: 1 }, base({ markupBps: 3000 }), "m", NOW) as { commercial: { revision: number; epoch: number } };
    expect(changed.commercial).toMatchObject({ revision: 3, epoch: 3 });
  });
  it("the order of the freight categories (form order versus stored order) never looks like a pricing change", () => {
    const f = (factor: number) => ({ factorMicro: factor, addOnCents: 0, source: "TEST-ONLY" });
    const a = base({ freightByCategory: { feeder: f(1_250_000), bulk_tank: f(1_300_000) } });
    const b = base({ freightByCategory: { bulk_tank: f(1_300_000), feeder: f(1_250_000) } });
    const v1 = { revision: 1, epoch: 1, enteredBy: "m", enteredAt: NOW, settings: a };
    expect((nextProfileWithCommercial({}, v1, { ...b, fx: { USD: manual } }, "m", NOW) as { commercial: { epoch: number } }).commercial.epoch).toBe(1);
  });
});
