// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  next: null as string | null,
  signInWithOtp: vi.fn(),
  verifyOtp: vi.fn(),
  signOut: vi.fn(),
  complete: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => ({ get: (k: string) => (k === "next" ? h.next : null) }) }));
vi.mock("@/supabase/browser", () => ({ createBrowserSupabaseClient: () => ({ auth: { signInWithOtp: h.signInWithOtp, verifyOtp: h.verifyOtp, signOut: h.signOut } }) }));
vi.mock("@/actions/newquip-access", () => ({ completeNewquipSignInAction: h.complete }));

import NewquipLoginPage from "../page";

const hrefSet = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  h.next = null;
  h.signInWithOtp.mockResolvedValue({ error: null });
  h.verifyOtp.mockResolvedValue({ error: null });
  h.signOut.mockResolvedValue({});
  Object.defineProperty(window, "location", { configurable: true, value: { set href(v: string) { hrefSet(v); } } });
});
afterEach(cleanup);

async function toCodeStep() {
  render(<NewquipLoginPage />);
  fireEvent.change(screen.getByPlaceholderText("you@company.com"), { target: { value: "a@b.co" } });
  fireEvent.click(screen.getByRole("button", { name: /send sign-in code/i }));
  await screen.findByPlaceholderText("000000");
}
async function submitCode() {
  fireEvent.change(screen.getByPlaceholderText("000000"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: /verify/i }));
}

describe("NewQuip login page", () => {
  it("is NewQuip branded only (no Toolbox wording)", () => {
    const { container } = render(<NewquipLoginPage />);
    expect(screen.getByRole("heading", { name: "NewQuip" })).toBeTruthy();
    expect(container.textContent).not.toMatch(/toolbox|cin7/i);
  });
  it("sends the code with shouldCreateUser:false and shows send errors", async () => {
    h.signInWithOtp.mockResolvedValue({ error: { message: "Rate limited" } });
    render(<NewquipLoginPage />);
    fireEvent.change(screen.getByPlaceholderText("you@company.com"), { target: { value: "a@b.co" } });
    fireEvent.click(screen.getByRole("button", { name: /send sign-in code/i }));
    expect((await screen.findByRole("alert")).textContent).toBe("Rate limited");
    expect(h.signInWithOtp).toHaveBeenCalledWith({ email: "a@b.co", options: { shouldCreateUser: false } });
  });
  it("shows an invalid-code error and does not call the access action", async () => {
    h.verifyOtp.mockResolvedValue({ error: { message: "Token has expired or is invalid" } });
    await toCodeStep();
    await submitCode();
    expect((await screen.findByRole("alert")).textContent).toContain("invalid");
    expect(h.complete).not.toHaveBeenCalled();
  });
  it("a verified account without NewQuip access is signed out and told so, never navigated", async () => {
    h.complete.mockResolvedValue({ ok: false, error: "This account does not have access to NewQuip." });
    await toCodeStep();
    await submitCode();
    expect((await screen.findByRole("alert")).textContent).toBe("This account does not have access to NewQuip.");
    expect(h.signOut).toHaveBeenCalled();
    expect(hrefSet).not.toHaveBeenCalled();
  });
  it("success hard-navigates to / (or a safe NewQuip next)", async () => {
    h.complete.mockResolvedValue({ ok: true });
    await toCodeStep();
    await submitCode();
    await waitFor(() => expect(hrefSet).toHaveBeenCalledWith("/"));
  });
  it("ignores an unsafe next", async () => {
    h.next = "https://evil.example/projects";
    h.complete.mockResolvedValue({ ok: true });
    await toCodeStep();
    await submitCode();
    await waitFor(() => expect(hrefSet).toHaveBeenCalledWith("/"));
  });
  it("honours a safe NewQuip next", async () => {
    h.next = "/projects/abc";
    h.complete.mockResolvedValue({ ok: true });
    await toCodeStep();
    await submitCode();
    await waitFor(() => expect(hrefSet).toHaveBeenCalledWith("/projects/abc"));
  });
});
