import type { GuideLesson, GuideRole } from "../types";
import { SECTION_ORDER } from "../types";
import { START } from "./start";
import { REP } from "./rep";
import { ESTIMATOR } from "./estimator";
import { MANAGER } from "./manager";
import { POST_QUOTE } from "./post-quote";
import { QUICK } from "./quick";
import { TROUBLESHOOTING } from "./troubleshooting";
import { REFERENCE } from "./reference";

export { GLOSSARY } from "./reference";

const ALL: GuideLesson[] = [...START, ...REP, ...ESTIMATOR, ...MANAGER, ...POST_QUOTE, ...QUICK, ...TROUBLESHOOTING, ...REFERENCE];

/** Lessons in reading order: by section, then in the order written. */
export const GUIDE_LESSONS: GuideLesson[] = SECTION_ORDER.flatMap((s) => ALL.filter((l) => l.section === s));

export const GLOSSARY_PATH_NOTE = "Choosing a path only changes which lessons you read first. It never changes your permissions.";

export const lessonBySlug = (slug: string): GuideLesson | undefined => GUIDE_LESSONS.find((l) => l.slug === slug);

export function neighbours(slug: string): { prev: GuideLesson | null; next: GuideLesson | null } {
  const i = GUIDE_LESSONS.findIndex((l) => l.slug === slug);
  return { prev: i > 0 ? GUIDE_LESSONS[i - 1] : null, next: i >= 0 && i < GUIDE_LESSONS.length - 1 ? GUIDE_LESSONS[i + 1] : null };
}

/** The lessons of a role's learning path: start-here first, then that role's section, then lessons tagged for the role elsewhere. */
export function pathLessons(role: GuideRole): GuideLesson[] {
  const own = GUIDE_LESSONS.filter((l) => l.section === role);
  const rest = GUIDE_LESSONS.filter((l) => l.section !== role && l.roles.includes(role) && !["quick", "troubleshooting", "reference"].includes(l.section));
  const start = GUIDE_LESSONS.find((l) => l.slug === "start-here");
  return [...(start ? [start] : []), ...own.filter((l) => l.slug !== "start-here"), ...rest.filter((l) => l.slug !== "start-here")];
}
