import { describe, expect, it } from "vitest";
import { variationNextStep, type VariationNextInput } from "../variation-next-step";

const v = (o: Partial<VariationNextInput>): VariationNextInput => ({ status: "APPROVED", amountCents: 100, isAdmin: true, billingLoaded: true, billingStarted: false, scheduleMissing: false, ...o });

describe("variationNextStep", () => {
  it("draft without a price: price it first", () => expect(variationNextStep(v({ status: "DRAFT", amountCents: 0 }))).toMatch(/Set a price/));
  it("draft: submit; says who must approve", () => {
    expect(variationNextStep(v({ status: "DRAFT", isAdmin: false }))).toMatch(/If it has not been submitted.*waiting for a manager to approve/);
    expect(variationNextStep(v({ status: "DRAFT", isAdmin: true }))).toMatch(/waiting for a manager.*approve or reject it here or in Approvals/);
  });
  it("rejected is closed", () => expect(variationNextStep(v({ status: "REJECTED" }))).toMatch(/Closed/));
  it("approved, billing figures not loaded: does not guess", () => expect(variationNextStep(v({ billingLoaded: false }))).toMatch(/still loading/));
  it("approved without a schedule", () => {
    expect(variationNextStep(v({ scheduleMissing: true }))).toMatch(/Set its billing schedule/);
    expect(variationNextStep(v({ scheduleMissing: true, isAdmin: false }))).toMatch(/A manager must set/);
  });
  it("approved, billing not started: admin starts it, others are told a manager does", () => {
    expect(variationNextStep(v({}))).toMatch(/Start variation billing/);
    expect(variationNextStep(v({ isAdmin: false }))).toMatch(/A manager checks the schedule and starts/);
  });
  it("billing started: claimable value points to claims; none points to approving commercial progress", () => {
    expect(variationNextStep(v({ billingStarted: true, claimableCents: 5 }))).toMatch(/prepare a claim/);
    expect(variationNextStep(v({ billingStarted: true, claimableCents: 0 }))).toMatch(/nothing is claimable yet.*commercial progress is approved/);
    expect(variationNextStep(v({ billingStarted: true, claimableCents: 0, isAdmin: false }))).toMatch(/A manager checks commercial progress/);
  });
  it("unknown status", () => expect(variationNextStep(v({ status: "???" }))).toMatch(/not recognised/));
  it("billing started: unknown claimable never claims zero; fully billed is said plainly", () => {
    expect(variationNextStep(v({ billingStarted: true }))).toMatch(/to see what can be claimed/);
    expect(variationNextStep(v({ billingStarted: true, claimableCents: 0, remainingCents: 0 }))).toMatch(/already billed or committed/);
  });
});
