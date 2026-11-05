import { describe, expect, it } from "vitest";
import { nothingClaimableReasons } from "../nothing-claimable";

const stage = (approvedBps: number, claimableCents: number, remainingCents: number) => ({ approvedBps, claimableCents, remainingCents });
const base = { scheduleBalanced: true, uncertainClaimBlocking: false, isAdmin: true };
const texts = (i: Parameters<typeof nothingClaimableReasons>[0]) => nothingClaimableReasons(i)?.map((r) => r.text) ?? null;

describe("nothingClaimableReasons (table)", () => {
  const cases: Array<[string, Parameters<typeof nothingClaimableReasons>[0], RegExp[] | null]> = [
    ["something claimable", { ...base, stages: [stage(0, 0, 100), stage(5000, 50, 100)] }, null],
    ["no approval, admin", { ...base, stages: [stage(0, 0, 100)] }, [/No stage has approved commercial progress\. Use Approve commercial progress/]],
    ["no approval, member", { ...base, isAdmin: false, stages: [stage(0, 0, 100)] }, [/An owner or admin must approve it on the Stages tab/]],
    ["some stages unapproved", { ...base, stages: [stage(0, 0, 100), stage(0, 0, 100), stage(0, 0, 0)] }, [/2 of 3 stages have no approved/]],
    ["spent (approved, already billed), admin", { ...base, stages: [stage(10000, 0, 40)] }, [/One stage has approved progress that is already billed or committed\. Approve a higher commercial percentage/]],
    ["spent, member, several", { ...base, isAdmin: false, stages: [stage(5000, 0, 40), stage(5000, 0, 10)] }, [/2 stages have approved progress.*An owner or admin must approve a higher/]],
    ["every stage fully billed", { ...base, stages: [stage(10000, 0, 0), stage(10000, 0, 0)] }, [/Every stage is already fully billed or committed/]],
    ["no stages (early return)", { ...base, stages: [] }, [/no billing stages/]],
    ["unapproved and spent together", { ...base, stages: [stage(0, 0, 100), stage(5000, 0, 10)] }, [/1 of 2 stages have no approved/, /One stage has approved progress/]],
    ["banners shown: schedule and uncertain are omitted", { ...base, scheduleBalanced: false, uncertainClaimBlocking: true, bannersShown: true, stages: [stage(0, 0, 100)] }, [/No stage has approved/]],
    ["banners not shown: precedence schedule, uncertain, then progress", { ...base, scheduleBalanced: false, uncertainClaimBlocking: true, stages: [stage(0, 0, 100)] }, [/do not reconcile/, /uncertain Cin7 outcome/, /No stage has approved/]],
    ["no stages with a blocking claim", { ...base, uncertainClaimBlocking: true, stages: [] }, [/uncertain Cin7 outcome/, /no billing stages/]],
  ];
  for (const [name, input, want] of cases) {
    it(name, () => {
      const got = texts(input);
      if (want === null) return expect(got).toBeNull();
      expect(got!.length).toBe(want.length);
      want.forEach((re, k) => expect(got![k]).toMatch(re));
    });
  }
  it("progress reasons point to the Stages tab; blocking ones in the claims list do not", () => {
    const r = nothingClaimableReasons({ ...base, uncertainClaimBlocking: true, stages: [stage(0, 0, 100)] })!;
    expect(r[0].tab).toBeUndefined();
    expect(r[1].tab).toBe("stages");
  });
});
