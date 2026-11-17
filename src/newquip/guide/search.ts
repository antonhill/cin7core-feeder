import type { GuideBlock, GuideLesson } from "./types";

/** Plain text of one block, used only for searching. */
export function blockText(b: GuideBlock): string {
  switch (b.t) {
    case "p":
    case "h":
      return b.text;
    case "steps":
    case "list":
      return b.items.join(" ");
    case "callout":
      return `${b.title ?? ""} ${b.text}`;
    case "table":
      return `${b.head.join(" ")} ${b.rows.flat().join(" ")}`;
    case "formula":
      return `${b.label} ${b.lines.join(" ")}`;
    case "example":
      return `${b.title} ${b.note ?? ""} ${b.rows.flat().join(" ")} ${b.result}`;
    case "facts":
      return `${b.who} ${b.where} ${b.next}`;
    default:
      return "";
  }
}

export type SearchEntry = { slug: string; title: string; summary: string; section: string; keywords: string; body: string };

export function buildSearchIndex(lessons: GuideLesson[], sectionLabel: (s: GuideLesson["section"]) => string): SearchEntry[] {
  return lessons.map((l) => ({
    slug: l.slug,
    title: l.title,
    summary: l.summary,
    section: sectionLabel(l.section),
    keywords: l.keywords.join(" "),
    body: l.blocks.map(blockText).join(" "),
  }));
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}%\s]/gu, " ");

/** Every query word must appear somewhere; title hits outrank keyword hits outrank summary hits outrank body hits. Pure. */
export function searchGuide(index: SearchEntry[], query: string, limit = 12): SearchEntry[] {
  const words = norm(query).split(/\s+/).filter((w) => w.length > 0);
  if (query.trim().length < 2 || words.length === 0) return [];
  const scored: Array<{ e: SearchEntry; score: number }> = [];
  for (const e of index) {
    const t = norm(e.title), k = norm(e.keywords), s = norm(e.summary), b = norm(e.body);
    let score = 0, ok = true;
    for (const w of words) {
      const hit = (t.includes(w) ? 8 : 0) + (k.includes(w) ? 5 : 0) + (s.includes(w) ? 3 : 0) + (b.includes(w) ? 1 : 0);
      if (hit === 0) { ok = false; break; }
      score += hit;
    }
    if (ok) scored.push({ e, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.e.title.localeCompare(b.e.title)).slice(0, limit).map((x) => x.e);
}
