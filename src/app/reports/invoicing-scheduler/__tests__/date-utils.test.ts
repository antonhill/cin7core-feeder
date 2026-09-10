import { describe, expect, it } from "vitest";
import { shipByWindowForWeek, addDays, CALENDAR_DAY_COUNT } from "../date-utils";

/**
 * This page buckets under `ship_by + offsetDays` ("invoice N days after
 * ship"), the OPPOSITE direction to CalendarBoard's `ship_by - offsetDays`.
 * Both helpers share a name, so getting the sign backwards here would be
 * invisible at a glance and would empty the grid for any non-zero offset —
 * hence a dedicated test that re-derives the window from this page's own
 * bucketing rule.
 */
const bucketDateFor = (shipBy: string, offsetDays: number) => addDays(shipBy, offsetDays);

describe("shipByWindowForWeek (Invoicing Scheduler)", () => {
  it("covers exactly the week at zero offset", () => {
    expect(shipByWindowForWeek("2026-09-07", 0)).toEqual({ shipByFrom: "2026-09-07", shipByTo: "2026-09-13" });
  });

  it("shifts BACKWARD by the offset — the opposite way to CalendarBoard", () => {
    // Invoice 3 days after ship: the Monday column shows orders that shipped Friday.
    expect(shipByWindowForWeek("2026-09-07", 3)).toEqual({ shipByFrom: "2026-09-04", shipByTo: "2026-09-10" });
  });

  it.each([0, 1, 3, 7])(
    "admits a ship_by if and only if it buckets onto a visible day (offset %i)",
    (offsetDays) => {
      const weekStart = "2026-09-07";
      const visibleDays = Array.from({ length: CALENDAR_DAY_COUNT }, (_, i) => addDays(weekStart, i));
      const { shipByFrom, shipByTo } = shipByWindowForWeek(weekStart, offsetDays);

      for (let d = -31; d <= 31; d++) {
        const shipBy = addDays(weekStart, d);
        const drawnOnGrid = visibleDays.includes(bucketDateFor(shipBy, offsetDays));
        expect(shipBy >= shipByFrom && shipBy <= shipByTo).toBe(drawnOnGrid);
      }
    }
  );

  it.each([
    ["previous week", "2026-08-31"],
    ["current week", "2026-09-07"],
    ["next week", "2026-09-14"],
  ])("returns a 7-day inclusive span for the %s", (_label, weekStart) => {
    const { shipByFrom, shipByTo } = shipByWindowForWeek(weekStart, 0);
    expect(addDays(shipByFrom, CALENDAR_DAY_COUNT - 1)).toBe(shipByTo);
  });
});
