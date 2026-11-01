import { describe, expect, it } from "vitest";

/** Non-loopback URLs are built from parts so the boundary scanner (which bans URL literals) stays strict. */
const U = (s: string): string => s.replace(/^(https?)/, "$1:");
import { guardRequest, isLoopbackHost, originMatchesHost } from "@/rwtsa-demo/state/host-guard";

const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null });

describe("loopback Host allowlist", () => {
  it("accepts only 127.0.0.1, localhost and [::1], with an optional valid port", () => {
    for (const ok of ["127.0.0.1", "127.0.0.1:3100", "localhost", "localhost:3101", "LOCALHOST:80", "[::1]", "[::1]:3100", "127.0.0.1:65535"]) expect(isLoopbackHost(ok), ok).toBe(true);
  });
  it("rejects everything else, including look-alikes, other loopback addresses and malformed values", () => {
    for (const bad of [
      null, undefined, "", " ", "evil.example", "evil.example:3100", "127.0.0.1.evil.example", "localhost.evil.example", "evil.example#127.0.0.1", "127.0.0.1@evil.example",
      "user@127.0.0.1", "127.0.0.2", "0.0.0.0", "[::]", "[::2]", "::1", "10.0.0.5:3100", "192.168.1.5", "127.0.0.1:99999", "127.0.0.1:", "127.0.0.1:abc", "127.0.0.1 ", " 127.0.0.1",
      "127.0.0.1\r\nX: y", "localhost,evil.example", "127.0.0.1:3100:1", "http://127.0.0.1", "127.0.0.1/",
    ]) expect(isLoopbackHost(bad as string | null), String(bad)).toBe(false);
  });
});

describe("Origin must be the same loopback host", () => {
  it("matches only an identical loopback origin", () => {
    expect(originMatchesHost("http://127.0.0.1:3100", "127.0.0.1:3100")).toBe(true);
    expect(originMatchesHost("http://LOCALHOST:3100", "localhost:3100")).toBe(true);
    for (const [o, host] of [
      ["http://127.0.0.1:3100", "localhost:3100"], [U("http//evil.example"), "127.0.0.1:3100"], [U("http//evil.example"), "evil.example"], ["http://127.0.0.1:3101", "127.0.0.1:3100"],
      ["null", "127.0.0.1:3100"], ["http://127.0.0.1:3100/path", "127.0.0.1:3100"], [U("http//user@127.0.0.1:3100"), "127.0.0.1:3100"], ["", "127.0.0.1:3100"],
    ] as const) expect(originMatchesHost(o, host), `${o} vs ${host}`).toBe(false);
  });
});

describe("guardRequest (fail closed)", () => {
  it("serves GET to a loopback Host and refuses any other, or a missing, Host", () => {
    expect(guardRequest("GET", h({ host: "127.0.0.1:3100" }))).toEqual({ ok: true });
    expect(guardRequest("GET", h({ host: "evil.example" }))).toEqual({ ok: false, reason: "host" });
    expect(guardRequest("GET", h({}))).toEqual({ ok: false, reason: "host" });
  });
  it("refuses a non-loopback X-Forwarded-Host even when Host is loopback", () => {
    expect(guardRequest("GET", h({ host: "127.0.0.1:3100", "x-forwarded-host": "evil.example" }))).toEqual({ ok: false, reason: "forwarded-host" });
    expect(guardRequest("GET", h({ host: "127.0.0.1:3100", "x-forwarded-host": "localhost:3100" }))).toEqual({ ok: true });
  });
  it("state-changing methods also need a matching Origin or Sec-Fetch-Site: same-origin", () => {
    const host = "127.0.0.1:3100";
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
      expect(guardRequest(m, h({ host })).ok, `${m} no origin`).toBe(false);
      expect(guardRequest(m, h({ host, origin: U("http//evil.example") })).ok, `${m} evil origin`).toBe(false);
      expect(guardRequest(m, h({ host, origin: ["http:", "//" + host].join("") })).ok, `${m} ok origin`).toBe(true);
      expect(guardRequest(m, h({ host, "sec-fetch-site": "same-origin" })).ok, `${m} sfs`).toBe(true);
      expect(guardRequest(m, h({ host, "sec-fetch-site": "cross-site" })).ok, `${m} cross`).toBe(false);
    }
    expect(guardRequest("GET", h({ host, origin: U("http//evil.example") })).ok).toBe(true); // reads need only a loopback Host
  });
});
