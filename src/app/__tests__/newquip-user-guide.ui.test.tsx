// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppShell } from "../AppShell";
import { NEWQUIP_POC_ORG_IDS } from "@/newquip/access";
import { newquipOnlyLinks, isWorkspaceLinkActive } from "../module-nav";
import { GuideNav } from "../newquip-grower/guide/GuideNav";
import { GuideBlocks } from "../newquip-grower/guide/GuideBlocks";
import { GUIDE_LESSONS } from "@/newquip/guide/content";
import { buildSearchIndex } from "@/newquip/guide/search";
import { SECTION_LABEL, SECTION_ORDER } from "@/newquip/guide/types";

const h = vi.hoisted(() => ({ pathname: "/newquip-grower/guide" }));
vi.mock("next/navigation", () => ({ usePathname: () => h.pathname, useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/actions/auth", () => ({ signOutAction: vi.fn(), signOutNewquipAction: vi.fn() }));
vi.mock("@/actions/org-logo", () => ({ uploadCurrentOrgLogo: vi.fn() }));
vi.mock("@/app/reports/actions", () => ({ triggerSalesSyncAction: vi.fn() }));
vi.mock("@/app/OrgSwitcher", () => ({ OrgSwitcher: () => null }));
vi.mock("@/app/ActiveOrgSwitcher", () => ({ ActiveOrgSwitcher: () => null }));

const NQ = NEWQUIP_POC_ORG_IDS[0];
const nav = (over = {}) => ({ userEmail: "pat@newquip.example", isSuperAdmin: false, isOrgAdmin: false, orgId: NQ, orgName: "NewQuip POC", orgLogoUrl: null, disabledModules: [] as string[], showBilling: false, hasMultipleOrgs: false, ...over });
beforeAll(() => { window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia; });
afterEach(cleanup);

describe("User Guide navigation", () => {
  it("shows a User Guide link on NewQuip screens for NewQuip-only users and for Spark super-admins", () => {
    for (const path of ["/", "/newquip-grower", "/projects", "/claims", "/approvals", "/newquip-grower/settings"]) {
      for (const isSuperAdmin of [false, true]) {
        h.pathname = path; cleanup();
        render(<AppShell nav={nav({ isSuperAdmin })}><div>page</div></AppShell>);
        const link = screen.queryAllByRole("link", { name: "User Guide" });
        if (isSuperAdmin && (path === "/" || path === "/claims")) continue; // super-admins keep the Toolbox shell outside the NewQuip workspace routes
        expect(link.length, `${path} super=${isSuperAdmin}`).toBe(1);
        expect(link[0].getAttribute("href")).toBe("/newquip-grower/guide");
      }
    }
  });
  it("marks the guide link current, and not Quotations, while reading the guide", () => {
    h.pathname = "/newquip-grower/guide/start-here";
    render(<AppShell nav={nav()}><div>page</div></AppShell>);
    expect(screen.getByRole("link", { name: "User Guide" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Quotations" }).getAttribute("aria-current")).toBeNull();
    const q = newquipOnlyLinks(NQ, [], false).find((l) => l.label === "Quotations")!;
    expect(isWorkspaceLinkActive("/newquip-grower/guide", q)).toBe(false);
    expect(isWorkspaceLinkActive("/newquip-grower/abc", q)).toBe(true);
  });
});

describe("User Guide sidebar and search", () => {
  const index = buildSearchIndex(GUIDE_LESSONS, (s) => SECTION_LABEL[s]);
  const lessons = GUIDE_LESSONS.map((l) => ({ slug: l.slug, title: l.title, section: SECTION_LABEL[l.section], sectionKey: l.section }));
  const sections = SECTION_ORDER.map((k) => ({ key: k, label: SECTION_LABEL[k] }));
  it("lists lessons by section, marks the current one and searches live", () => {
    render(<GuideNav lessons={lessons} index={index} current="start-here" sections={sections} />);
    expect(screen.getByRole("link", { name: "Start here: how NewQuip works" }).getAttribute("aria-current")).toBe("page");
    fireEvent.change(screen.getByLabelText("Search the guide"), { target: { value: "forward cover" } });
    expect(screen.getAllByRole("link").some((a) => a.getAttribute("href")?.includes("estimator-fx"))).toBe(true);
    fireEvent.change(screen.getByLabelText("Search the guide"), { target: { value: "qqqzzz" } });
    expect(screen.getByText(/No lessons match/)).toBeTruthy();
  });
});

describe("User Guide blocks", () => {
  it("renders a real screenshot as an enlargeable, captioned figure", () => {
    render(<GuideBlocks blocks={[{ t: "shot", id: "dashboard" }]} />);
    expect(screen.getByRole("button", { name: /Enlarge screenshot/ })).toBeTruthy();
    expect(screen.getAllByRole("img").length).toBeGreaterThan(0);
    expect(screen.getByText(/select the image to enlarge/)).toBeTruthy();
  });
  it("renders the journey as links to lessons", () => {
    render(<GuideBlocks blocks={[{ t: "diagram", id: "journey" }]} />);
    expect(screen.getByRole("list", { name: /journey/i }).querySelectorAll("a").length).toBe(14);
  });
});
