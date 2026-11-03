// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectOverview } from "../ProjectOverview";
import { JourneyMap } from "../JourneyMap";
import { getProjectOverviewDataAction } from "../../overview-actions";
import { getPhysicalStatusAction } from "../../physical-actions";
import { buildJourney, buildProjectOverview } from "@/lib/projects/overview-model";
import { R, approvedVariation, claim, demoInput, posting, project, scope, stage } from "@/lib/projects/__tests__/overview-fixtures";

vi.mock("../../overview-actions", () => ({ getProjectOverviewDataAction: vi.fn() }));
vi.mock("../../physical-actions", () => ({ getPhysicalStatusAction: vi.fn() }));

const overviewAction = vi.mocked(getProjectOverviewDataAction);
const physicalAction = vi.mocked(getPhysicalStatusAction);
const dataOf = (i = demoInput()) => ({ ok: true as const, data: { scopes: i.scopes, unbilledApprovedVariations: i.unbilledApprovedVariations, deliveries: i.deliveries, estimates: i.estimates, viewer: i.viewer } });

beforeEach(() => { vi.clearAllMocks(); overviewAction.mockResolvedValue(dataOf() as never); });
afterEach(() => cleanup());

const journeyFor = (i = demoInput()) => buildJourney({ scopes: i.scopes, physical: buildProjectOverview(i).physical });

describe("JourneyMap - in the Overview", () => {
  it("renders at the top of the Overview, above 'Needs attention', with setup and three lanes", async () => {
    render(<ProjectOverview projectId="p-base" refreshKey="k" onOpenTab={vi.fn()} />);
    const ov = await screen.findByTestId("overview");
    const journey = within(ov).getByTestId("journey");
    expect(ov.firstElementChild).toBe(journey);
    expect(within(journey).getByRole("heading", { name: "Project journey" })).toBeTruthy();
    for (const t of ["Commercial", "Physical", "Variations"]) expect(within(journey).getByRole("heading", { name: t })).toBeTruthy();
    expect(within(journey).getByTestId("journey-setup")).toBeTruthy();
    expect(journey.compareDocumentPosition(screen.getByRole("heading", { name: "Needs attention" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("adds NO request: one overview read on mount, no Cin7 read, and a click on a journey link makes none either", async () => {
    const open = vi.fn();
    render(<ProjectOverview projectId="p-base" refreshKey="k" onOpenTab={open} />);
    await screen.findByTestId("journey");
    expect(overviewAction).toHaveBeenCalledTimes(1);
    expect(physicalAction).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByTestId("journey-physical-fulfilment")).getByRole("button", { name: "Open Products & Stock" }));
    expect(open).toHaveBeenCalledWith("physical");
    expect(overviewAction).toHaveBeenCalledTimes(1);
    expect(physicalAction).not.toHaveBeenCalled();
  });

  it("shows unloaded physical state as 'Not read yet', then the read result once the user asks (and only then)", async () => {
    physicalAction.mockResolvedValue({ ok: true, data: { sections: [{ label: "Original contract", scope: "BASE", linked: true, saleNumber: "SO-27", scopeBlockers: [], exceptions: [], asOf: "2026-11-01T16:00:00Z", rows: [] }] } } as never);
    render(<ProjectOverview projectId="p-base" refreshKey="k" onOpenTab={vi.fn()} />);
    const f = await screen.findByTestId("journey-physical-fulfilment");
    expect(f.textContent).toContain("Not read yet");
    expect(f.getAttribute("data-status")).toBe("unknown");
    fireEvent.click(screen.getByRole("button", { name: "Read fulfilment from Cin7" }));
    await waitFor(() => expect(screen.getByTestId("journey-physical-fulfilment").getAttribute("data-status")).toBe("not_started"));
    expect(screen.getByTestId("journey-physical-fulfilment").textContent).toContain("No physical products in scope");
  });

  it("a failed overview read shows the existing error and no journey", async () => {
    overviewAction.mockResolvedValue({ ok: false, error: "nope" } as never);
    render(<ProjectOverview projectId="p-base" refreshKey="k" onOpenTab={vi.fn()} />);
    await screen.findByTestId("overview-error");
    expect(screen.queryByTestId("journey")).toBeNull();
  });
});

describe("JourneyMap - presentation and accessibility", () => {
  const onOpen = vi.fn();
  const renderJourney = (i = demoInput()) => render(<JourneyMap journey={journeyFor(i)} onOpenTab={onOpen} />);

  it("has a 5-state key whose entries are text, and every station states its status in words", () => {
    renderJourney();
    const key = screen.getByTestId("journey-key");
    for (const t of ["Not started", "In progress", "Completed", "Needs attention", "Blocked"]) expect(within(key).getByText(t)).toBeTruthy();
    expect(key.querySelectorAll("[data-tone]").length).toBe(5);
    for (const li of document.querySelectorAll("[data-testid^='journey-'][data-status]")) {
      expect(li.querySelector("[data-tone]")?.textContent?.replace(/^\W+/, "").length).toBeGreaterThan(3);
    }
  });

  it("every link names its target and is a 44px-high button that calls onOpenTab", () => {
    renderJourney();
    const links = within(screen.getByTestId("journey")).getAllByRole("button").filter((b) => !b.hasAttribute("aria-expanded"));
    expect(links.length).toBeGreaterThan(5);
    for (const b of links) {
      expect(b.textContent).toMatch(/^(Open|Start) /);
      expect(b.className).toContain("min-h-11");
    }
    fireEvent.click(within(screen.getByTestId("journey-commercial-claims")).getByRole("button", { name: "Open Claims" }));
    expect(onOpen).toHaveBeenCalledWith("claims");
  });

  it("each lane has a disclosure button: aria-expanded false by default, toggles, controls its body, hidden on mobile via class only", () => {
    renderJourney();
    for (const id of ["commercial", "physical", "variations"]) {
      const lane = screen.getByTestId(`journey-lane-${id}`);
      const btn = within(lane).getByRole("button", { name: new RegExp(`Show ${id}`, "i") });
      expect(btn.getAttribute("aria-expanded")).toBe("false");
      const body = screen.getByTestId(`journey-body-${id}`);
      expect(btn.getAttribute("aria-controls")).toBe(body.id);
      expect(body.className).toContain("max-[700px]:hidden");
      fireEvent.click(btn);
      expect(btn.getAttribute("aria-expanded")).toBe("true");
      expect(btn.textContent).toMatch(/^Hide /);
      expect(body.className).not.toContain("max-[700px]:hidden");
      fireEvent.keyDown(btn, { key: "Enter" });
    }
    // the button is mobile-only so it never appears on a wide screen
    expect(within(screen.getByTestId("journey-lane-commercial")).getByRole("button", { name: /Hide Commercial/ }).className).toContain("min-[701px]:hidden");
  });

  it("the lane summary line carries the counts (attention, in progress, not read yet) even when collapsed", () => {
    const i = demoInput();
    const bp = project({ id: "b2", project_reference: "P", original_contract_cents: R(1000) });
    i.scopes = [scope({ project: bp, stages: [stage("s1", 1, "All", R(1000))], claims: [claim("c1", 1, "FAILED_UNCERTAIN", R(100))], postings: [posting("c1", "FAILED_UNCERTAIN", null, null, false)], variations: [approvedVariation(R(10))] })];
    renderJourney(i);
    expect(screen.getByTestId("journey-summary-commercial").textContent).toMatch(/\d+ needs? attention/);
    expect(screen.getByTestId("journey-summary-physical").textContent).toContain("3 not read yet");
    expect(screen.getByTestId("journey-summary-variations").textContent).toMatch(/needs? attention/);
  });

  it("a variation with no billing project shows as needs attention with 'Start V001 billing'", () => {
    const i = demoInput();
    i.scopes = i.scopes.filter((s) => s.scope === "BASE");
    renderJourney(i);
    const v = screen.getByTestId("journey-variation-V001");
    expect(v.getAttribute("data-status")).toBe("needs_attention");
    fireEvent.click(within(v).getByRole("button", { name: "Start V001 billing" }));
    expect(onOpen).toHaveBeenCalledWith("variations");
  });

  it("states there is no completion state in one footnote line", () => {
    renderJourney();
    expect(screen.getByTestId("journey-footnote").textContent).toMatch(/no project completion or closure state/);
  });
});

describe("JourneyMap - boundary", () => {
  it("neither the model additions nor the presentation import a server action or a store", () => {
    for (const f of [join(__dirname, "../JourneyMap.tsx"), join(__dirname, "../../../../lib/projects/overview-model.ts")]) {
      const imports = readFileSync(f, "utf8").split("\n").filter((l) => /^\s*import\b/.test(l)).join("\n");
      expect(imports, f).not.toMatch(/actions|-store|supabase|authorization|next\/(navigation|cache|headers)/);
    }
  });
});
