// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { NewquipDashboard } from "../NewquipDashboard";
import type { NewquipDashboardData } from "../newquip-dashboard-data";
import { ClaimsTable } from "../claims/ClaimsTable";
import { SettingsList } from "../newquip-grower/settings/SettingsList";
import { settingsEntries } from "@/newquip/settings-entries";
import type { ClaimListRow } from "@/newquip/claims-list";

afterEach(cleanup);
const data = (over: Partial<NewquipDashboardData> = {}): NewquipDashboardData => ({
  roles: ["rep", "estimator"], quotes: { repDraft: 3, estimatorReview: 2, managerDecision: 1, approved: 4, total: 10 },
  queue: [{ label: "Quotations you are preparing", count: 3, href: "/newquip-grower" }], approvalsPending: 5, approvalsEnabled: true, activeProjects: 7, claims: { draft: 2, open: 1, approved: 6 }, ...over,
});

describe("NewquipDashboard", () => {
  it("shows stage counts, approvals, projects, claims and quick links", () => {
    render(<NewquipDashboard data={data()} orgName="NewQuip POC" />);
    const stat = (label: string) => screen.getByText(label).closest("a")!.textContent;
    expect(stat("Rep draft")).toContain("3");
    expect(stat("Estimator review")).toContain("2");
    expect(stat("Manager decision")).toContain("1");
    expect(stat("Approved")).toContain("4");
    expect(stat("Approvals waiting")).toContain("5");
    expect(stat("Active projects")).toContain("7");
    expect(stat("Draft claims")).toContain("2");
    expect(stat("Open claims")).toContain("1");
    expect(stat("Approved claims")).toContain("6");
    const quick = within(screen.getByRole("navigation", { name: "Quick links" }));
    expect(quick.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/newquip-grower", "/projects", "/claims", "/approvals", "/newquip-grower/settings"]);
  });
  it("never shows cost, margin or supplier content, for a Rep or anyone", () => {
    for (const roles of [["rep"], ["rep", "estimator"], ["rep", "estimator", "manager"]] as const) {
      const { container, unmount } = render(<NewquipDashboard data={data({ roles: [...roles] })} orgName="NewQuip POC" />);
      expect(container.textContent ?? "").not.toMatch(/cost|margin|supplier|profit|R\s?\d/i);
      unmount();
    }
  });
  it("shows Unavailable for a section that could not load, and hides Approvals when the kill switch is on", () => {
    render(<NewquipDashboard data={data({ quotes: null, queue: [], claims: null, activeProjects: null, approvalsEnabled: false, approvalsPending: null })} orgName={null} />);
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(7);
    expect(screen.queryByText("Approvals waiting")).toBeNull();
    expect(screen.queryByRole("link", { name: "Approvals" })).toBeNull();
    expect(screen.queryByText("Needs your action")).toBeNull();
  });
  it("shows a notice when given one", () => {
    render(<NewquipDashboard data={data()} orgName={null} notice="Only your organization’s owner or admin can manage team access." />);
    expect(screen.getByText(/owner or admin/)).toBeTruthy();
  });
});

describe("ClaimsTable", () => {
  const row = (over: Partial<ClaimListRow> = {}): ClaimListRow => ({ claimId: "c1", projectId: "p1", projectReference: "PRJ-1", projectName: "Tunnel", customerName: "Acme Farms", claimNumber: "PRJ-1-C2", claimSeq: 2, claimDate: "2026-11-01", status: "READY_FOR_APPROVAL", bucket: "open", totalCents: 123456, href: "/projects/p1?tab=claims", ...over });
  it("lists project, customer, claim, status and amount, linking to the project's claims tab", () => {
    render(<ClaimsTable rows={[row()]} />);
    expect(screen.getByText("PRJ-1").getAttribute("href")).toBe("/projects/p1");
    expect(screen.getByText("Acme Farms")).toBeTruthy();
    expect(screen.getByText("PRJ-1-C2")).toBeTruthy();
    expect(screen.getByText("Ready for approval")).toBeTruthy();
    expect(screen.getByText(/1.234,56/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open claims tab" }).getAttribute("href")).toBe("/projects/p1?tab=claims");
  });
  it("shows an empty state", () => {
    render(<ClaimsTable rows={[]} />);
    expect(screen.getByText("No claims yet")).toBeTruthy();
  });
});

describe("SettingsList", () => {
  it("renders a link per visible entry", () => {
    render(<SettingsList entries={settingsEntries({ isOrgAdmin: true, canSeeCost: false, demo: false })} />);
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/newquip-grower/company-profile", "/newquip-grower/project-templates", "/newquip-grower/team", "/settings/members", "/settings/security", "/settings/notifications"]);
  });
});
