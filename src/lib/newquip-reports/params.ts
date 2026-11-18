// URL query -> report filters. Pure; every value is validated or dropped, so a crafted query string can only narrow a report the viewer is already allowed to see.
import type { Filters } from "./ops";
import { OUTSTANDING_CATEGORIES } from "./ops";
import type { CostingFilters } from "./service-types";

type Raw = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] ?? "" : v ?? "").trim().slice(0, 120);
const date = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
const oneOf = <T extends string>(v: string, allowed: readonly T[]): T | undefined => (allowed as readonly string[]).includes(v) ? (v as T) : undefined;

export function parseFilters(raw: Raw): CostingFilters {
  const page = Number.parseInt(one(raw.page), 10);
  return {
    from: date(one(raw.from)), to: date(one(raw.to)), creator: one(raw.creator) || undefined, assignee: one(raw.assignee) || undefined, stage: one(raw.stage) || undefined, status: one(raw.status) || undefined,
    customer: one(raw.customer) || undefined, action: oneOf(one(raw.action), OUTSTANDING_CATEGORIES), q: one(raw.q) || undefined,
    view: oneOf(one(raw.view), ["mine", "all", "over3", "over7"] as const), sort: oneOf(one(raw.sort), ["value", "created", "age", "urgent"] as const), dir: oneOf(one(raw.dir), ["asc", "desc"] as const),
    page: Number.isFinite(page) && page > 0 ? page : 1,
    basis: oneOf(one(raw.basis), ["APPROVED", "VERIFIED", "COSTED_UNVERIFIED", "INDICATIVE", "UNAVAILABLE"] as const), exceptionsOnly: one(raw.exceptions) === "1" || undefined,
    csort: oneOf(one(raw.csort), ["margin", "selling", "ref"] as const),
  };
}
export type { Filters };
