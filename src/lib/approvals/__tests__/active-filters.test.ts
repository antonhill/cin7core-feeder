import { describe, expect, it } from "vitest";
import { activeFilters, CLEARED_FILTERS } from "../queue";

describe("UAT-018 active filters are visible and clearable", () => {
  it("the default Pending status filter is reported as active, so a hidden request is explained", () => {
    expect(activeFilters({ status: "PENDING" }, () => "Pending approval").map((a) => a.label)).toEqual(["Status: Pending approval"]);
  });
  it("Any status and empty text boxes are not active filters", () => {
    expect(activeFilters({ status: "ANY", customer: "  ", project: "" })).toEqual([]);
  });
  it("every narrowing filter is listed, and clearing removes all of them", () => {
    const f = { mine: true, docType: "CLAIM", status: "APPROVED", customer: "Spark", project: "P1", preparer: "a", assignee: "b", from: "2026-11-01T00:00:00+02:00", to: "2026-11-02T00:00:00+02:00", overdueOnly: true } as never;
    expect(activeFilters(f)).toHaveLength(10);
    expect(activeFilters(CLEARED_FILTERS)).toEqual([]);
    expect(CLEARED_FILTERS.status).toBe("ANY"); // not back to the Pending default
  });
});
