import { describe, expect, it, vi } from "vitest";
import { fetchAllRows, SUPABASE_PAGE_SIZE } from "@/supabase/fetch-all-rows";

/** Serves `total` rows in pages, recording the ranges asked for. */
function pager(total: number) {
  const ranges: [number, number][] = [];
  const rows = Array.from({ length: total }, (_, i) => ({ i }));
  const fetchPage = vi.fn((from: number, to: number) => {
    ranges.push([from, to]);
    return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
  });
  return { fetchPage, ranges };
}

describe("fetchAllRows", () => {
  it("returns every row when the result spans several pages", async () => {
    const { fetchPage } = pager(2_500);
    const rows = await fetchAllRows<{ i: number }>("t", fetchPage);

    expect(rows).toHaveLength(2_500);
    expect(rows[0].i).toBe(0);
    expect(rows[2_499].i).toBe(2_499);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("requests contiguous, non-overlapping ranges", async () => {
    const { ranges } = { ...pager(2_500) };
    const p = pager(2_500);
    await fetchAllRows("t", p.fetchPage);

    expect(p.ranges).toEqual([
      [0, SUPABASE_PAGE_SIZE - 1],
      [SUPABASE_PAGE_SIZE, SUPABASE_PAGE_SIZE * 2 - 1],
      [SUPABASE_PAGE_SIZE * 2, SUPABASE_PAGE_SIZE * 3 - 1],
    ]);
    void ranges;
  });

  it("stops on a short final page", async () => {
    const p = pager(1_200);
    const rows = await fetchAllRows("t", p.fetchPage);
    expect(rows).toHaveLength(1_200);
    expect(p.fetchPage).toHaveBeenCalledTimes(2);
  });

  it("makes one extra empty request when the total is an exact multiple of the page size", async () => {
    // The cost of not needing a separate count query: a full final page is
    // indistinguishable from "there may be more", so it asks once more.
    const p = pager(SUPABASE_PAGE_SIZE * 2);
    const rows = await fetchAllRows("t", p.fetchPage);
    expect(rows).toHaveLength(SUPABASE_PAGE_SIZE * 2);
    expect(p.fetchPage).toHaveBeenCalledTimes(3);
  });

  it("handles an empty result in a single request", async () => {
    const p = pager(0);
    await expect(fetchAllRows("t", p.fetchPage)).resolves.toEqual([]);
    expect(p.fetchPage).toHaveBeenCalledTimes(1);
  });

  it("treats a null data page as the end rather than throwing", async () => {
    const fetchPage = vi.fn().mockResolvedValue({ data: null, error: null });
    await expect(fetchAllRows("t", fetchPage)).resolves.toEqual([]);
  });

  it("fails closed when a LATER page errors, discarding the rows already read", async () => {
    // The whole point: a partial result that reads as complete is the defect.
    const rows = Array.from({ length: 2_500 }, (_, i) => ({ i }));
    const fetchPage = vi.fn((from: number, to: number) =>
      from === SUPABASE_PAGE_SIZE
        ? Promise.resolve({ data: null, error: { message: "boom" } })
        : Promise.resolve({ data: rows.slice(from, to + 1), error: null })
    );

    await expect(fetchAllRows("products", fetchPage)).rejects.toThrow("products: boom");
  });

  it("names the query in the error so a failure is locatable", async () => {
    const fetchPage = vi.fn().mockResolvedValue({ data: null, error: { message: "permission denied" } });
    await expect(fetchAllRows("customer_sync_state", fetchPage)).rejects.toThrow("customer_sync_state: permission denied");
  });

  it("imposes no row ceiling — a sync must process whatever the client has", async () => {
    const p = pager(12_000);
    const rows = await fetchAllRows("t", p.fetchPage);
    expect(rows).toHaveLength(12_000);
  });
});
