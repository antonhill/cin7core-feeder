import { describe, expect, it } from "vitest";
import { CIN7_API_ORIGIN, isAllowedCin7Url, assertAllowedCin7Url, buildCin7Url, Cin7OriginError } from "@/cin7/api-origin";

describe("isAllowedCin7Url", () => {
  it("accepts the canonical origin and paths within its prefix", () => {
    expect(isAllowedCin7Url(CIN7_API_ORIGIN)).toBe(true);
    expect(isAllowedCin7Url(`${CIN7_API_ORIGIN}/product`)).toBe(true);
    expect(isAllowedCin7Url(`${CIN7_API_ORIGIN}/saleList?Page=1`)).toBe(true);
  });

  it("rejects an arbitrary attacker domain", () => {
    expect(isAllowedCin7Url("https://evil.example")).toBe(false);
    expect(isAllowedCin7Url("https://evil.example/ExternalApi/v2/product")).toBe(false);
  });

  it("rejects http (must be https)", () => {
    expect(isAllowedCin7Url("http://inventory.dearsystems.com/ExternalApi/v2/product")).toBe(false);
  });

  it("rejects localhost and private/link-local IP ranges", () => {
    for (const host of ["localhost", "127.0.0.1", "0.0.0.0", "10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254", "[::1]"]) {
      expect(isAllowedCin7Url(`https://${host}/ExternalApi/v2/product`)).toBe(false);
    }
  });

  it("rejects credentials embedded in the URL", () => {
    expect(isAllowedCin7Url("https://user:pass@inventory.dearsystems.com/ExternalApi/v2/product")).toBe(false);
  });

  it("rejects an unexpected explicit port", () => {
    expect(isAllowedCin7Url("https://inventory.dearsystems.com:8443/ExternalApi/v2/product")).toBe(false);
    expect(isAllowedCin7Url("https://inventory.dearsystems.com:80/ExternalApi/v2/product")).toBe(false);
    // :443 is the implicit default for https — the URL parser normalizes it away, so it's the
    // same origin and is correctly allowed (not an "unexpected" port).
    expect(isAllowedCin7Url("https://inventory.dearsystems.com:443/ExternalApi/v2/product")).toBe(true);
  });

  it("rejects a look-alike / subdomain host", () => {
    expect(isAllowedCin7Url("https://inventory.dearsystems.com.evil.example/ExternalApi/v2/product")).toBe(false);
    expect(isAllowedCin7Url("https://evil.inventory.dearsystems.com/ExternalApi/v2/product")).toBe(false);
  });

  it("rejects a path outside the /ExternalApi/v2 prefix", () => {
    expect(isAllowedCin7Url("https://inventory.dearsystems.com/other/product")).toBe(false);
    expect(isAllowedCin7Url("https://inventory.dearsystems.com/")).toBe(false);
    // prefix must be a real segment boundary, not a string-prefix trick
    expect(isAllowedCin7Url("https://inventory.dearsystems.com/ExternalApi/v2evil")).toBe(false);
  });

  it("assertAllowedCin7Url throws a typed error on a bad URL", () => {
    expect(() => assertAllowedCin7Url("https://evil.example")).toThrow(Cin7OriginError);
    expect(() => assertAllowedCin7Url(CIN7_API_ORIGIN)).not.toThrow();
  });
});

describe("buildCin7Url", () => {
  it("always roots the request at the canonical origin", () => {
    expect(buildCin7Url("/product").toString()).toBe(`${CIN7_API_ORIGIN}/product`);
    const withQuery = buildCin7Url("/saleList", { Page: 2, Limit: 500 });
    expect(withQuery.origin).toBe(new URL(CIN7_API_ORIGIN).origin);
    expect(withQuery.searchParams.get("Page")).toBe("2");
    expect(withQuery.searchParams.get("Limit")).toBe("500");
  });

  it("rejects a path that tries to escape the API prefix via ../", () => {
    expect(() => buildCin7Url("/../../etc/passwd")).toThrow(Cin7OriginError);
  });

  it("rejects a non-string or non-'/'-prefixed path", () => {
    expect(() => buildCin7Url("product")).toThrow(Cin7OriginError);
    // @ts-expect-error deliberately wrong type
    expect(() => buildCin7Url(undefined)).toThrow(Cin7OriginError);
  });
});
