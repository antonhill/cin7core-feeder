// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { AppShell } from "../AppShell";
import { isNewquipWorkspacePath, newquipWorkspaceLinks } from "../module-nav";
import { pageContainerClass } from "../PageContainer";
import { NEWQUIP_POC_ORG_IDS } from "@/newquip/access";

const h = vi.hoisted(() => ({ pathname: "/projects" }));
vi.mock("next/navigation", () => ({ usePathname: () => h.pathname, useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/actions/auth", () => ({ signOutAction: vi.fn() }));
vi.mock("@/actions/org-logo", () => ({ uploadCurrentOrgLogo: vi.fn() }));
vi.mock("@/app/reports/actions", () => ({ triggerSalesSyncAction: vi.fn() }));
vi.mock("@/app/OrgSwitcher", () => ({ OrgSwitcher: () => null }));
vi.mock("@/app/ActiveOrgSwitcher", () => ({ ActiveOrgSwitcher: () => null }));

// UX-003: NewQuip routes get their own workspace chrome; everything else keeps the Toolbox shell. Presentation only: authorisation lives in the route layouts.
const NQ = NEWQUIP_POC_ORG_IDS[0];
const nav = (over: Partial<Parameters<typeof AppShell>[0]["nav"]> = {}) => ({
  userEmail: "pat@newquip.example", isSuperAdmin: false, isOrgAdmin: false, orgId: NQ, orgName: "NewQuip POC", orgLogoUrl: null, disabledModules: [] as string[], showBilling: false, hasMultipleOrgs: false, ...over,
});
const renderAt = (path: string, over = {}) => { h.pathname = path; return render(<AppShell nav={nav(over)}><div data-testid="page">page</div></AppShell>); };
beforeAll(() => {
  window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe("isNewquipWorkspacePath", () => {
  it("matches Solution Builder, Projects and Approvals and everything nested under them", () => {
    for (const p of ["/newquip-grower", "/newquip-grower/abc/def", "/newquip-grower/company-profile", "/projects", "/projects/123", "/approvals", "/approvals/roles", "/approvals/xyz"]) expect(isNewquipWorkspacePath(p), p).toBe(true);
  });
  it("does not match other Toolbox routes or look-alike prefixes", () => {
    for (const p of ["/", "/reports", "/quotes", "/settings/members", "/projects-x", "/approvalsx", "/newquip-growerx", "/login"]) expect(isNewquipWorkspacePath(p), p).toBe(false);
  });
});

describe("newquipWorkspaceLinks", () => {
  it("lists Solution Builder, Projects and Approvals for the NewQuip organisation, in that order", () => {
    expect(newquipWorkspaceLinks(NQ, [], false).map((l) => l.label)).toEqual(["Solution Builder", "Projects", "Approvals"]);
  });
  it("is empty for any other organisation or no organisation", () => {
    expect(newquipWorkspaceLinks("00000000-0000-0000-0000-000000000000", [], false)).toEqual([]);
    expect(newquipWorkspaceLinks(null, [], false)).toEqual([]);
  });
  it("follows the same module toggles as the Toolbox sidebar", () => {
    expect(newquipWorkspaceLinks(NQ, ["/quotes"], false).map((l) => l.label)).toEqual(["Projects", "Approvals"]);
    expect(newquipWorkspaceLinks(NQ, ["/projects"], false).map((l) => l.label)).toEqual(["Solution Builder"]);
  });
});

describe("AppShell on NewQuip routes", () => {
  it("replaces the Toolbox sidebar and mobile bar with the workspace header", () => {
    renderAt("/projects/42");
    expect(screen.getByTestId("newquip-workspace")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open navigation" })).toBeNull();
    expect(screen.getByTestId("page")).toBeTruthy();
  });
  it("shows a persistent Back to Toolbox link to the Toolbox home", () => {
    renderAt("/approvals");
    expect(screen.getByRole("link", { name: /Back to Toolbox/ }).getAttribute("href")).toBe("/");
  });
  it("keeps organisation and user context visible and offers sign out", () => {
    renderAt("/projects");
    expect(screen.getByText("NewQuip POC")).toBeTruthy();
    expect(screen.getByText("pat@newquip.example")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });
  it("links the three NewQuip areas at their existing URLs and marks only the current one", () => {
    renderAt("/projects/42");
    const nq = within(screen.getByRole("navigation", { name: "NewQuip" }));
    expect(nq.getByRole("link", { name: "Solution Builder" }).getAttribute("href")).toBe("/newquip-grower");
    expect(nq.getByRole("link", { name: "Projects" }).getAttribute("href")).toBe("/projects");
    expect(nq.getByRole("link", { name: "Approvals" }).getAttribute("href")).toBe("/approvals");
    expect(nq.getByRole("link", { name: "Projects" }).getAttribute("aria-current")).toBe("page");
    expect(nq.getByRole("link", { name: "Approvals" }).getAttribute("aria-current")).toBeNull();
  });
  it("offers a skip link to the content", () => {
    renderAt("/projects");
    expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe("#newquip-content");
    expect(document.getElementById("newquip-content")?.contains(screen.getByTestId("page"))).toBe(true);
  });
});

describe("AppShell keeps the Toolbox shell everywhere else", () => {
  it("on a Toolbox route for the NewQuip organisation", () => {
    renderAt("/reports");
    expect(screen.queryByTestId("newquip-workspace")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeTruthy();
  });
  it("on NewQuip routes for any other organisation (the route layout redirects them; no workspace chrome and no NewQuip links)", () => {
    renderAt("/projects", { orgId: "00000000-0000-0000-0000-000000000000" });
    expect(screen.queryByTestId("newquip-workspace")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "NewQuip" })).toBeNull();
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeTruthy();
  });
  it("on the login route (no chrome at all)", () => {
    renderAt("/login");
    expect(screen.queryByTestId("newquip-workspace")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).toBeNull();
  });
});

describe("AppShell workspace edge cases", () => {
  it("shows exactly the three NewQuip links to a super-admin (no Admin link) and keeps them for impersonation", () => {
    renderAt("/projects", { isSuperAdmin: true });
    expect(within(screen.getByRole("navigation", { name: "NewQuip" })).getAllByRole("link").map((a) => a.textContent)).toEqual(["Solution Builder", "Projects", "Approvals"]);
  });
  it("keeps the Toolbox shell when every NewQuip module is hidden, and when there is no organisation", () => {
    renderAt("/projects", { disabledModules: ["/quotes", "/projects"] });
    expect(screen.queryByTestId("newquip-workspace")).toBeNull();
    cleanup();
    renderAt("/projects", { orgId: null });
    expect(screen.queryByTestId("newquip-workspace")).toBeNull();
  });
  it("does not remount the shell or the page when moving between NewQuip areas", () => {
    h.pathname = "/projects";
    const ui = () => <AppShell nav={nav()}><div data-testid="page">page</div></AppShell>;
    const { rerender } = render(ui());
    const shell = screen.getByTestId("newquip-workspace");
    const page = screen.getByTestId("page");
    h.pathname = "/approvals";
    rerender(ui());
    expect(screen.getByTestId("newquip-workspace")).toBe(shell);
    expect(screen.getByTestId("page")).toBe(page);
    expect(screen.getByRole("link", { name: "Approvals" }).getAttribute("aria-current")).toBe("page");
  });
  it("sign out is a form submit, and the content target is focusable for the skip link", () => {
    renderAt("/projects");
    expect(screen.getByRole("button", { name: "Sign out" }).getAttribute("type")).toBe("submit");
    expect(document.getElementById("newquip-content")?.getAttribute("tabindex")).toBe("-1");
  });
});

describe("pageContainerClass", () => {
  it("gives operational data pages up to 1920px and keeps forms at a reading width", () => {
    expect(pageContainerClass("data")).toContain("max-w-[1920px]");
    expect(pageContainerClass("wide")).toContain("max-w-[1480px]");
    expect(pageContainerClass("form")).toContain("max-w-[1200px]");
  });
  it("has a compact vertical density", () => {
    expect(pageContainerClass("data", "compact")).toContain("py-6");
    expect(pageContainerClass("data")).toContain("py-8");
  });
});
