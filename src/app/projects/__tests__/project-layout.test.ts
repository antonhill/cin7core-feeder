import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// UAT-021: the Project workspace separates Commercial / Claims, Deliveries and Products & Stock; UAT-015: claims are cards with a clear next step.
const ws = readFileSync(new URL("../[id]/ProjectWorkspace.tsx", import.meta.url), "utf8");
const phys = readFileSync(new URL("../[id]/PhysicalPanel.tsx", import.meta.url), "utf8");
const alloc = readFileSync(new URL("../[id]/DeliveryAllocationPanel.tsx", import.meta.url), "utf8");

describe("UAT-021 project operations layout", () => {
  it("has three clearly named areas", () => {
    expect(ws).toMatch(/label: "Commercial \/ Claims"/);
    expect(ws).toMatch(/value: "deliveries", label: "Deliveries"/);
    expect(ws).toMatch(/value: "physical", label: "Products & Stock"/);
  });
  it("Products & Stock no longer embeds delivery allocation; Deliveries shows only the plan; Commercial shows only milestone evidence", () => {
    expect(phys).not.toMatch(/DeliveryAllocationPanel/);
    expect(ws).toMatch(/<DeliveryAllocationPanel view=\{view\} section="deliveries" \/>/);
    expect(ws).toMatch(/<DeliveryAllocationPanel view=\{view\} section="milestones" \/>/);
    expect(alloc).toMatch(/section !== "milestones" && <Panel>/);
    expect(alloc).toMatch(/section !== "deliveries" && <Panel>/);
  });
  it("states that a delivery plan moves no stock and that milestones are independent of physical delivery", () => {
    expect(ws).toMatch(/does not move stock in Cin7/);
    expect(ws).toMatch(/independent of physical delivery/);
    expect(ws).toMatch(/never needs goods to have moved/);
  });
  it("the Deliveries tab is NewQuip-only like the other physical tabs and hidden in the embedded view", () => {
    expect(ws).toMatch(/NEWQUIP_ONLY_TABS: Tab\[\] = \["variations", "deliveries"/);
    expect(ws).toMatch(/t\.value === "deliveries" \|\| t\.value === "physical"/);
  });
});

describe("UAT-015 claim history cards", () => {
  it("each claim shows reference, approval state, amount, Cin7 status, next step and the existing action plan; approval history stays available", () => {
    expect(ws).toMatch(/<article key=\{cl\.id\}/);
    expect(ws).toMatch(/claimNextStep\(/);
    expect(ws).toMatch(/claimActionPlan\(cl,/);
    expect(ws).toMatch(/cl\.cin7Status\.label/);
    expect(ws).toMatch(/<ApprovalHistory docType="CLAIM"/);
  });
  it("is responsive (cards in a grid) rather than a wide table", () => {
    expect(ws).toMatch(/grid gap-3 lg:grid-cols-2/);
  });
  it("milestone confirmation is hidden in the embedded variation workspace and loads itself with feedback (review F1/F2)", () => {
    expect(ws).toMatch(/\{newquip && !embedded && \(\s*<div>\s*<Alert tone="info">Milestone confirmation/);
    expect(alloc).toMatch(/if \(section === "milestones"\) void Promise\.resolve\(\)\.then\(load\)/);
    expect(alloc).toMatch(/section === "milestones" && msg/);
  });
});
