// NewQuip User Guide: the structured content model. Pure data + types, no server-only imports, so the pages, the client search and the tests share ONE source.
export type GuideRole = "rep" | "estimator" | "manager";

export const ROLE_LABEL: Record<GuideRole, string> = { rep: "Sales Representative", estimator: "Estimator", manager: "Manager" };

export type GuideSection =
  | "start"
  | "rep"
  | "estimator"
  | "manager"
  | "post-quote"
  | "quick"
  | "troubleshooting"
  | "reference";

export const SECTION_LABEL: Record<GuideSection, string> = {
  start: "Start here",
  rep: "Sales Representative",
  estimator: "Estimator",
  manager: "Manager",
  "post-quote": "Projects, Claims and Cin7",
  quick: "Quick task guides",
  troubleshooting: "Troubleshooting",
  reference: "Reference",
};

export const SECTION_ORDER: GuideSection[] = ["start", "rep", "estimator", "manager", "post-quote", "quick", "troubleshooting", "reference"];

export type CalloutTone = "tip" | "warning" | "note";

export type GuideBlock =
  | { t: "p"; text: string }
  | { t: "h"; text: string }
  | { t: "steps"; items: string[] }
  | { t: "list"; items: string[] }
  | { t: "callout"; tone: CalloutTone; title?: string; text: string }
  | { t: "table"; head: string[]; rows: string[][]; caption?: string }
  | { t: "formula"; label: string; lines: string[] }
  | { t: "example"; title: string; note?: string; rows: Array<[string, string]>; result: string }
  | { t: "facts"; who: string; where: string; next: string }
  | { t: "shot"; id: string }
  | { t: "diagram"; id: "journey" | "costing" }
  | { t: "links"; items: Array<{ slug: string; label: string }> };

export type GuideLesson = {
  slug: string;
  title: string;
  summary: string;
  section: GuideSection;
  /** Roles this lesson is part of a learning path for (a lesson may belong to several). */
  roles: GuideRole[];
  keywords: string[];
  blocks: GuideBlock[];
};

export type GlossaryEntry = { term: string; meaning: string };

/** A real screenshot taken from the connected UAT application. A lesson may only show a shot that appears here, so no placeholder image can ship. */
export type GuideShot = { id: string; file: string; alt: string; caption: string; capturedAs: GuideRole | "signed-out"; capturedOn: string; width: number; height: number };
