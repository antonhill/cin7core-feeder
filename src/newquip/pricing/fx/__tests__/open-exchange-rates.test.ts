import { describe, expect, it } from "vitest";
import { deriveEurZar, fetchOxrRates, OXR_URL, OxrError } from "../open-exchange-rates";

const NOW = new Date("2026-11-14T12:00:00.000Z");
const ts = (offsetS = 0) => Math.floor(NOW.getTime() / 1000) + offsetS;
const reply = (body: unknown, status = 200): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const good = (over: Record<string, unknown> = {}) => ({ base: "USD", timestamp: ts(-600), rates: { EUR: 0.8625, ZAR: 17.4219 }, ...over });
const run = (f: typeof fetch, key = "KEY") => fetchOxrRates(key, { fetchFn: f, now: () => NOW });

describe("deriveEurZar is exact", () => {
  it("divides ZAR per USD by EUR per USD, half-up at 6 decimals", () => {
    expect(deriveEurZar(17.4219, 0.8625)).toBe("20.199304"); // 17.4219 / 0.8625 = 20.19930434...
    expect(deriveEurZar(18, 0.9)).toBe("20.000000");
    expect(deriveEurZar(1, 3)).toBe("0.333333");
    expect(deriveEurZar(2, 3)).toBe("0.666667");
  });
});

describe("fetchOxrRates", () => {
  it("returns the provider rate, the derived cross-rate, and both timestamps", async () => {
    const r = await run(reply(good()));
    expect(r).toMatchObject({ base: "USD", usdZar: "17.4219", eurZar: "20.199304", providerTimestamp: new Date((ts(-600)) * 1000).toISOString(), retrievedAt: NOW.toISOString(), inputs: { zarPerUsd: "17.4219", eurPerUsd: "0.8625" } });
  });
  it("sends the app id in the Authorization header, never the URL, and never returns it", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const f = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify(good())); }) as unknown as typeof fetch;
    const r = await run(f, "SECRET-APP-ID");
    expect(seen!.url).toBe(OXR_URL);
    expect(seen!.url).not.toContain("SECRET-APP-ID");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Token SECRET-APP-ID");
    expect(JSON.stringify(r)).not.toContain("SECRET-APP-ID");
  });
  it("refuses a missing key without calling the provider", async () => {
    let called = false;
    await expect(fetchOxrRates("  ", { fetchFn: (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch })).rejects.toThrow(/not configured/);
    expect(called).toBe(false);
  });
  it("refuses provider errors, non-JSON, network failure, wrong base, bad timestamps and missing or implausible rates, never falling back", async () => {
    await expect(run(reply({ error: true, status: 403, message: "missing_app_id" }, 403))).rejects.toThrow(/refused the request: HTTP 403 missing_app_id/);
    await expect(run((async () => new Response("<html>", { status: 502 })) as unknown as typeof fetch)).rejects.toThrow(/non-JSON/);
    await expect(run((async () => { throw new Error("boom SECRET"); }) as unknown as typeof fetch)).rejects.toThrow(/could not be reached/);
    await expect(run(reply(good({ base: "EUR" })))).rejects.toThrow(/USD base/);
    await expect(run(reply(good({ timestamp: "x" })))).rejects.toThrow(/valid timestamp/);
    await expect(run(reply(good({ timestamp: ts(-3 * 3600) })))).rejects.toThrow(/stale/);
    await expect(run(reply(good({ timestamp: ts(3600) })))).rejects.toThrow(/future/);
    await expect(run(reply(good({ rates: { EUR: 0.86 } })))).rejects.toThrow(/ZAR rate is missing/);
    await expect(run(reply(good({ rates: { ZAR: 17.4 } })))).rejects.toThrow(/EUR rate is missing/);
    await expect(run(reply(good({ rates: { ZAR: 1740, EUR: 0.86 } })))).rejects.toThrow(/implausible/);
    await expect(run(reply(good({ rates: { ZAR: "17.4", EUR: 0.86 } })))).rejects.toThrow(/implausible/);
    await expect(run(reply(good({ rates: { ZAR: 17.4, EUR: 0 } })))).rejects.toThrow(OxrError);
  });
});
