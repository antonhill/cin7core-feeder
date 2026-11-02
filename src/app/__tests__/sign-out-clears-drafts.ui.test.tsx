// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DRAFT_PREFIX, draftKey, saveDraft, defaultDraftStorage } from "@/lib/form-draft";

// F-13: signing out must remove every NewQuip draft (a quotation draft may hold cost overrides) from this tab's sessionStorage. The server action is untouched.
const h = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/projects", useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/actions/auth", () => ({ signOutAction: h.signOut }));
vi.mock("@/actions/org-logo", () => ({ uploadCurrentOrgLogo: vi.fn() }));
vi.mock("@/app/reports/actions", () => ({ triggerSalesSyncAction: vi.fn() }));
vi.mock("@/app/OrgSwitcher", () => ({ OrgSwitcher: () => null }));
vi.mock("@/app/ActiveOrgSwitcher", () => ({ ActiveOrgSwitcher: () => null }));
import { NewquipShell } from "../NewquipShell";

const drafts = () => Object.keys(sessionStorage).filter((k) => k.startsWith(DRAFT_PREFIX));
beforeEach(() => { sessionStorage.clear(); saveDraft(defaultDraftStorage(), draftKey("u1", "quotation", "q1"), "hash", { overrides: [1] }); sessionStorage.setItem("unrelated", "keep"); });
afterEach(() => cleanup());

describe("sign-out clears drafts", () => {
  it("NewquipShell: submitting Sign out removes drafts, leaves unrelated keys", () => {
    render(<NewquipShell links={[]} orgName="Org" userEmail="u@x.co.za">x</NewquipShell>);
    expect(drafts().length).toBe(1);
    fireEvent.submit(screen.getByRole("button", { name: "Sign out" }).closest("form")!);
    expect(drafts()).toEqual([]);
    expect(sessionStorage.getItem("unrelated")).toBe("keep");
  });
  it("without a submit, drafts stay", () => {
    render(<NewquipShell links={[]} orgName="Org" userEmail="u@x.co.za">x</NewquipShell>);
    expect(drafts().length).toBe(1);
  });
});
