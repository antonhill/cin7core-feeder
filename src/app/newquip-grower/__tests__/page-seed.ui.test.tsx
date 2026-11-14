// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement, StrictMode, useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The bundled page-load seed (bundle-seed.ts), exercised through the REAL DeliveryPanel and AcceptancePanel (only the server actions they call are mocked): a fresh seed is used with
// no separate read; an expired one, or one whose server read is old, is ignored; a remount never reuses a consumed seed; a seed bound to another quotation version, organisation or viewer is
// never offered; a failed part is read again the old way while the good part still seeds.
const delivery = vi.fn(); const docs = vi.fn();
vi.mock("../delivery-actions", () => ({ getQuoteDeliveryAction: (...a: unknown[]) => delivery(...a), sendQuoteToCustomerAction: vi.fn(), retryQuoteSendAction: vi.fn(), recordCustomerResponseAction: vi.fn(), reviewCustomerResponseAction: vi.fn(), revokeResponseLinksAction: vi.fn() }));
vi.mock("../document-actions", () => ({ getQuoteDocumentsAction: (...a: unknown[]) => docs(...a), issueQuoteDocumentAction: vi.fn() }));
import { DeliveryPanel } from "../[id]/DeliveryPanel";
import { AcceptancePanel } from "../[id]/AcceptancePanel";
import { SEED_MAX_AGE_MS, seedFresh, seedIfBound, seedKeyOf, type BundleSeed } from "../[id]/bundle-seed";

const VIEW: any = { available: true, canSend: true, canRecord: true, canReview: true, requiresAcceptance: true, accepted: false, status: "SENT_TO_CUSTOMER", statusLabel: "Sent to the customer", latestDocumentId: "d1", links: { state: "NONE", expiresOn: null }, policy: { production: false, restricted: false, allowlist: [], emailConfigured: true, productionEmailOff: false }, contactEmails: [], defaultTo: "rep@sparkconsulting.co.za", sends: [], responses: [], responseContacts: [], deliveryContact: null, portal: false };
const DOCS: any = { available: true, canIssue: true, blockers: [], documents: [{ id: "d1", revision: 1, version: 1, issuedAt: "2026-11-05T08:00:00Z", issuedBy: "rep", byteSize: 2048, contentHash: "abcdef0123456789" }] };
const NOW = Date.parse("2026-11-14T10:00:00Z");
const QUOTE = { id: "q1", updated_at: "2026-11-14T09:00:00Z", project_id: null, revision: 1, org_id: "org-nq" };
const REP = { roles: ["rep"], canViewCommercials: false };
const KEY = seedKeyOf(QUOTE, REP);
const seed = (over: Partial<BundleSeed> = {}): BundleSeed => ({ key: KEY, at: NOW, readAt: NOW, delivery: { ok: true, data: VIEW }, documents: { ok: true, data: DOCS }, gateUsed: false, ...over });

/** Mirrors the page's handling: the panel gets the seed only while it is bound to the current key, and asks the page to drop it once used. */
function Host({ initial, keyNow = KEY, panel = "delivery" }: { initial: BundleSeed | null; keyNow?: string; panel?: "delivery" | "acceptance" }) {
  const [s, setS] = useState<BundleSeed | null>(initial);
  const [shown, setShown] = useState(true);
  const drop = useCallback(() => setS(null), []);
  return createElement("div", null,
    createElement("button", { onClick: () => setShown((x) => !x) }, "toggle"),
    shown ? (panel === "delivery"
      ? createElement(DeliveryPanel, { quoteId: "q1", contractCents: 100000000, onGate: GATE, section: "quotation", seed: seedIfBound(s, keyNow), onSeedUsed: drop } as never)
      : createElement(AcceptancePanel, { quoteId: "q1", onGate: GATE, seed: seedIfBound(s, keyNow), onSeedUsed: drop } as never)) : null);
}
// the page passes a STABLE onGate (applyGate is a useCallback); an unstable one would re-run the panels' load effect on every render, seed or no seed
const GATE = vi.fn();
const sendButton = () => screen.findByRole("button", { name: /Send quotation to customer/ });

beforeEach(() => {
  delivery.mockReset().mockResolvedValue({ ok: true, data: VIEW });
  docs.mockReset().mockResolvedValue({ ok: true, data: DOCS });
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("a fresh seed is used with no separate read", () => {
  it("DeliveryPanel renders from the seed and neither the documents nor the delivery action is called", async () => {
    render(createElement(Host, { initial: seed() }));
    expect(await sendButton()).toBeTruthy();
    expect(delivery).not.toHaveBeenCalled();
    expect(docs).not.toHaveBeenCalled();
  });
  it("AcceptancePanel renders from the seed and the delivery action is not called", async () => {
    render(createElement(Host, { initial: seed(), panel: "acceptance" }));
    expect((await screen.findAllByText("Customer response")).length).toBeGreaterThan(0);
    expect(delivery).not.toHaveBeenCalled();
  });
  it("the panel reports that it has used the seed exactly once", async () => {
    const used = vi.fn();
    render(createElement(DeliveryPanel, { quoteId: "q1", contractCents: 1, onGate: GATE, section: "quotation", seed: seed(), onSeedUsed: used } as never));
    await sendButton();
    expect(used).toHaveBeenCalledTimes(1);
  });
});

describe("an old seed is ignored: the panel reads as it always did", () => {
  it("expired: more than 30 s after it arrived", async () => {
    const s = seed();
    vi.setSystemTime(NOW + SEED_MAX_AGE_MS + 1000);
    render(createElement(Host, { initial: s }));
    await sendButton();
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(docs).toHaveBeenCalledTimes(1);
  });
  it("still valid just inside the window", () => {
    expect(seedFresh(seed(), NOW + SEED_MAX_AGE_MS - 1)).toBe(true);
    expect(seedFresh(seed(), NOW + SEED_MAX_AGE_MS)).toBe(false);
  });
  it("measured from the SERVER read time: a seed the server read 31 s ago is expired even if it only just arrived", async () => {
    render(createElement(Host, { initial: seed({ readAt: NOW - SEED_MAX_AGE_MS - 1000, at: NOW }) }));
    await sendButton();
    expect(delivery).toHaveBeenCalledTimes(1);
  });
  it("and a client clock that is BEHIND the server's can never extend it (arrival time bounds it too)", () => {
    expect(seedFresh(seed({ readAt: NOW + 3_600_000, at: NOW - SEED_MAX_AGE_MS - 1 }), NOW)).toBe(false);
  });
});

describe("remount", () => {
  it("unmount then mount: the used seed was dropped, so the second mount reads fresh", async () => {
    render(createElement(Host, { initial: seed() }));
    await sendButton();
    expect(delivery).not.toHaveBeenCalled();
    await act(async () => { screen.getByRole("button", { name: "toggle" }).click(); }); // unmount
    await act(async () => { screen.getByRole("button", { name: "toggle" }).click(); }); // mount again
    await sendButton();
    await waitFor(() => expect(delivery).toHaveBeenCalledTimes(1));
    expect(docs).toHaveBeenCalledTimes(1);
  });
  it("StrictMode (development double effects): renders the seeded data and reads at most once more, never zero-then-stale", async () => {
    render(createElement(StrictMode, null, createElement(Host, { initial: seed() })));
    expect(await sendButton()).toBeTruthy();
    expect(delivery.mock.calls.length).toBeLessThanOrEqual(1);
    expect(docs.mock.calls.length).toBeLessThanOrEqual(1);
  });
  it("a seed is not reused after the page dropped it, even though it is still fresh", async () => {
    const s = seed();
    render(createElement(Host, { initial: s }));
    await sendButton();
    cleanup();
    render(createElement(Host, { initial: null }));
    await sendButton();
    await waitFor(() => expect(delivery).toHaveBeenCalledTimes(1));
  });
});

describe("a seed bound to something else is never used", () => {
  const base = { ...QUOTE };
  it("different quotation, update time, linked Project or revision: different key, seed not offered", () => {
    const s = seed();
    for (const q of [{ ...base, id: "q2" }, { ...base, updated_at: "2026-11-14T09:00:01Z" }, { ...base, project_id: "p1" }, { ...base, revision: 2 }]) {
      expect(seedKeyOf(q, REP)).not.toBe(KEY);
      expect(seedIfBound(s, seedKeyOf(q, REP))).toBeNull();
    }
  });
  it("a different organisation: different key, seed not offered (org binding)", () => {
    expect(seedKeyOf({ ...base, org_id: "org-other" }, REP)).not.toBe(KEY);
    expect(seedIfBound(seed(), seedKeyOf({ ...base, org_id: "org-other" }, REP))).toBeNull();
  });
  it("a different viewer (roles or cost visibility, e.g. after a role switch): different key, seed not offered (viewer binding)", () => {
    for (const v of [{ roles: ["estimator"], canViewCommercials: false }, { roles: ["rep", "manager"], canViewCommercials: false }, { roles: ["rep"], canViewCommercials: true }]) {
      expect(seedKeyOf(QUOTE, v)).not.toBe(KEY);
      expect(seedIfBound(seed(), seedKeyOf(QUOTE, v))).toBeNull();
    }
    expect(seedKeyOf(QUOTE, { roles: ["rep", "manager"], canViewCommercials: false })).toBe(seedKeyOf(QUOTE, { roles: ["manager", "rep"], canViewCommercials: false })); // role order is irrelevant
  });
  it("an unknown key (the page has not loaded the quotation) never matches", () => {
    expect(seedIfBound(seed(), "")).toBeNull();
    expect(seedIfBound(null, KEY)).toBeNull();
  });
  it("through the panel: the page offering a seed for another quotation version means the panel reads for itself", async () => {
    render(createElement(Host, { initial: seed(), keyNow: seedKeyOf({ ...QUOTE, updated_at: "2026-11-14T09:30:00Z" }, REP) }));
    await sendButton();
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(docs).toHaveBeenCalledTimes(1);
  });
});

describe("partial failure: the failed part is read the old way, the good part still seeds", () => {
  it("documents failed, delivery fine: the DeliveryPanel is not seeded (it needs both) and reads both, with its normal error handling", async () => {
    render(createElement(Host, { initial: seed({ documents: { ok: false, error: "documents read failed" } }) }));
    await sendButton();
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(docs).toHaveBeenCalledTimes(1);
  });
  it("delivery failed: the DeliveryPanel reads both; the real read's error is shown exactly as before", async () => {
    delivery.mockResolvedValue({ ok: false, error: "Could not load the send history." });
    render(createElement(Host, { initial: seed({ delivery: { ok: false, error: "boom" } }) }));
    expect(await screen.findByText(/Could not load the send history|Loading the quotation PDF/)).toBeTruthy();
    expect(delivery).toHaveBeenCalledTimes(1);
  });
  it("the AcceptancePanel needs only the delivery part: a failed documents part does not stop it using the seed", async () => {
    render(createElement(Host, { initial: seed({ documents: { ok: false, error: "x" } }), panel: "acceptance" }));
    expect((await screen.findAllByText("Customer response")).length).toBeGreaterThan(0);
    expect(delivery).not.toHaveBeenCalled();
  });
});
