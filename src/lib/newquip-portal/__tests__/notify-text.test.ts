import { describe, expect, it, vi } from "vitest";
import { EMAIL_MARKER, LINK_MARKER, queueResponseNotifications, safeCustomerText } from "../notify";

vi.mock("server-only", () => ({}));

describe("safeCustomerText: untrusted customer text in internal email", () => {
  it.each([
    ["https://evil.example/login?x=1", "https"], ["HTTP://EVIL.EXAMPLE", "uppercase scheme"], ["www.evil.example/pay", "www"], ["evil.example/pay", "bare host/path"], ["evil.co.za", "bare domain"],
    ["javascript:alert(1)", "javascript:"], ["mailto:boss@evil.example", "mailto"], ["tel:+27111111111", "tel"], ["data:text/html;base64,AAAA", "data:"], ["ftp://x.example/f", "ftp"], ["sftp://x.example/f", "sftp"],
    ["hxxps://evil.example", "defanged scheme://"], ["evil.example:8080/x", "host:port"], ["ｗｗｗ.evil.example", "full-width www (NFKC)"],
  ])("removes %s (%s)", (input) => {
    const out = safeCustomerText(`Please see ${input} for details`);
    expect(out).not.toMatch(/https?:|www\.|evil|javascript:|mailto:|tel:|data:|ftp:|:\/\//i);
    expect(out.includes(LINK_MARKER) || out.includes(EMAIL_MARKER)).toBe(true);   // mailto: is caught as an email address
    expect(out.startsWith("Please see")).toBe(true); expect(out.endsWith("for details")).toBe(true);   // the readable remainder survives
  });
  it("replaces email addresses and keeps surrounding words", () => {
    const out = safeCustomerText("Reply to boss@evil.example about the order"); expect(out).toBe(`Reply to ${EMAIL_MARKER} about the order`);
  });
  it("turns control, zero-width, bidirectional-override and line-break characters into plain spaces", () => {
    const out = safeCustomerText("line one\r\nline\ttwo\u0007 \u202Eevil\u202C \u200Bhid\u200Bden\u2028x\u0085y\uFEFFz");
    expect(out).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/); expect(out).not.toContain("\n"); expect(out).toContain("line one line two");
  });
  it("caps the length (with an ellipsis) and collapses whitespace", () => {
    const out = safeCustomerText(`${"word ".repeat(200)}`, 100); expect(out.length).toBeLessThanOrEqual(100); expect(out.endsWith("…")).toBe(true);
    expect(safeCustomerText("a    b\n\n\nc")).toBe("a b c");
  });
  it("leaves ordinary business text intact: sentences, prices, quantities, colons and decimals", () => {
    for (const ok of ["Please change the delivery to 14 November and add 2 extra feeders.", "Price: too high, we need R 1 250.50 per unit (4.5m long).", "Note: e.g. 10.5 tonnes, approx 3 weeks"]) expect(safeCustomerText(ok, 400)).toBe(ok);
  });
  it("is safe on null, undefined and empty input", () => { expect(safeCustomerText(null)).toBe(""); expect(safeCustomerText(undefined)).toBe(""); expect(safeCustomerText("   ")).toBe(""); });
});

describe("the queued notification (email + in-app) never carries a clickable customer-supplied link", () => {
  const rows: Array<Record<string, unknown>> = [];
  const db = { from: (t: string) => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: async () => ({ data: [], error: null }) }) }) }), insert: (r: Record<string, unknown> | Array<Record<string, unknown>>) => { rows.push(...(Array.isArray(r) ? r : [r]).map((x) => ({ ...x, __t: t }))); return { select: async () => ({ data: [], error: null }) , then: (f: (v: unknown) => unknown) => f({ error: null }) }; }, upsert: (r: Record<string, unknown> | Array<Record<string, unknown>>) => { rows.push(...(Array.isArray(r) ? r : [r]).map((x) => ({ ...x, __t: t }))); return { select: async () => ({ data: [], error: null }), then: (f: (v: unknown) => unknown) => f({ error: null }) }; } }) };
  it("a hostile reason and a hostile name/company are neutralised in subject, body and every stored copy", async () => {
    const response = { id: "r1", origin: "CUSTOMER_LINK", response: "DECLINED", contact_name: "Pete https://evil.example/a", contact_company: "ACME www.evil.example", created_at: "2026-10-31T10:00:00Z" };
    await queueResponseNotifications(db as never, { orgId: "o", quoteId: "q", quoteRef: "NQ-Q-0001", customerName: "Farm", event: "DECLINED", response: response as never, recipients: ["rep@sparkconsulting.co.za"], reason: "Too dear, see https://evil.example/pay or mail boss@evil.example now" }).catch(() => undefined);
    const all = JSON.stringify(rows); expect(rows.length).toBeGreaterThan(0);
    expect(all).not.toMatch(/evil/i); expect(all).toContain(LINK_MARKER);
  });
});
