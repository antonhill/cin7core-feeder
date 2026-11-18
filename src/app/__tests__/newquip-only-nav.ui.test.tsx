// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { AppShell } from "../AppShell";
import { isWorkspaceLinkActive, newquipOnlyLinks } from "../module-nav";
import { NEWQUIP_POC_ORG_IDS } from "@/newquip/access";

const h = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => h.pathname, useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/actions/auth", () => ({ signOutAction: vi.fn(), signOutNewquipAction: vi.fn() }));
vi.mock("@/actions/org-logo", () => ({ uploadCurrentOrgLogo: vi.fn() }));
vi.mock("@/app/reports/actions", () => ({ triggerSalesSyncAction: vi.fn() }));
vi.mock("@/app/OrgSwitcher", () => ({ OrgSwitcher: () => null }));
vi.mock("@/app/ActiveOrgSwitcher", () => ({ ActiveOrgSwitcher: () => null }));

const NQ = NEWQUIP_POC_ORG_IDS[0];
const OTHER = "00000000-0000-0000-0000-000000000000";
const nav = (over = {}) => ({ userEmail: "pat@newquip.example", isSuperAdmin: false, isOrgAdmin: false, orgId: NQ, orgName: "NewQuip POC", orgLogoUrl: null, disabledModules: [] as string[], showBilling: false, hasMultipleOrgs: false, ...over });
const renderAt = (path: string, over = {}) => { h.pathname = path; return render(<AppShell nav={nav(over)}><div data-testid="page">page</div></AppShell>); };
beforeAll(() => { window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia; });
afterEach(cleanup);

describe("newquipOnlyLinks", () => {
  it("is Dashboard, Quotations, Projects, Claims, Approvals, Settings for a NewQuip non-super-admin", () => {
    expect(newquipOnlyLinks(NQ, [], false).map((l) => l.label)).toEqual(["Dashboard", "Quotations", "Projects", "Claims", "Approvals", "Reports", "Settings"]);
    expect(newquipOnlyLinks(NQ, [], false).map((l) => l.href)).toEqual(["/", "/newquip-grower", "/projects", "/claims", "/approvals", "/newquip-grower/reports", "/newquip-grower/settings"]);
  });
  it("is empty for a super-admin, another organisation, or no organisation", () => {
    expect(newquipOnlyLinks(NQ, [], true)).toEqual([]);
    expect(newquipOnlyLinks(OTHER, [], false)).toEqual([]);
    expect(newquipOnlyLinks(null, [], false)).toEqual([]);
  });
  it("follows the module toggles", () => {
    expect(newquipOnlyLinks(NQ, ["/quotes"], false).map((l) => l.label)).toEqual(["Dashboard", "Projects", "Claims", "Approvals", "Settings"]);
    expect(newquipOnlyLinks(NQ, ["/projects"], false).map((l) => l.label)).toEqual(["Dashboard", "Quotations", "Reports", "Settings"]);
  });
  it("marks one link active: Settings owns /settings/members, Quotations does not own the settings pages, Dashboard is exact", () => {
    const active = (p: string) => newquipOnlyLinks(NQ, [], false).filter((l) => isWorkspaceLinkActive(p, l)).map((l) => l.label);
    expect(active("/")).toEqual(["Dashboard"]);
    expect(active("/newquip-grower/abc")).toEqual(["Quotations"]);
    expect(active("/newquip-grower/company-profile")).toEqual(["Settings"]);
    expect(active("/newquip-grower/settings")).toEqual(["Settings"]);
    expect(active("/settings/members")).toEqual(["Settings"]);
    expect(active("/claims")).toEqual(["Claims"]);
    expect(active("/projects/1")).toEqual(["Projects"]);
  });
});

describe("AppShell for the NewQuip-only interface", () => {
  it.each(["/", "/claims", "/settings/members", "/settings/security", "/newquip-grower", "/projects/9"])("wraps %s in the NewQuip shell with no Toolbox links and no Back to Toolbox", (path) => {
    renderAt(path);
    expect(screen.getByTestId("newquip-workspace")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Main navigation" })).toBeNull();
    expect(screen.queryByRole("link", { name: /Back to Toolbox/ })).toBeNull();
    const links = within(screen.getByRole("navigation", { name: "NewQuip" })).getAllByRole("link").map((a) => a.textContent);
    expect(links).toEqual(["Dashboard", "Quotations", "Projects", "Claims", "Approvals", "Reports", "Settings"]);
    expect(screen.queryByRole("link", { name: /Import|Templates|Migrate|Instances|Activity|Admin/ })).toBeNull();
    // NewQuip's own Reports (/newquip-grower/reports) is expected; the Toolbox Reports module (/reports) must never appear.
    expect(within(screen.getByRole("navigation", { name: "NewQuip" })).queryAllByRole("link").some((a) => a.getAttribute("href") === "/reports")).toBe(false);
  });
  it("keeps the Toolbox shell for a super-admin on '/' and on Toolbox modules", () => {
    for (const p of ["/", "/reports"]) { renderAt(p, { isSuperAdmin: true }); expect(screen.queryByTestId("newquip-workspace")).toBeNull(); expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeTruthy(); cleanup(); }
  });
  it("keeps the Toolbox shell for another organisation", () => {
    renderAt("/", { orgId: OTHER });
    expect(screen.queryByTestId("newquip-workspace")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeTruthy();
  });
  it("renders no chrome on the sign-in routes", () => {
    renderAt("/login");
    expect(screen.queryByTestId("newquip-workspace")).toBeNull();
  });
});
