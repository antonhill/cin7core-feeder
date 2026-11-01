// Which Cin7 accounts the Toolbox lets a manager PICK as the revenue account of a Project's Sale. Pure.
//
// Evidence (docs/projects-poc/P5-design-multi-invoice-write.md): Cin7 accepted an Additional Charge posted to the revenue account "200: Sales".
// That is the only account class with proof, so only ordinary, active REVENUE accounts are selectable.
// Balance-sheet liability accounts (for example a customer-deposit / unearned-revenue account) are shown, clearly marked, but NOT selectable until a
// controlled Cin7 proof shows that Cin7 accepts them on an invoice charge (docs/projects-poc/uat-019-020-cin7-billing-vs-fulfilment.md, test T7).
// Cin7's special accounts (SystemAccount set, e.g. Accounts receivable/payable) and inactive accounts are never selectable.
// An account whose class cannot be read is not guessed at: it is shown as unclassified and is not selectable.

import type { Cin7Account } from "@/cin7/reference-lookups";

export type AccountGroup = "REVENUE" | "LIABILITY" | "SYSTEM" | "INACTIVE" | "OTHER";
export interface AccountOption { code: string; name: string; group: AccountGroup; selectable: boolean; note: string }

const has = (a: Cin7Account, re: RegExp): boolean => re.test(a.accountClass ?? "") || re.test(a.type ?? "");

export function classifyAccount(a: Cin7Account): AccountOption {
  const base = { code: a.code, name: a.name };
  if (!a.active) return { ...base, group: "INACTIVE", selectable: false, note: "Inactive in Cin7." };
  if (a.systemAccount) return { ...base, group: "SYSTEM", selectable: false, note: `Cin7 special account (${a.systemAccount}); not a revenue account.` };
  if (has(a, /liabil/i)) return { ...base, group: "LIABILITY", selectable: false, note: "Balance-sheet liability account. Cin7 acceptance on an invoice charge is not proven yet, so it cannot be chosen." };
  if (has(a, /revenue|income|sales/i)) return { ...base, group: "REVENUE", selectable: true, note: "Revenue account (the class Cin7 is proven to accept for invoice charges)." };
  return { ...base, group: "OTHER", selectable: false, note: a.accountClass || a.type ? `Class ${a.accountClass ?? a.type} is not a revenue account.` : "Cin7 did not report an account class, so it is not offered." };
}

/** Selectable first, then the rest in code order, so a locked account is visible but never in the way. */
export function accountOptions(accounts: readonly Cin7Account[]): AccountOption[] {
  return accounts.map(classifyAccount).sort((x, y) => Number(y.selectable) - Number(x.selectable) || x.code.localeCompare(y.code, undefined, { numeric: true }));
}

/** Server-side re-check of a chosen code against a fresh read: it must exist and be selectable. */
export function chosenAccountError(accounts: readonly Cin7Account[], code: string): string | null {
  const a = accounts.find((x) => x.code === code);
  if (!a) return `Account ${code} was not found in Cin7.`;
  const o = classifyAccount(a);
  return o.selectable ? null : `Account ${code} (${a.name}) cannot be used: ${o.note}`;
}
