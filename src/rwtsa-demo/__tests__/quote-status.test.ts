import { describe, expect, it } from "vitest";
import { normaliseQuoteStatus, RECOGNISED_STATUSES } from "@/rwtsa-demo/contracts/quote-status";

describe("quote status normalisation (explicit table, never a default)", () => {
  it("recognises won, lost and open, ignoring case, spacing, hyphens and underscores", () => {
    for (const s of ["won", "WON", " Won ", "closed won", "Closed-Won", "closed_won", "accepted"]) expect(normaliseQuoteStatus(s), s).toBe("WON");
    for (const s of ["lost", "LOST", "closed lost", "declined", "rejected"]) expect(normaliseQuoteStatus(s), s).toBe("LOST");
    for (const s of ["open", "Open", "pending", "sent", "quoted"]) expect(normaliseQuoteStatus(s), s).toBe("OPEN");
  });
  it("anything else is UNCLASSIFIED, never OPEN", () => {
    for (const s of ["", "  ", "draft", "expired", "cancelled", "on hold", "pending review", "won?", "wonn", "open/lost", "1"]) expect(normaliseQuoteStatus(s), s).toBe("UNCLASSIFIED");
  });
  it("null, undefined and non-strings are UNCLASSIFIED", () => {
    for (const v of [null, undefined, 3, true, {}]) expect(normaliseQuoteStatus(v as never)).toBe("UNCLASSIFIED");
  });
  it("the recognised table is explicit and does not overlap between statuses", () => {
    const all = Object.values(RECOGNISED_STATUSES).flat();
    expect(new Set(all).size).toBe(all.length);
    expect(Object.keys(RECOGNISED_STATUSES).sort()).toEqual(["LOST", "OPEN", "WON"]);
  });
});
