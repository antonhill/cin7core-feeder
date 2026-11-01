import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountOptions, chosenAccountError, classifyAccount } from "../cin7-account-eligibility";
import { fetchAllAccounts, REF_ACCOUNT_PATH } from "@/cin7/reference-lookups";
import { cin7Request } from "@/cin7/http";

vi.mock("@/cin7/http", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/cin7/http")>()), cin7Request: vi.fn() }));
const creds = { accountId: "a", applicationKey: "k", baseUrl: "https://example.test" };
beforeEach(() => vi.mocked(cin7Request).mockReset());

const acct = (o: Partial<Parameters<typeof classifyAccount>[0]>) => ({ code: "200", name: "Sales", type: "REVENUE", accountClass: "REVENUE", systemAccount: null, active: true, ...o });

describe("UAT-010 which Cin7 accounts can be chosen", () => {
  it("an ordinary active revenue account (200 Sales, the proven one) is selectable", () => {
    expect(classifyAccount(acct({}))).toMatchObject({ group: "REVENUE", selectable: true });
  });
  it("a balance-sheet liability account (customer deposits) is listed but NOT selectable until Cin7 acceptance is proven", () => {
    const o = classifyAccount(acct({ code: "820", name: "Customer deposits", type: "CURRLIAB", accountClass: "LIABILITY" }));
    expect(o).toMatchObject({ group: "LIABILITY", selectable: false });
    expect(o.note).toMatch(/not proven/);
  });
  it("system (payable/receivable) and inactive accounts are never selectable, even if their class looks like revenue", () => {
    expect(classifyAccount(acct({ systemAccount: "Accounts receivable" })).selectable).toBe(false);
    expect(classifyAccount(acct({ active: false })).selectable).toBe(false);
  });
  it("an account with no readable class is not guessed at", () => {
    expect(classifyAccount(acct({ type: null, accountClass: null }))).toMatchObject({ group: "OTHER", selectable: false });
  });
  it("selectable accounts sort first; a chosen code is re-checked against a fresh read", () => {
    const list = [acct({ code: "820", type: "CURRLIAB", accountClass: "LIABILITY" }), acct({ code: "200" }), acct({ code: "210", name: "Other sales" })];
    expect(accountOptions(list).map((a) => a.code)).toEqual(["200", "210", "820"]);
    expect(chosenAccountError(list, "200")).toBeNull();
    expect(chosenAccountError(list, "820")).toMatch(/cannot be used/);
    expect(chosenAccountError(list, "999")).toMatch(/not found/);
  });
});

describe("fetchAllAccounts (read-only)", () => {
  it("pages through GET /ref/account and reads class, type, system designation and active state without guessing", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ Code: String(100 + i), Name: `A${i}`, Type: "REVENUE", Class: "REVENUE" }));
    vi.mocked(cin7Request)
      .mockResolvedValueOnce({ AccountsList: page1 })
      .mockResolvedValueOnce({ AccountsList: [{ Code: "800", Name: "Accounts Payable", SystemAccount: "Accounts payable", Class: "LIABILITY" }, { Code: "999", Name: "Old", Status: "Inactive" }, { Name: "no code" }] });
    const all = await fetchAllAccounts(creds);
    expect(all).toHaveLength(102);
    expect(vi.mocked(cin7Request).mock.calls.every((c) => c[1] === REF_ACCOUNT_PATH)).toBe(true);
    expect(vi.mocked(cin7Request).mock.calls.every((c) => !(c[2] as { method?: string } | undefined)?.method || (c[2] as { method?: string }).method === "GET")).toBe(true); // reads only
    expect(all.find((a) => a.code === "800")).toMatchObject({ systemAccount: "Accounts payable", accountClass: "LIABILITY", type: null, active: true });
    expect(all.find((a) => a.code === "999")?.active).toBe(false);
  });
});
