// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { approvalBlockers, nextCostVerifyAction, type ApprovalBlockerInput, type Phase2CostStatus } from "@/newquip/pricing/estimator";
import { CostVerifyBanner } from "../[id]/CostVerifyBanner";

// The Next-action banner and the Approve button read ONE list of blockers: the banner can never say "ready" while Approve is blocked, and always names what is outstanding. Rendered through the real
// banner component with the real pure functions; the page wiring is asserted from the source (the page's own render needs a fully priced fixture).
afterEach(cleanup);
const complete: Phase2CostStatus = { required: 3, verified: 3, missingCost: [], needsVerification: [], other: [], outstanding: [], complete: true };
const clean: ApprovalBlockerInput = { signoff: "current", dirty: false, notReadyReasons: null, costingOpen: false, baselineExceptionRequired: false };
const render_ = (i: ApprovalBlockerInput, role: "manager" | "estimator") => render(createElement(CostVerifyBanner, { action: nextCostVerifyAction({ status: complete, state: "ESTIMATOR_REVIEW", roles: { rep: false, estimator: role === "estimator", manager: role === "manager" }, dirty: false, signoff: i.signoff, costAcknowledged: true, costNeedsMark: false, amountChanged: false, serverIncomplete: false, approvalBlockers: approvalBlockers(i) }) }));
const headline = () => screen.getByTestId("cost-next-action-headline").textContent;

describe("the rendered Next-action banner", () => {
  it("Manager, baseline exception required: 'Baseline exception required before approval', the items named, NOT ready", () => {
    render_({ ...clean, baselineExceptionRequired: true, baselineExceptionItems: ["M75 feed distribution system", "PP penning"] }, "manager");
    expect(screen.getByTestId("cost-next-action").getAttribute("data-next-action")).toBe("approval-blocked");
    expect(headline()).toBe("Baseline exception required before approval");
    expect(screen.getByTestId("cost-next-action-detail").textContent).toMatch(/M75 feed distribution system, PP penning/);
    expect(screen.getByTestId("cost-outstanding").textContent).toMatch(/baseline exception is required/);
    expect(document.body.textContent).not.toMatch(/Ready for/);
  });
  it("Estimator on the same quotation: phrased for the Manager, never 'Ready for Manager approval'", () => {
    render_({ ...clean, baselineExceptionRequired: true, baselineExceptionItems: ["PP penning"] }, "estimator");
    expect(headline()).toBe("Baseline exception required before Manager approval");
    expect(document.body.textContent).not.toMatch(/Ready for/);
  });
  it("sign-off blocked (stale / missing): never ready", () => {
    for (const signoff of ["stale", "none"] as const) { cleanup(); render_({ ...clean, signoff }, "manager"); expect(headline()).not.toMatch(/Ready for/); }
  });
  it("legacy / nothing blocking: unchanged 'Ready for your approval' / 'Ready for Manager approval'", () => {
    render_(clean, "manager"); expect(headline()).toBe("Ready for your approval"); cleanup();
    render_(clean, "estimator"); expect(headline()).toBe("Ready for Manager approval");
  });
});

describe("the page derives the Approve button and the banner from the SAME blockers", () => {
  const src = readFileSync(path.join(process.cwd(), "src/app/newquip-grower/[id]/page.tsx"), "utf8");
  it("Approve is disabled from approveBlockers, and the banner is given the same list", () => {
    expect(src).toMatch(/const approveBlockers = approvalBlockers\(/);
    expect(src).toMatch(/disabled=\{isWorking \|\| !roles\.has\("manager"\) \|\| approveBlockers\.length > 0\}/);
    expect(src).toMatch(/approvalBlockers: approveBlockers,/);
    expect(src).not.toMatch(/dirty \|\| approveNotReady \|\| bxRequired \|\| bxBlocking\.length > 0\}/); // the old inline condition is gone
  });
});
