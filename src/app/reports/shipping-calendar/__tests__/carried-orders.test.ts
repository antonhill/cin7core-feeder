import { describe, expect, it } from "vitest";
import { mergeCarriedOrders } from "../carried-orders";
import type { OrderFulfillmentRow } from "@/reports/query";

const order = (id: string, extra: Partial<OrderFulfillmentRow> = {}) =>
  ({ cin7_sale_id: id, ship_by: "2026-09-08", ...extra }) as OrderFulfillmentRow;

/**
 * Regression: with the windowed fetch (0090), rescheduling a card into
 * another week jumps the board there and re-fetches before the Cin7
 * write-back has landed. Without this merge the card the user just dragged
 * vanishes from the grid.
 */
describe("mergeCarriedOrders", () => {
  it("keeps a moved order that the new window has not returned yet", () => {
    const result = mergeCarriedOrders([order("a")], { b: order("b") });
    expect(result.map((o) => o.cin7_sale_id)).toEqual(["a", "b"]);
  });

  it("does not duplicate an order the fetch already returned", () => {
    const result = mergeCarriedOrders([order("a"), order("b")], { b: order("b") });
    expect(result.map((o) => o.cin7_sale_id)).toEqual(["a", "b"]);
  });

  it("prefers the freshly fetched copy over the carried one", () => {
    const fetched = order("b", { combined_shipping_status: "SHIPPED" });
    const result = mergeCarriedOrders([fetched], { b: order("b", { combined_shipping_status: "PENDING" }) });
    expect(result).toHaveLength(1);
    expect(result[0].combined_shipping_status).toBe("SHIPPED");
  });

  it("returns the fetched array unchanged when nothing was moved", () => {
    const fetched = [order("a")];
    expect(mergeCarriedOrders(fetched, {})).toBe(fetched);
  });

  it("carries several moved orders at once", () => {
    const result = mergeCarriedOrders([], { a: order("a"), b: order("b") });
    expect(result.map((o) => o.cin7_sale_id).sort()).toEqual(["a", "b"]);
  });
});
