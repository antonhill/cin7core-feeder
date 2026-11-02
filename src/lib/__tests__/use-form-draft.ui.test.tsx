// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { useFormDraft } from "../use-form-draft";
import { draftKey, loadDraft, saveDraft, type DraftStorage } from "../form-draft";

function mem(): DraftStorage & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); }, key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
}
type Api = ReturnType<typeof useFormDraft<string>>;
const holder: { api: Api } = { api: undefined as unknown as Api };
// The latest hook result is published to the test through a mutable holder.
function Host(p: { storage: DraftStorage; base: string | null; dirty: boolean; value: string; user?: string | null }) {
  const result = useFormDraft<string>({ kind: "quote", recordId: "q1", base: p.base, dirty: p.dirty, value: p.value, storage: p.storage, getUserId: async () => (p.user === undefined ? "u1" : p.user), delayMs: 0 });
  useEffect(() => { holder.api = result; });
  return null;
}
// Several turns: the async user lookup resolves outside the first act, so its re-render and effects land on a later one.
const flush = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };
afterEach(cleanup);

describe("useFormDraft", () => {
  it("persists while dirty, under this user's key, and clears when dirty returns to false (saved/cancelled)", async () => {
    const s = mem();
    const { rerender } = render(<Host storage={s} base="h1" dirty={false} value="a" />);
    await flush();
    expect(s.m.size).toBe(0);
    rerender(<Host storage={s} base="h1" dirty value="edit" />);
    await flush();
    expect(loadDraft(s, draftKey("u1", "quote", "q1"), "h1")).toMatchObject({ status: "fresh", data: "edit" });
    rerender(<Host storage={s} base="h1" dirty={false} value="edit" />);
    await flush();
    expect(s.m.size).toBe(0);
  });
  it("offers a fresh earlier draft once; restore returns it and removes it; discard removes it", async () => {
    const s = mem(); saveDraft(s, draftKey("u1", "quote", "q1"), "h1", "earlier");
    render(<Host storage={s} base="h1" dirty={false} value="server" />);
    await flush();
    expect(holder.api.restorable?.data).toBe("earlier");
    let got: string | null = null; act(() => { got = holder.api.restore(); });
    expect(got).toBe("earlier"); expect(s.m.size).toBe(0); expect(holder.api.restorable).toBeNull();
    saveDraft(s, draftKey("u1", "quote", "q1"), "h1", "again");
    cleanup(); render(<Host storage={s} base="h1" dirty={false} value="server" />);
    await flush();
    act(() => holder.api.discard());
    expect(s.m.size).toBe(0); expect(holder.api.restorable).toBeNull();
  });
  it("a draft from another user, or based on an older server version, is never offered", async () => {
    const s = mem(); saveDraft(s, draftKey("u2", "quote", "q1"), "h1", "theirs"); saveDraft(s, draftKey("u1", "quote", "q1"), "OLD", "stale");
    render(<Host storage={s} base="h1" dirty={false} value="x" />);
    await flush();
    expect(holder.api.restorable).toBeNull(); expect(holder.api.dropped).toBe("stale");
    expect(s.getItem(draftKey("u2", "quote", "q1"))).not.toBeNull(); // the other user's is untouched
    act(() => holder.api.dismissDropped()); expect(holder.api.dropped).toBeNull();
  });
  it("writes nothing and reads nothing while the record is loading (base null) or the user is unknown", async () => {
    const s = mem(); saveDraft(s, draftKey("u1", "quote", "q1"), "h1", "earlier");
    const { rerender } = render(<Host storage={s} base={null} dirty value="typing" />);
    await flush();
    expect(holder.api.restorable).toBeNull(); expect(loadDraft(s, draftKey("u1", "quote", "q1"), "h1")).toMatchObject({ status: "fresh", data: "earlier" }); // untouched
    cleanup(); const s2 = mem();
    render(<Host storage={s2} base="h1" dirty value="typing" user={null} />);
    await flush();
    expect(s2.m.size).toBe(0);
    void rerender;
  });
  it("does not clear an unrestored draft just because the form mounted clean", async () => {
    const s = mem(); saveDraft(s, draftKey("u1", "quote", "q1"), "h1", "earlier");
    render(<Host storage={s} base="h1" dirty={false} value="server" />);
    await flush();
    expect(s.m.size).toBe(1);
  });
});
