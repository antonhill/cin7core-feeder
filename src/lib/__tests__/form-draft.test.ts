import { describe, expect, it } from "vitest";
import { DRAFT_MAX_CHARS, DRAFT_PREFIX, DRAFT_TTL_MS, clearAllDrafts, clearDraft, draftKey, loadDraft, saveDraft, type DraftStorage } from "../form-draft";

function mem(): DraftStorage & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); }, key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}
const T0 = 1_000_000;

describe("form-draft", () => {
  it("round-trips a fresh draft", () => {
    const s = mem(); const k = draftKey("u1", "quote", "q1");
    expect(saveDraft(s, k, "h1", { a: 1 }, T0)).toBe(true);
    expect(loadDraft(s, k, "h1", T0 + 1000)).toEqual({ status: "fresh", data: { a: 1 }, savedAt: T0 });
  });
  it("keys isolate user, kind and record", () => {
    const s = mem();
    saveDraft(s, draftKey("u1", "quote", "q1"), "h", 1, T0);
    for (const k of [draftKey("u2", "quote", "q1"), draftKey("u1", "claim", "q1"), draftKey("u1", "quote", "q2")]) expect(loadDraft(s, k, "h", T0).status).toBe("none");
  });
  it("a draft based on an older server version is STALE: reported, removed, never restored", () => {
    const s = mem(); const k = draftKey("u1", "quote", "q1");
    saveDraft(s, k, "old", 1, T0);
    expect(loadDraft(s, k, "new", T0).status).toBe("stale");
    expect(s.m.size).toBe(0);
  });
  it("expires after the TTL (and a clock-skewed future timestamp is rejected)", () => {
    const s = mem(); const k = "nq-draft:v1:u:quote:q";
    saveDraft(s, k, "h", 1, T0);
    expect(loadDraft(s, k, "h", T0 + DRAFT_TTL_MS + 1).status).toBe("expired");
    saveDraft(s, k, "h", 1, T0 + 10 * 60_000);
    expect(loadDraft(s, k, "h", T0).status).toBe("expired");
  });
  it("corrupt, wrong-version and invalid-shape entries are dropped, never thrown", () => {
    const s = mem(); const k = "k";
    s.setItem(k, "{not json"); expect(loadDraft(s, k, "h").status).toBe("invalid"); expect(s.m.size).toBe(0);
    s.setItem(k, JSON.stringify({ v: 2, base: "h", savedAt: Date.now(), data: 1 })); expect(loadDraft(s, k, "h").status).toBe("invalid");
    saveDraft(s, k, "h", "str"); expect(loadDraft(s, k, "h", Date.now(), (d): d is number => typeof d === "number").status).toBe("invalid");
  });
  it("oversized drafts are refused and any older copy removed", () => {
    const s = mem(); const k = "k";
    saveDraft(s, k, "h", "small", T0);
    expect(saveDraft(s, k, "h", "x".repeat(DRAFT_MAX_CHARS + 1), T0)).toBe(false);
    expect(s.m.size).toBe(0);
  });
  it("no storage / throwing storage degrades to no draft", () => {
    expect(saveDraft(null, "k", "h", 1)).toBe(false);
    expect(loadDraft(null, "k", "h").status).toBe("none");
    const bad: DraftStorage = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); }, removeItem: () => { throw new Error("x"); }, key: () => { throw new Error("x"); }, get length() { return 1; } };
    expect(saveDraft(bad, "k", "h", 1)).toBe(false);
    expect(loadDraft(bad, "k", "h").status).toBe("none");
    expect(() => { clearDraft(bad, "k"); clearAllDrafts(bad); }).not.toThrow();
  });
  it("clearAllDrafts removes only this app's drafts (sign-out on a shared computer)", () => {
    const s = mem();
    saveDraft(s, draftKey("u1", "quote", "q1"), "h", 1); saveDraft(s, draftKey("u1", "quote", "q2"), "h", 1); s.setItem("other", "keep");
    clearAllDrafts(s);
    expect([...s.m.keys()]).toEqual(["other"]);
    expect(DRAFT_PREFIX).toBe("nq-draft:v1:");
  });
});
