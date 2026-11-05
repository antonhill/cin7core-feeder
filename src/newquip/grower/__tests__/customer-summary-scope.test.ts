import { describe, expect, it } from "vitest";
import { buildCustomerSummaryFromCommercial } from "../customer-summary";

const mk = (itemKeys: string[]) => buildCustomerSummaryFromCommercial({ lines: itemKeys.map((itemKey) => ({ itemKey, revenueCents: 100000 })), charges: [], subtotalCents: itemKeys.length * 100000, taxCents: 0, totalCents: itemKeys.length * 100000 });

describe("customer summary scope wording follows what is on the quotation", () => {
  it("never names M75 or feed-saver mats when they are not quoted", () => {
    const s = mk(["bulk_tank", "feeder"]).sections.map((x) => x.scope).join(" | ");
    expect(s).toContain("Bulk feed storage, as configured with your representative.");
    expect(s).toContain("CCM feeders for each room.");
    expect(s).not.toMatch(/M75|feed-saver/i);
  });
  it("keeps the full wording when all the items are quoted", () => {
    const s = mk(["bulk_tank", "flex_auger", "feeder", "feed_saver_mat", "led_light", "pvc_door"]).sections.map((x) => x.scope).join(" | ");
    expect(s).toContain("Bulk feed storage and the M75 feed distribution system");
    expect(s).toContain("CCM feeders with feed-saver mats for each room.");
    expect(s).toContain("LED lighting and PVC doors with frames.");
  });
});
