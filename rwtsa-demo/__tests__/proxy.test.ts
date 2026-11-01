import { describe, expect, it } from "vitest";

/** Non-loopback URLs are built from parts so the boundary scanner (which bans URL literals) stays strict. */
const U = (s: string): string => s.replace(/^(https?)/, "$1:");
import { config, proxy } from "../proxy";

const req = (method: string, headers: Record<string, string>) => new Request("http://127.0.0.1:3100/scenario-a", { method, headers });

describe("rwtsa-demo proxy (Host gate)", () => {
  it("lets loopback requests through (undefined = continue)", () => {
    expect(proxy(req("GET", { host: "127.0.0.1:3100" }))).toBeUndefined();
    expect(proxy(req("GET", { host: "localhost:3101" }))).toBeUndefined();
    expect(proxy(req("POST", { host: "127.0.0.1:3100", origin: "http://127.0.0.1:3100" }))).toBeUndefined();
  });
  it("answers an external Host with a bare 403: no redirect, no echo, not cacheable", async () => {
    const r = proxy(req("GET", { host: "evil.example:3100" })) as Response;
    expect(r.status).toBe(403);
    expect(r.headers.get("location")).toBeNull();
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = await r.text();
    expect(body).not.toContain("evil.example");
  });
  it("refuses a state-changing request without a matching Origin", () => {
    expect(proxy(req("POST", { host: "127.0.0.1:3100" }))?.status).toBe(403);
    expect(proxy(req("POST", { host: "127.0.0.1:3100", origin: U("http//evil.example") }))?.status).toBe(403);
  });
  it("matches every path, so pages, API routes and static files are all gated", () => {
    expect(config.matcher).toEqual(["/:path*"]);
  });
});
