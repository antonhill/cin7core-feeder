import { describe, expect, it, vi, beforeEach } from "vitest";
import { checkCustomerReferenceFields } from "@/cin7/debug";
import { cin7Request, Cin7ApiError } from "@/cin7/http";

vi.mock("@/cin7/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/cin7/http")>();
  return { ...actual, cin7Request: vi.fn() };
});

const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };

beforeEach(() => {
  vi.mocked(cin7Request).mockReset();
});

describe("checkCustomerReferenceFields", () => {
  it("marks a blank field as 'not set' without calling the API for it", async () => {
    const results = await checkCustomerReferenceFields(creds, {
      location: null,
      sales_representative: null,
      account_receivable: null,
      sale_account: null,
      tax_rule: null,
      price_tier: null,
      payment_term: null,
    });
    expect(results.every((r) => r.exists === "not set")).toBe(true);
    expect(cin7Request).not.toHaveBeenCalled();
  });

  it("keeps checking the remaining fields when one field's lookup unexpectedly throws — the bug that made the original push failure look like a Xero mystery", async () => {
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ LocationList: [{ Name: "Main Warehouse" }] }) // Location: exists
      .mockRejectedValueOnce(new Cin7ApiError(503, "Rate limited", true)) // SalesRepresentative: unexpected failure
      .mockResolvedValueOnce({ AccountsList: [] }); // AccountReceivable Code lookup: misses
    vi.mocked(cin7Request).mockResolvedValue({ AccountsList: [] }); // fallback for remaining calls

    const results = await checkCustomerReferenceFields(creds, {
      location: "Main Warehouse",
      sales_representative: "Sparkie",
      account_receivable: "3443434",
      sale_account: null,
      tax_rule: null,
      price_tier: null,
      payment_term: null,
    });

    expect(results.find((r) => r.field === "Location")).toMatchObject({ exists: true });
    expect(results.find((r) => r.field === "SalesRepresentative")).toMatchObject({
      exists: "not set",
      checkError: "Rate limited",
    });
    expect(results.find((r) => r.field === "AccountReceivable")).toMatchObject({ exists: false });
  });
});
