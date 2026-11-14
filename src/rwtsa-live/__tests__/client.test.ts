import { describe, expect, it, vi } from "vitest";
import { createReadOnlyClient } from "@/rwtsa-live/client";
import { ACCOUNT, APPKEY, fakeFetch, noSleep } from "./helpers";

const creds = { accountId: ACCOUNT, applicationKey: APPKEY, instanceLabel: "i" };
const mk = (routes: Parameters<typeof fakeFetch>[0], extra: Record<string, unknown> = {}) => {
  const f = fakeFetch(routes);
  return { f, c: createReadOnlyClient({ creds, fetchImpl: f.impl, sleep: noSleep, now: () => 0, minIntervalMs: 0, ...extra }) };
};

describe("read-only Cin7 client", () => {
  it("sends only GET, to the Cin7 host, with manual redirects and the two auth headers", async () => {
    const { f, c } = mk({ "/ref/location": () => ({ body: { LocationList: [] } }) });
    await c.get("/ref/location", { Page: 1, Limit: 100 });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].method).toBe("GET"); expect(f.calls[0].redirect).toBe("manual");
    expect(new URL(f.calls[0].url).host).toBe("inventory.dearsystems.com");
    expect(f.calls[0].headers["api-auth-accountid"]).toBe(ACCOUNT);
  });
  it("makes no network call for a non-allowlisted path", async () => {
    const { f, c } = mk({});
    await expect(c.get("/sale")).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
  it("retries 503 then succeeds; gives up with a RATE_LIMITED error after the ceiling", async () => {
    let n = 0;
    const ok = mk({ "/ref/location": () => (++n < 3 ? { status: 503 } : { body: { LocationList: [{ ID: "a" }] } }) }, { maxRetries: 4 });
    expect(await ok.c.get("/ref/location")).toBeTruthy(); expect(ok.f.calls).toHaveLength(3);
    const bad = mk({ "/ref/location": () => ({ status: 503 }) }, { maxRetries: 2 });
    await expect(bad.c.get("/ref/location")).rejects.toMatchObject({ code: "RATE_LIMITED" }); expect(bad.f.calls).toHaveLength(3);
  });
  it("429 is treated like 503", async () => {
    let n = 0; const { f, c } = mk({ "/ref/location": () => (++n < 2 ? { status: 429 } : { body: {} }) }); await c.get("/ref/location"); expect(f.calls).toHaveLength(2);
  });
  it("auth rejection (401/403) is not retried", async () => {
    const { f, c } = mk({ "/ref/location": () => ({ status: 401 }) });
    await expect(c.get("/ref/location")).rejects.toMatchObject({ code: "AUTH_REJECTED" }); expect(f.calls).toHaveLength(1);
  });
  it("a redirect is refused, never followed", async () => {
    const { c } = mk({ "/ref/location": () => ({ status: 302 }) });
    await expect(c.get("/ref/location")).rejects.toMatchObject({ code: "REDIRECT_REFUSED" });
  });
  it("a network failure is a clear NETWORK error after bounded retries", async () => {
    const { f, c } = mk({ "/ref/location": () => ({ throws: true }) }, { maxRetries: 1 });
    await expect(c.get("/ref/location")).rejects.toMatchObject({ code: "NETWORK" }); expect(f.calls).toHaveLength(2);
  });
  it("paces requests: waits at least minIntervalMs between calls", async () => {
    const waits: number[] = []; let t = 0;
    const f = fakeFetch({ "/ref/location": () => ({ body: {} }) });
    const c = createReadOnlyClient({ creds, fetchImpl: f.impl, sleep: async (ms) => { waits.push(ms); t += ms; }, now: () => t, minIntervalMs: 1250 });
    await c.get("/ref/location"); await c.get("/ref/location"); await c.get("/ref/location");
    expect(waits.filter((w) => w > 0).length).toBeGreaterThanOrEqual(2); expect(waits.every((w) => w <= 1250)).toBe(true);
  });
  it("errors and logs never contain credentials or response bodies", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const { c } = mk({ "/ref/location": () => ({ status: 500, body: { secret: "BODYSECRET" } }) });
    let msg = ""; try { await c.get("/ref/location"); } catch (e) { msg = String((e as Error).message); }
    expect(msg).not.toContain(APPKEY); expect(msg).not.toContain(ACCOUNT); expect(msg).not.toContain("BODYSECRET");
    for (const s of spies) { expect(s).not.toHaveBeenCalled(); s.mockRestore(); }
  });
});
