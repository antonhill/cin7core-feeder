import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, supabaseOriginFromUrl } from "../csp";

const PROD = "https://pnzwjqjovxxdikxtfngq.supabase.co";
const TEST = "https://witulfbpotimvbfiqbwq.supabase.co";

/** The exact policy next.config.ts shipped before the origin was derived from the environment. */
const LEGACY_PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: ${PROD}`,
  "font-src 'self' data:",
  `connect-src 'self' ${PROD}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' https://*.lemonsqueezy.com",
].join("; ");

const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(name + " "));

describe("Content-Security-Policy", () => {
  it("production: the production Supabase URL yields a policy byte-identical to the previous hard-coded one", () => {
    expect(buildContentSecurityPolicy(PROD)).toBe(LEGACY_PRODUCTION_CSP);
  });

  it("a branch-specific Preview allows ITS OWN Supabase origin (and not production's)", () => {
    const csp = buildContentSecurityPolicy(TEST);
    expect(directive(csp, "connect-src")).toBe(`connect-src 'self' ${TEST}`);
    expect(directive(csp, "img-src")).toBe(`img-src 'self' data: ${TEST}`);
    expect(csp).not.toContain("pnzwjqjovxxdikxtfngq");
  });

  it("allows exactly one Supabase origin and never a wildcard Supabase domain", () => {
    for (const url of [PROD, TEST]) {
      const csp = buildContentSecurityPolicy(url);
      expect(csp).not.toMatch(/\*\.supabase\.(co|com|in)/);
      expect(csp.match(/supabase\.co/g)).toHaveLength(2); // connect-src + img-src, once each
    }
  });

  it("does not weaken or alter any other directive", () => {
    const strip = (c: string) => c.split("; ").filter((d) => !/^(connect-src|img-src)/.test(d));
    expect(strip(buildContentSecurityPolicy(TEST))).toEqual(strip(LEGACY_PRODUCTION_CSP));
    const csp = buildContentSecurityPolicy(TEST);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self' https://*.lemonsqueezy.com");
  });

  it("is generic: no branch/organisation special-casing in the builder", () => {
    expect(buildContentSecurityPolicy("https://abcdefghijklmnopqrst.supabase.co")).toContain("connect-src 'self' https://abcdefghijklmnopqrst.supabase.co");
  });

  it("fails closed to 'self' when the URL is missing, malformed or unsafe", () => {
    for (const bad of [undefined, null, "", "   ", "not a url", "javascript:alert(1)", "ftp://x.supabase.co", "http://evil.example.com", "https://user:pw@x.supabase.co"]) {
      const csp = buildContentSecurityPolicy(bad as string | undefined);
      expect(directive(csp, "connect-src")).toBe("connect-src 'self'");
      expect(directive(csp, "img-src")).toBe("img-src 'self' data:");
    }
  });

  it("accepts plain http only for loopback (local supabase start)", () => {
    expect(supabaseOriginFromUrl("http://127.0.0.1:54321")).toBe("http://127.0.0.1:54321");
    expect(supabaseOriginFromUrl("http://localhost:54321")).toBe("http://localhost:54321");
    expect(supabaseOriginFromUrl("http://witulfbpotimvbfiqbwq.supabase.co")).toBeNull();
  });

  it("normalises to an origin (drops path/query)", () => {
    expect(supabaseOriginFromUrl("https://witulfbpotimvbfiqbwq.supabase.co/rest/v1/?x=1")).toBe(TEST);
    expect(supabaseOriginFromUrl(`  ${TEST}  `)).toBe(TEST);
  });
});
