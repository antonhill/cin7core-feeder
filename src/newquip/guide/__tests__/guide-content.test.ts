import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { GUIDE_LESSONS, GLOSSARY, lessonBySlug, neighbours, pathLessons } from "../content";
import { JOURNEY } from "../content/journey";
import { GUIDE_SHOTS } from "../shots";
import { blockText, buildSearchIndex, searchGuide } from "../search";
import { SECTION_LABEL } from "../types";
import { escalateCostE7, escalationFor } from "@/newquip/pricing/cost-escalation";
import { cost7, landedCentsE7, micro, withMarkupBps, pct2, divRound } from "@/newquip/pricing/model/money";

const allText = (): string =>
  GUIDE_LESSONS.map((l) => [l.title, l.summary, l.keywords.join(" "), l.blocks.map(blockText).join(" ")].join(" ")).join("\n") + GLOSSARY.map((g) => `${g.term} ${g.meaning}`).join("\n");

describe("User Guide content integrity", () => {
  it("has unique slugs and every lesson has a body", () => {
    const slugs = GUIDE_LESSONS.map((l) => l.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const l of GUIDE_LESSONS) expect(l.blocks.length, l.slug).toBeGreaterThan(0);
  });

  it("every internal link, journey stage and neighbour resolves", () => {
    for (const l of GUIDE_LESSONS) for (const b of l.blocks) if (b.t === "links") for (const x of b.items) expect(lessonBySlug(x.slug), `${l.slug} -> ${x.slug}`).toBeDefined();
    for (const j of JOURNEY) expect(lessonBySlug(j.slug), j.slug).toBeDefined();
    expect(neighbours(GUIDE_LESSONS[0].slug).prev).toBeNull();
    expect(neighbours(GUIDE_LESSONS[1].slug).prev?.slug).toBe(GUIDE_LESSONS[0].slug);
  });

  it("every shot a lesson uses is registered, and every registered shot is a real file", () => {
    const ids = new Set(GUIDE_SHOTS.map((s) => s.id));
    for (const l of GUIDE_LESSONS) for (const b of l.blocks) if (b.t === "shot") expect(ids.has(b.id), `${l.slug}: ${b.id}`).toBe(true);
    for (const s of GUIDE_SHOTS) expect(existsSync(join(process.cwd(), "public/newquip-grower/guide-assets", s.file)), s.file).toBe(true);
    const used = new Set(GUIDE_LESSONS.flatMap((l) => l.blocks.filter((b) => b.t === "shot").map((b) => (b as { id: string }).id)));
    for (const s of GUIDE_SHOTS) expect(used.has(s.id), `unused shot ${s.id}`).toBe(true);
  });

  it("contains no internal-tooling or AI references", () => {
    const text = allText();
    for (const banned of [/claude/i, /anthropic/i, /\bAI\b/, /assistant/i, /github/i, /vercel/i, /\bprompt/i, /supabase/i, /subagent/i, /worktree/i]) expect(text, String(banned)).not.toMatch(banned);
    for (const s of GUIDE_SHOTS) expect(`${s.alt} ${s.caption}`).not.toMatch(/claude|anthropic|github|vercel/i);
  });

  it("discloses no restricted commercial policy or supplier detail", () => {
    // Hashed denylist (SHA-256 of single lower-case tokens): real supplier names, real policy figures and an internal name are kept out of the repository, including this file.
    const DENY = new Set([
      "05f4b67d65f15eeea2516c1adc162d353bcb075092cc4a1dc029bf38be891b38",
      "11875c0bae16b76ea6a0bae85e8db480b81de8b0720a879bf71709817b118e7d",
      "23886e23bf2eae765a6b86b44abf1b5024aeb379a0e45654111780590b4ee171",
      "2d1d92b1f4cc7fd3ef215da88c2826ab3ec2ced95b388b395b658c41b349c90e",
      "2e1adffac68c77ee2a052d257cda9693ef349b282d261156f3e4f9399cf29ef0",
      "7b7f11b4fd511b17a7bece90167bd95d05854dc4a8e7a689e5dc3f311a91f4b7",
      "98132b0f72f8bfa23100b2853a8d63761c17ec57e372b059b2f489f1276a2b71",
      "9f0e787f95cbd2f66f1e46e720ad917e5e2ccbf6336a4e7bbc9367db78b99a5f",
      "be86c8ca69d0712b75b87ed01b2db07aa5b1c61a46679ff75d6b8f64efe074ec",
      "c2f2d91c2a31954e293fe038488e1a411a2fd90c0196c126c918852e3e80a7d9",
      "cdc670392ad038f0716f04f261f966881c536fa8529e970e19b9b8b86c373151",
      "d80dc0a202c84e8fa4dcb3023143dff30cb5d99dae8c4731d84dab05aab52efb",
    ]);
    const tokens = allText().toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
    const hits = tokens.filter((t) => DENY.has(createHash("sha256").update(t).digest("hex")));
    expect(hits).toEqual([]);
    expect(allText()).not.toMatch(/owner-approved/i);
  });

  it("covers every required quick task guide and role path", () => {
    expect(GUIDE_LESSONS.filter((l) => l.section === "quick")).toHaveLength(20);
    for (const r of ["rep", "estimator", "manager"] as const) expect(pathLessons(r).length, r).toBeGreaterThan(5);
    for (const t of ["landed cost", "spot rate", "forward rate", "freight factor", "markup", "margin", "verified cost", "advanced sale", "milestone", "progress claim", "partial claim", "fulfilment", "escalation"]) expect(GLOSSARY.some((g) => g.term.toLowerCase().includes(t)), t).toBe(true);
  });

  it("search finds lessons by title, keyword and body, and requires every word", () => {
    const idx = buildSearchIndex(GUIDE_LESSONS, (s) => SECTION_LABEL[s]);
    expect(searchGuide(idx, "exchange rate")[0].slug).toMatch(/fx|exchange/);
    expect(searchGuide(idx, "markup").length).toBeGreaterThan(0);
    expect(searchGuide(idx, "partial claim")[0].slug).toBeDefined();
    expect(searchGuide(idx, "zzzzqq")).toEqual([]);
    expect(searchGuide(idx, "x")).toEqual([]);
  });
});

// The guide's worked examples use ILLUSTRATIVE figures (the real commercial settings are restricted). They are recomputed here with the application's own calculation code, so the
// guide cannot drift from the implementation. The bands are passed explicitly: no real commercial setting appears in this file.
const BANDS = [{ fromYears: 0, toYears: 1, rateBps: 0 }, { fromYears: 1, toYears: 2, rateBps: 800 }, { fromYears: 2, toYears: 3, rateBps: 1200 }, { fromYears: 3, toYears: null, rateBps: 1600 }];
const MAX_YEARS = 4;
describe("User Guide worked examples match the implemented calculations", () => {
  const cents = (rand: string) => Math.round(Number(rand) * 100);
  it("Example 1: current Cin7 cost, R2 000 at 25% markup, four units", () => {
    const landed = landedCentsE7(cost7("2000"), micro("1"), micro("1"));
    expect(landed).toBe(cents("2000"));
    const sell = withMarkupBps(landed, 2500);
    expect(sell).toBe(cents("2500"));
    expect(sell * 4).toBe(cents("10000"));
    expect(pct2(sell - landed, sell)).toBe(20);
    expect(pct2(sell - landed, landed)).toBe(25);
  });
  it("Example 2: historical cost last supplied 2023-05-17, priced 2026-11-17", () => {
    const e = escalationFor("2023-05-17", "2026-11-17", BANDS, MAX_YEARS);
    expect(e).toMatchObject({ status: "ok", ageDays: 1280, escalationBps: 2807, factorBps: 12807 });
    if (e.status !== "ok") return;
    const escalated = escalateCostE7(cost7("10000"), e.factorBps);
    expect(escalated).toBe(cost7("12807"));
    const landed = landedCentsE7(escalated, micro("1"), micro("1.10"));
    expect(landed).toBe(cents("14087.70"));
    const sell = withMarkupBps(landed, 2500);
    expect(sell).toBe(cents("17609.63"));
    expect(sell - landed).toBe(cents("3521.93"));
    expect(pct2(sell - landed, sell)).toBe(20);
  });
  it("Example 3: 100 EUR at 21.00, freight 1.10, markup 25%", () => {
    const landed = landedCentsE7(cost7("100"), micro("21"), micro("1.10"));
    expect(landed).toBe(cents("2310"));
    const sell = withMarkupBps(landed, 2500);
    expect(sell).toBe(cents("2887.50"));
    expect(sell - landed).toBe(cents("577.50"));
    expect(pct2(sell - landed, sell)).toBe(20);
  });
  it("EUR derived from the feed: 18.90 / 0.90 = 21.000000", () => {
    expect(Number(divRound(BigInt(18_900_000) * BigInt(1_000_000), BigInt(900_000)))).toBe(21_000_000);
  });
  it("escalation boundary table for the illustrative bands", () => {
    const at = (d: number) => {
      const day = new Date(Date.UTC(2026, 10, 17) - d * 86_400_000).toISOString().slice(0, 10);
      return escalationFor(day, "2026-11-17", BANDS, MAX_YEARS);
    };
    const bps = (d: number) => { const r = at(d); return r.status === "ok" ? r.escalationBps : r.status; };
    expect([365, 366, 730, 731, 1096, 1461].map(bps)).toEqual([0, 2, 799, 802, 2001, 3600]);
    expect(bps(1462)).toBe("older_than_maximum");
  });
  it("25% markup is a 20% margin, and a 25% margin needs a 33.33% markup", () => {
    expect(pct2(25, 125)).toBe(20);
    expect(pct2(2500, 7500)).toBe(33.33);
  });
});

describe("User Guide route is on the NewQuip-only allowlist", () => {
  it("is reachable under /newquip-grower", async () => {
    const { isNewquipOnlyPathAllowed } = await import("@/newquip/route-guard");
    expect(isNewquipOnlyPathAllowed("/newquip-grower/guide")).toBe(true);
    expect(isNewquipOnlyPathAllowed("/newquip-grower/guide/start-here")).toBe(true);
    for (const s of GUIDE_SHOTS) expect(isNewquipOnlyPathAllowed(`/newquip-grower/guide-assets/${s.file}`), s.file).toBe(true);
  });
  it("readFileSync sanity: screenshots are not empty", () => {
    for (const s of GUIDE_SHOTS) expect(readFileSync(join(process.cwd(), "public/newquip-grower/guide-assets", s.file)).length).toBeGreaterThan(5_000);
  });
});
