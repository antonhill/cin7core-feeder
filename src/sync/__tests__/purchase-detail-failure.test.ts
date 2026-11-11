import { describe, expect, it } from "vitest";
import { sanitiseSyncError } from "@/sync/purchase-detail-failure";
import { ReceiptLineConflictError } from "@/cin7/purchase-detail";
import { Cin7ApiError } from "@/cin7/http";

describe("sanitiseSyncError", () => {
  it("names a Postgres duplicate-key error by constraint and drops the key/DETAIL values", () => {
    const e = new Error('replace_purchase_detail: duplicate key value violates unique constraint "purchase_receipt_lines_pkey" (org_id, card_id)=(11111111-2222-3333-4444-555555555555, abcdefghijklmnopqrstuvwxyz0123456789)');
    expect(sanitiseSyncError(e)).toEqual({ code: "duplicate_key", message: "Duplicate key on purchase_receipt_lines_pkey" });
  });

  it("reports a receipt conflict by SKU and field NAMES only", () => {
    const r = sanitiseSyncError(new ReceiptLineConflictError("SKU-A", ["receivedDate", "location"]));
    expect(r.code).toBe("receipt_line_conflict");
    expect(r.message).toContain("receivedDate, location");
  });

  it("redacts UUIDs and long tokens, collapses whitespace and bounds length for unknown errors", () => {
    const r = sanitiseSyncError(new Error(`bad ${"x".repeat(40)}  id 11111111-2222-3333-4444-555555555555 ${"y ".repeat(300)}`));
    expect(r.code).toBe("unknown");
    expect(r.message).not.toMatch(/11111111-2222|x{32}/);
    expect(r.message.length).toBeLessThanOrEqual(240);
  });

  it("labels Cin7 API errors with the HTTP status", () => {
    expect(sanitiseSyncError(new Cin7ApiError(503, "busy", true))).toMatchObject({ code: "cin7_api", message: expect.stringContaining("HTTP 503") });
  });
});
