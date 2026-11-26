// BUDGET BASIS (pure; no I/O). NewQuip-APPROVED inputs that let a BUDGET evaluation price an item that has no Estimator-confirmed product and no usable Cin7 cost. It adds NO calculation of its own:
//   - a "default_sku" entry names the product the Budget uses (it then goes through the existing price-source path: Cin7 supplier cost, FX, freight, markup);
//   - a "rate" entry is a dated, approved ZAR figure. A COST-basis rate is aged by the EXISTING cost-age escalation (from the date of its evidence) and then passed through the SAME markup as everything else,
//     once; a SELLING-price rate is used as is and is NEVER aged or marked up.
// Nothing here is a default or a guess. The active register ships EMPTY. An entry is usable only when EVERY field below is present and valid, and the approval is independently evidenced:
//   - the evidence says what the number really is (a verified Cin7 supplier cost, a supplier quote, a product-owner confirmation, or HISTORICAL ERP data), its own date and, when it is historical or
//     unverified, the stated uncertainty. Historical ERP data can never be marked verified or presented as a current Cin7 supplier cost;
//   - the approval names an authorised approver (a NewQuip Manager or a formally designated commercial approver), the time, WHERE the approval is recorded (a signed document, email or ticket reference),
//     and the person who entered the record; the approver may not be the person who entered it. A developer editing the register is therefore never sufficient: the approval reference must point to a
//     record outside the code, and the pull request that adds the entry needs the named approver's own review (docs/newquip-budget-pricing-coverage.md).
// Budget evaluations only; a Budget line priced from here is always PROVISIONAL and never confirms a mapping.
import { isOptionalItemKey, type GrowerItemKey } from "./types";
import { escalationFor } from "../pricing/cost-escalation";
import { OWNER_APPROVED_BANDS, OWNER_APPROVED_MAX_AGE_YEARS } from "../pricing/commercial-settings";

export type BudgetRateBasis = "cost" | "selling_price";
export type EvidenceKind = "cin7_supplier_cost" | "supplier_quote" | "product_owner_confirmation" | "erp_historical";
export type ApproverRole = "NewQuip Manager" | "Designated commercial approver";

export interface BudgetEvidence {
  kind: EvidenceKind;
  /** Where the evidence can be inspected (report name and row, quote number, message reference). */
  reference: string;
  /** The date the underlying price / confirmation was true (YYYY-MM-DD): NOT the date it was loaded, imported or refreshed. */
  asOf: string;
  /** True only for a checked current figure. Historical ERP data is never verified. */
  verified: boolean;
  /** Required whenever the evidence is historical or unverified: what is uncertain about it. */
  uncertainty: string | null;
}
export interface BudgetApproval {
  approvedBy: string;
  role: ApproverRole;
  /** ISO instant. */
  approvedAt: string;
  /** Where the approval itself is recorded OUTSIDE the code (signed document, email or ticket reference). */
  reference: string;
  /** Who typed the record into the register. Must differ from approvedBy. */
  enteredBy: string;
}
interface BudgetBasisCommon {
  itemKey: GrowerItemKey;
  /** The specification this approval covers (for example the door size). */
  specification: string;
  /** Unit of measure the amount is per (each, set, metre, ...). */
  unit: string;
  evidence: BudgetEvidence;
  approval: BudgetApproval;
  /** ISO dates (YYYY-MM-DD), inclusive. */
  effectiveFrom: string;
  expiresOn: string;
}
export interface BudgetDefaultSku extends BudgetBasisCommon { kind: "default_sku"; sku: string }
export interface BudgetRate extends BudgetBasisCommon {
  kind: "rate";
  /** Rand per unit, ex VAT. Version 1 is ZAR only: a foreign-currency rate needs the existing FX settings and is refused until that is built and approved. */
  amount: number;
  currency: "ZAR";
  basis: BudgetRateBasis;
}
export type BudgetBasisEntry = BudgetDefaultSku | BudgetRate;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const nonEmpty = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;
const EVIDENCE_KINDS: readonly EvidenceKind[] = ["cin7_supplier_cost", "supplier_quote", "product_owner_confirmation", "erp_historical"];
const ROLES: readonly ApproverRole[] = ["NewQuip Manager", "Designated commercial approver"];

/** The ONLY items a Budget basis can apply to: the door and the optional equipment (the items that have no recommended product). Core items, the M75 and the packages are never priced from the register. */
export const budgetBasisEligible = (k: GrowerItemKey): boolean => k === "pvc_door" || isOptionalItemKey(k);

/** Tokens of a person's name / email in a comparable form: accents stripped, lower case, "Smith, Sean" reordered, the part before "@" of an email, punctuation ignored. */
const nameTokens = (raw: string): string[] => {
  const base = raw.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().split("@")[0];
  const flipped = base.includes(",") ? base.split(",").reverse().join(" ") : base;
  return flipped.split(/[^a-z]+/).filter(Boolean);
};
/** Can every token of `short` be matched to a DIFFERENT token of `long` (equal, or one is the other's initial)? Tries every assignment, so word order never matters. */
const covers = (short: string[], long: string[]): boolean => {
  const ok = (t: string, u: string) => t === u || (t.length === 1 && u.startsWith(t)) || (u.length === 1 && t.startsWith(u));
  const go = (i: number, used: boolean[]): boolean => {
    if (i === short.length) return true;
    for (let j = 0; j < long.length; j++) if (!used[j] && ok(short[i], long[j])) { used[j] = true; if (go(i + 1, used)) return true; used[j] = false; }
    return false;
  };
  return go(0, long.map(() => false));
};
/** True when two names plausibly name the same person: the same words in any order, one with first names reduced to initials ("A. Hill" / "Anton Hill"), or a compact email ("ahill@x" / "Anton Hill"). Deliberately cautious: it errs towards refusing. */
export const sameApprover = (a: string, b: string): boolean => {
  const x = nameTokens(a), y = nameTokens(b);
  if (x.length === 0 || y.length === 0) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (covers(short, long)) return true;
  // a compact single-word form (an email local part such as "ahill", "seansmith", "smithsean", "seans") built from the first and last words of the other name: initials or whole words, in either order
  const compact = (one: string[], other: string[]) => {
    if (one.length !== 1 || other.length < 2) return false;
    const f = other[0], l = other[other.length - 1];
    return [f + l, l + f, f[0] + l, l + f[0], f + l[0], l[0] + f].includes(one[0]);
  };
  return compact(x, y) || compact(y, x);
};
/** Names must be plain Latin letters (with spaces, full stops, hyphens, apostrophes, commas and an optional email form) so look-alike characters and digits cannot dodge the separation-of-duties check. */
const latinName = (s: string) => /^[A-Za-z][A-Za-z .,'@_-]*$/.test(s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim());

/** The reasons an entry cannot be used today. Empty = usable. Pure. */
export function budgetBasisProblems(e: BudgetBasisEntry, today: string): string[] {
  const p: string[] = [];
  if (!budgetBasisEligible(e.itemKey)) p.push("this item cannot be priced from the Budget register (only the door and the optional equipment can)");
  if (!nonEmpty(e.specification)) p.push("specification missing");
  if (!nonEmpty(e.unit)) p.push("unit of measure missing");
  if (!DAY.test(e.effectiveFrom) || !DAY.test(e.expiresOn)) p.push("effective / expiry dates missing");
  else if (today < e.effectiveFrom) p.push(`not effective until ${e.effectiveFrom}`);
  else if (today > e.expiresOn) p.push(`expired on ${e.expiresOn}`);

  const ev = e.evidence;
  if (!ev || !EVIDENCE_KINDS.includes(ev.kind)) p.push("evidence type missing");
  else {
    if (!nonEmpty(ev.reference)) p.push("evidence reference missing");
    if (!DAY.test(ev.asOf)) p.push("evidence date missing");
    else if (ev.asOf > today) p.push("evidence is dated in the future");
    if (ev.kind === "erp_historical" && ev.verified) p.push("historical ERP evidence cannot be marked verified");
    if ((ev.kind === "erp_historical" || !ev.verified) && !nonEmpty(ev.uncertainty)) p.push("the uncertainty of historical or unverified evidence must be stated");
  }

  const ap = e.approval;
  if (!ap) p.push("approval missing");
  else {
    if (!nonEmpty(ap.approvedBy)) p.push("approver missing");
    if (!ROLES.includes(ap.role)) p.push("approver must be a NewQuip Manager or a designated commercial approver");
    if (!nonEmpty(ap.approvedAt) || Number.isNaN(Date.parse(ap.approvedAt))) p.push("approval time missing");
    else if (DAY.test(today) && Date.parse(ap.approvedAt) > Date.parse(`${today}T23:59:59Z`)) p.push("approval time is in the future");
    if (!nonEmpty(ap.reference)) p.push("approval reference missing (the approval must be recorded outside the code)");
    if (!nonEmpty(ap.enteredBy)) p.push("the person who entered the record is missing");
    else if (nonEmpty(ap.approvedBy) && sameApprover(ap.approvedBy, ap.enteredBy)) p.push("the approver cannot be the person who entered the record");
    if ((nonEmpty(ap.approvedBy) && !latinName(ap.approvedBy)) || (nonEmpty(ap.enteredBy) && !latinName(ap.enteredBy))) p.push("names must use plain Latin letters only (no digits or look-alike characters)");
  }

  if (e.kind === "default_sku") { if (!nonEmpty(e.sku)) p.push("product code missing"); }
  else {
    if (!(Number.isFinite(e.amount) && e.amount > 0)) p.push("amount must be a positive number");
    if (e.currency !== "ZAR") p.push("only ZAR rates are supported");
    if (e.basis !== "cost" && e.basis !== "selling_price") p.push("cost or selling-price basis missing");
    // A cost-basis rate is aged by the existing cost-age policy from its EVIDENCE date; one older than the maximum age is refused, exactly as an automatic cost would be.
    if (e.basis === "cost" && ev && DAY.test(ev.asOf) && ev.asOf <= today && escalationFor(ev.asOf, today, OWNER_APPROVED_BANDS, OWNER_APPROVED_MAX_AGE_YEARS).status === "older_than_maximum") p.push(`cost evidence is older than the ${OWNER_APPROVED_MAX_AGE_YEARS}-year maximum age`);
  }
  return p;
}

/** The usable entry for an item (the latest approved when several are usable), or null. A default product wins over a rate: a costed product is the better evidence. Pure. */
export function usableBudgetBasis(register: readonly BudgetBasisEntry[] | undefined, itemKey: GrowerItemKey, today: string, specification?: string): BudgetBasisEntry | null {
  if (!budgetBasisEligible(itemKey)) return null;
  // When a specification is asked for (the door size), ONLY an entry approved for exactly that specification is usable.
  const ok = (register ?? []).filter((e) => e.itemKey === itemKey && (specification === undefined || e.specification === specification) && budgetBasisProblems(e, today).length === 0);
  const latest = (xs: BudgetBasisEntry[]) => xs.sort((a, b) => b.approval.approvedAt.localeCompare(a.approval.approvedAt))[0] ?? null;
  return latest(ok.filter((e) => e.kind === "default_sku")) ?? latest(ok.filter((e) => e.kind === "rate"));
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** The unit SELLING price (ex VAT) a rate yields. A SELLING-price rate is returned unchanged (never aged, never marked up). A COST-basis rate is aged by the existing cost-age escalation from the date of its
 *  evidence and then marked up ONCE by the existing markup (basis points on cost). null = cannot be priced (a cost-basis rate while no markup is set, or evidence over-age / undated). */
export function budgetRateSellingPrice(rate: BudgetRate, markupBps: number | null, today: string): { unitPriceExVat: number; markedUp: boolean; escalationBps: number } | null {
  if (rate.basis === "selling_price") return { unitPriceExVat: round2(rate.amount), markedUp: false, escalationBps: 0 };
  if (markupBps == null) return null;
  const esc = escalationFor(rate.evidence.asOf, today, OWNER_APPROVED_BANDS, OWNER_APPROVED_MAX_AGE_YEARS);
  if (esc.status !== "ok") return null;
  const aged = rate.amount * (esc.factorBps / 10000);
  return { unitPriceExVat: round2(aged * (1 + markupBps / 10000)), markedUp: true, escalationBps: esc.escalationBps };
}

/** Rep-safe wording for a line priced from a budget basis: never the rate, cost, basis or evidence. */
export const BUDGET_BASIS_PLAIN = "Provisional: priced from NewQuip's current standard allowance for this item, so it may change once the product and specification are confirmed.";
