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

import { filterQueue } from "../queue";
describe("a whitespace-only text filter neither filters nor hides the Clear option", () => {
  it("is ignored by filterQueue, consistent with the chips", () => {
    const rows = [{ status: "PENDING", doc_type: "CLAIM", customer_name: "Spark", project_ref: "P", doc_ref: "D", prepared_by_email: "a@x", assigned_to_email: null, submitted_at: "2026-11-01T00:00:00Z", due_at: null }] as never;
    expect(filterQueue(rows, { status: "ANY", customer: " " }, "me@x", "2026-11-02T00:00:00Z")).toHaveLength(1);
    expect(filterQueue(rows, { status: "ANY", customer: "spark" }, "me@x", "2026-11-02T00:00:00Z")).toHaveLength(1);
    expect(filterQueue(rows, { status: "ANY", customer: "zzz" }, "me@x", "2026-11-02T00:00:00Z")).toHaveLength(0);
  });
});
