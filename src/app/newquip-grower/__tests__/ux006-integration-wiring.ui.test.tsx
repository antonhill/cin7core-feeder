// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { EstimatorReturnNotice, returnNoticeText } from "../[id]/ReturnNotice";
import type { ReturnInfo } from "@/newquip/quote/return-info";

afterEach(cleanup);
const fmt = (c: number) => `R ${(c / 100).toFixed(0)}`;
const info = (o: Partial<ReturnInfo> = {}): ReturnInfo => ({ kind: "RETURN", reason: "Gate width is wrong", byEmail: "est@nq", byRole: "estimator", at: "2026-11-03T08:00:00.000Z", destination: "REP", source: "RECORD", ...o });

describe("D5 UI: the return notice", () => {
  it("AMOUNT_CHANGED says the total changed from R x to R y and asks to reconfirm", () => {
    const t = returnNoticeText(info({ kind: "AMOUNT_CHANGED", previousCents: 1_000_000, newCents: 1_100_000, reason: "x" }), fmt);
    expect(t.detail).toBe("The total changed from R 10000 to R 11000; the customer’s confirmation was withdrawn: reconfirm the new amount with the customer and submit again.");
  });
  it("CONTACT_CHANGED / CUSTOMER_CHANGED show the neutral server reason with no actor", () => {
    expect(returnNoticeText(info({ kind: "CONTACT_CHANGED", reason: "The confirmed customer contact changed, so the customer's price confirmation was withdrawn." }), fmt).detail).toMatch(/confirmed customer contact changed/);
    expect(returnNoticeText(info({ kind: "CUSTOMER_CHANGED", reason: "The customer on the quotation changed" }), fmt).detail).toMatch(/customer on the quotation changed/);
  });
  it("a RETURN to the Rep shows who, when and the reason", () => {
    expect(returnNoticeText(info(), fmt).detail).toMatch(/Returned by est@nq \(estimator\) on .*Gate width is wrong/);
  });
  it("Estimator/Manager see a Manager return to the Estimator with the reason; nothing for a return to the Rep or none", () => {
    const { rerender } = render(<EstimatorReturnNotice info={info({ destination: "ESTIMATOR", byRole: "manager", byEmail: "mgr@nq", reason: "Re-check the supplier price" })} fmt={fmt} />);
    expect(screen.getByTestId("estimator-return-reason").textContent).toMatch(/mgr@nq \(manager\).*Re-check the supplier price/);
    // compact form: a <details> with ONE summary line (headline + truncated reason); who/when/reason stay in the DOM and the full text shows once opened
    const box = screen.getByTestId("estimator-return-notice");
    expect(box.tagName).toBe("DETAILS");
    expect((box as HTMLDetailsElement).open).toBe(false);
    expect(box.querySelector("summary")!.textContent).toMatch(/Returned to the Estimator.*mgr@nq \(manager\) on .*Re-check the supplier price.*Details/);
    expect(box.querySelector("summary")!.className).toMatch(/min-h-11/);
    expect(box.textContent).toMatch(/Review it again and sign off, or return it to the Rep\./); // the action line is in the opened body
    (box as HTMLDetailsElement).open = true;
    expect((box as HTMLDetailsElement).open).toBe(true);
    expect(screen.getByTestId("estimator-return-reason").textContent).toMatch(/Returned by mgr@nq \(manager\) on .*Re-check the supplier price/);
    rerender(<EstimatorReturnNotice info={info()} fmt={fmt} />);
    expect(screen.queryByTestId("estimator-return-notice")).toBeNull();
    rerender(<EstimatorReturnNotice info={null} fmt={fmt} />);
    expect(screen.queryByTestId("estimator-return-notice")).toBeNull();
  });
  it("the Rep's neutral Estimator-destination info (no actor) is just 'With the Estimator for review.' and exposes no reason text", () => {
    const t = returnNoticeText(info({ destination: "ESTIMATOR", byEmail: null, byRole: null, reason: "With the Estimator for review." }), fmt);
    expect(t).toEqual({ headline: "With the Estimator for review.", detail: "", action: null });
  });
});

// The page itself is a very large client component; these guard that the wiring that only exists once S3 + D5 + the new Stage 2/3/6 structure are merged is actually mounted.
describe("UX-006 integration: mounts in the new Stage 2/3/6 structure", () => {
  const page = readFileSync("src/app/newquip-grower/[id]/page.tsx", "utf8");
  it("S3: Manager block (Stage 3), Estimator note (Stage 2 Final review), frozen summary (Stage 6)", () => {
    expect(page).toMatch(/<BaselineExceptionBlock view=\{view\.baselineException\}/);
    expect(page).toMatch(/<BaselineExceptionNote view=\{view\.baselineException\}/);
    expect(page).toMatch(/<BaselineExceptionsSummary exceptions=\{q\.accepted_baseline\.exceptions\}/);
    expect(page).toMatch(/baselineException: view\.baselineException \?\? null/); // feeds deriveApprovalChecklist
    expect(page).toMatch(/approveNotReady \|\| bxRequired/); // plain Approve disabled while an exception is required
    expect(page).toMatch(/approveGrowerQuoteAction\(id, \{ baselineException: request \}\)/);
  });
  it("D5: the Rep banner reads the server returnInfo; Estimator/Manager get their own notice; Rep gets only the neutral line", () => {
    expect(page).toMatch(/view\?\.returnInfo && view\.returnInfo\.destination === "REP"/);
    expect(page).toMatch(/<EstimatorReturnNotice info=\{view\.returnInfo\}/);
    expect(page).toMatch(/data-testid="rep-with-estimator"/);
  });
});
