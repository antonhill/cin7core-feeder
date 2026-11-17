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

const assign = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  h.next = null;
  h.signInWithOtp.mockResolvedValue({ error: null });
  h.verifyOtp.mockResolvedValue({ error: null });
  h.signOut.mockResolvedValue({});
  Object.defineProperty(window, "location", { configurable: true, value: { origin: "http://localhost", assign } });
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
  it("after a verified code it navigates to the server completion route (access is decided there), never calling the action in the same tick", async () => {
    await toCodeStep();
    await submitCode();
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/newquip/login/complete"));
    expect(h.complete).not.toHaveBeenCalled();
  });
  it("ignores an unsafe next", async () => {
    h.next = "https://evil.example/projects";
    await toCodeStep();
    await submitCode();
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/newquip/login/complete"));
  });
  it("passes a safe NewQuip next to the completion route", async () => {
    h.next = "/projects/abc";
    await toCodeStep();
    await submitCode();
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/newquip/login/complete?next=%2Fprojects%2Fabc"));
  });
});
