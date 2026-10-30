import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

// The customer response surface must be a bare, session-less document: no Toolbox shell, no staff identity, no internal controls - and must not depend on CSS to hide them.
const sessionTouched = vi.fn();
vi.mock("@supabase/ssr", () => ({ createServerClient: () => { sessionTouched("supabase client"); throw new Error("the customer surface must not touch the session"); } }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => { sessionTouched("service role"); throw new Error("no service role in middleware for the customer surface"); } }));
let hdrs = new Headers();
vi.mock("next/headers", () => ({ headers: async () => hdrs }));
vi.mock("next/font/google", () => ({ Geist: () => ({ variable: "f1" }), Geist_Mono: () => ({ variable: "f2" }) }));
const getInfo = vi.fn();
vi.mock("@/actions/auth", () => ({ getCurrentUserInfo: (...a: unknown[]) => getInfo(...a) }));
vi.mock("@/actions/org-switch", () => ({ clearImpersonatedOrgAction: vi.fn() }));
vi.mock("@/lib/billing", () => ({ checkoutAvailableFor: () => false }));
vi.mock("@/app/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div data-testid="toolbox-shell"><aside>Toolbox sidebar staff@acme.test</aside>{children}</div> }));
vi.mock("@/app/DemoModeBar", () => ({ DemoModeBar: () => <div>DEMO MODE BAR</div> }));
vi.mock("@/app/tour-guide", () => ({ default: () => <div>TOUR GUIDE</div> }));

import { middleware } from "@/middleware";
import { isCustomerSurface, CUSTOMER_SURFACE_HEADER } from "@/lib/customer-surface";
import RootLayout from "@/app/layout";

const SRC = join(__dirname, "..", "..", "..");
beforeEach(() => { sessionTouched.mockClear(); getInfo.mockReset(); hdrs = new Headers(); });

describe("customer surface paths", () => {
  it("covers the page, its sub-paths and the PDF route - and nothing else", () => {
    for (const p of ["/quote-response", "/quote-response/", "/quote-response/x", "/api/quote-response/document"]) expect(isCustomerSurface(p), p).toBe(true);
    for (const p of ["/", "/quote-responses", "/quote-response-x", "/newquip-grower/abc", "/api/newquip-quote-responses", "/quotes", "/x/quote-response", "/api/quote-responsex"]) expect(isCustomerSurface(p), p).toBe(false);
  });
});

describe("middleware", () => {
  it("serves a customer link with NO session handling at all, even for a signed-in staff browser, and never lets it be cached or referred", async () => {
    const req = new NextRequest("https://app.test/quote-response", { headers: { cookie: "sb-abc-auth-token=staff-session" } });
    const res = await middleware(req);
    expect(sessionTouched).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
    expect(res.headers.get("x-middleware-request-" + CUSTOMER_SURFACE_HEADER)).toBe("customer-response"); // forwarded to the layout as a REQUEST header
  });
  it("an anonymous caller is not redirected to /login on the PDF route either", async () => {
    const res = await middleware(new NextRequest("https://app.test/api/quote-response/document", { method: "POST" }));
    expect(res.headers.get("location")).toBeNull(); expect(sessionTouched).not.toHaveBeenCalled();
  });
  it("a forged surface header on an ordinary request is stripped (the marker can only come from middleware)", async () => {
    const req = new NextRequest("https://app.test/login", { headers: { [CUSTOMER_SURFACE_HEADER]: "customer-response" } });
    try { await middleware(req); } catch { /* the session client is mocked to throw: only the header handling matters */ }
    expect(req.headers.get(CUSTOMER_SURFACE_HEADER)).toBeNull();
  });
});

describe("root layout", () => {
  const child = <p>QUOTE PAGE BODY</p>;
  it("customer surface: renders only the page - no shell, sidebar, staff identity, Demo bar or tour - and never looks up the session", async () => {
    hdrs = new Headers({ [CUSTOMER_SURFACE_HEADER]: "customer-response" });
    getInfo.mockRejectedValue(new Error("must not be called"));
    const html = renderToStaticMarkup(await RootLayout({ children: child }));
    expect(getInfo).not.toHaveBeenCalled();
    expect(html).toContain("QUOTE PAGE BODY");
    for (const leak of ["toolbox-shell", "sidebar", "staff@acme.test", "DEMO MODE BAR", "TOUR GUIDE", "Cin7 Core Toolbox", "<nav", "<aside"]) expect(html, leak).not.toContain(leak);
  });
  it("a signed-in staff user and a customer see the same bare page (the header, not the session, decides)", async () => {
    getInfo.mockResolvedValue({ email: "staff@acme.test", orgId: "o1", orgName: "Acme", disabledModules: [], subscriptionStatus: "active", trialEndsAt: null, hasMultipleOrgs: false });
    hdrs = new Headers({ [CUSTOMER_SURFACE_HEADER]: "customer-response" });
    const staff = renderToStaticMarkup(await RootLayout({ children: child }));
    getInfo.mockRejectedValue(new Error("anon")); const anon = renderToStaticMarkup(await RootLayout({ children: child }));
    expect(staff).toBe(anon);
  });
  it("authenticated Toolbox pages are unaffected: the shell, identity and tour still render", async () => {
    getInfo.mockResolvedValue({ email: "staff@acme.test", orgId: "o1", orgName: "Acme", disabledModules: [], subscriptionStatus: "active", trialEndsAt: null, hasMultipleOrgs: false });
    const html = renderToStaticMarkup(await RootLayout({ children: child }));
    expect(html).toContain("toolbox-shell"); expect(html).toContain("staff@acme.test"); expect(html).toContain("TOUR GUIDE"); expect(getInfo).toHaveBeenCalled();
  });
});

describe("customer page source", () => {
  const files = readdirSync(join(SRC, "app", "quote-response")).filter((f) => /\.(tsx?|ts)$/.test(f)).map((f) => [f, readFileSync(join(SRC, "app", "quote-response", f), "utf8")] as const);
  it("imports nothing from the Toolbox shell, session or navigation", () => {
    for (const [f, s] of files) for (const bad of ["AppShell", "AppNav", "DemoModeBar", "getCurrentUserInfo", "OrgSwitcher", "module-nav", "tour-guide", "@/actions/auth"]) expect(s.includes(bad), `${f} must not reference ${bad}`).toBe(false);
  });
  it("is mobile-first: stacked controls that become a row from the sm breakpoint, large touch targets, no fixed desktop widths", () => {
    const page = files.find(([f]) => f === "page.tsx")![1];
    expect(page).toContain("flex-col gap-2 sm:flex-row"); expect(page).toMatch(/h-1[12] /); expect(page).toContain("max-w-2xl"); expect(page).not.toMatch(/\bw-\[\d+px\]|min-w-\[\d{3,}px\]/);
    expect(page).toContain("View quotation PDF"); expect(page).toContain("Response successfully received");
  });
  it("shows no internal wording or identifiers on the page", () => {
    const page = files.find(([f]) => f === "page.tsx")![1];
    for (const bad of ["margin", "supplier", "cost", "approval", "Cin7", "Toolbox", "demo"]) expect(new RegExp(bad, "i").test(page.replace(/className="[^"]*"/g, "")), bad).toBe(false);
  });
});
