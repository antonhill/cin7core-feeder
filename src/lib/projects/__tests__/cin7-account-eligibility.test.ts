import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountOptions, unsupportedAccountError, classifyAccount } from "../cin7-account-eligibility";
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
    expect(unsupportedAccountError(list, "200")).toBeNull();
    expect(unsupportedAccountError(list, "820")).toMatch(/cannot be used/);
    expect(unsupportedAccountError(list, "999")).toMatch(/not found/);
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

describe("server-side account check (review P1)", () => {
  it("refuses liability, system and inactive accounts and unknown codes however they were entered, but does not demand a recognised revenue class", () => {
    const list = [acct({ code: "820", type: "CURRLIAB", accountClass: "LIABILITY" }), acct({ code: "800", systemAccount: "Accounts payable" }), acct({ code: "900", active: false }), acct({ code: "300", type: "X", accountClass: "WEIRD" })];
    for (const c of ["820", "800", "900"]) expect(unsupportedAccountError(list, c)).toMatch(/cannot be used/);
    expect(unsupportedAccountError(list, "nope")).toMatch(/not found/);
    expect(unsupportedAccountError(list, "300")).toBeNull();
  });
  it("createCin7SaleAction runs the server-side account check before it can create anything", () => {
    const src = readFileSync(new URL("../../../app/projects/cin7-actions.ts", import.meta.url), "utf8");
    const check = src.indexOf("verifyRevenueAccountForSale(");
    const create = src.indexOf("createSaleForProject(db,");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(create);
    expect(src.slice(check, create)).toMatch(/if \(accountError\) throw new Error\(accountError\)/); // the result is enforced, not just read
    expect(src.slice(check - 200, check)).toMatch(/gates\.isManager && gates\.writesEnabled && gates\.orgEnabled/);
  });
});
