import { describe, expect, it } from "vitest";
import { previewKey, previewState } from "../preview-staleness";

const view = (bps: number, status = "DRAFT") => ({
  stages: [{ id: "s1", approvedBps: bps, committedCents: 0, valueCents: 1000 }],
  claims: [{ id: "c1", status, total_cents: 115 }],
}) as never;

describe("UAT-014 preview staleness", () => {
  it("no preview shown -> NONE; same inputs -> CURRENT", () => {
    const k = previewKey(view(5000));
    expect(previewState(null, k)).toBe("NONE");
    expect(previewState(k, previewKey(view(5000)))).toBe("CURRENT");
  });
  it("a change in approved completion, or in the claim list, makes the preview STALE", () => {
    const k = previewKey(view(5000));
    expect(previewState(k, previewKey(view(7500)))).toBe("STALE");
    expect(previewState(k, previewKey(view(5000, "READY_FOR_APPROVAL")))).toBe("STALE");
  });
});
