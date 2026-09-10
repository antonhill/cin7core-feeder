import { describe, expect, it } from "vitest";
import { shipByWindowForWeek, mondayOf, addDays, CALENDAR_DAY_COUNT } from "../date-utils";

/**
 * The ship_by window CalendarBoard fetches (migration 0090) has to agree
 * EXACTLY with the bucketing rule it draws with, or cards silently vanish
 * from the edges of the grid. CalendarBoard buckets a card under
 * `ship_by - offsetDays`, so these tests re-derive the window from that rule
 * rather than restating the implementation's arithmetic.
 */
const bucketDateFor = (shipBy: string, offsetDays: number) => addDays(shipBy, -offsetDays);

function inWindow(shipBy: string, w: { shipByFrom: string; shipByTo: string }) {
  return shipBy >= w.shipByFrom && shipBy <= w.shipByTo;
}

describe("shipByWindowForWeek (Shipping/Picking Calendar)", () => {
  it("covers exactly the week for Shipping Calendar's zero offset", () => {
    expect(shipByWindowForWeek("2026-09-07", 0)).toEqual({ shipByFrom: "2026-09-07", shipByTo: "2026-09-13" });
  });

  it("shifts forward by Picking Calendar's lead time", () => {
    // Pick 2 days before ship: the Monday column shows orders shipping Wed.
    expect(shipByWindowForWeek("2026-09-07", 2)).toEqual({ shipByFrom: "2026-09-09", shipByTo: "2026-09-15" });
  });

  it.each([0, 1, 3, 7])(
    "admits a ship_by if and only if it buckets onto a visible day (offset %i)",
    (offsetDays) => {
      const weekStart = "2026-09-07";
      const visibleDays = Array.from({ length: CALENDAR_DAY_COUNT }, (_, i) => addDays(weekStart, i));
      const window = shipByWindowForWeek(weekStart, offsetDays);

      // Sweep a month either side so both edges of the window are tested.
      for (let d = -31; d <= 31; d++) {
        const shipBy = addDays(weekStart, d);
        const drawnOnGrid = visibleDays.includes(bucketDateFor(shipBy, offsetDays));
        expect(inWindow(shipBy, window)).toBe(drawnOnGrid);
      }
    }
  );

  it.each([
    ["previous week", "2026-08-31"],
    ["current week", "2026-09-07"],
    ["next week", "2026-09-14"],
  ])("returns a 7-day inclusive span for the %s", (_label, weekStart) => {
    const { shipByFrom, shipByTo } = shipByWindowForWeek(weekStart, 0);
    expect(shipByFrom).toBe(weekStart);
    expect(addDays(shipByFrom, CALENDAR_DAY_COUNT - 1)).toBe(shipByTo);
  });

  it("produces adjacent, non-overlapping windows for consecutive weeks", () => {
    const thisWeek = shipByWindowForWeek("2026-09-07", 0);
    const nextWeek = shipByWindowForWeek(mondayOf("2026-09-14"), 0);
    expect(addDays(thisWeek.shipByTo, 1)).toBe(nextWeek.shipByFrom);
  });
});
