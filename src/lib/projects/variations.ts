// Projects — VARIATIONS (pure). A Variation is the ONLY way scope/value changes after a contract is accepted.
//
//   original_contract_cents   never changes (projects.original_contract_cents, frozen by the database)
//   revised contract          = original + SUM(APPROVED variations)        — the only thing a Variation moves
//   DRAFT and REJECTED variations never affect any contract value.
//
// Generic: nothing here knows about NewQuip. The progress-claim mathematics in claim-engine.ts is untouched by variations.
import type { Cents } from "./claim-engine";

export const VARIATION_STATUSES = ["DRAFT", "APPROVED", "REJECTED"] as const;
export type VariationStatus = (typeof VARIATION_STATUSES)[number];

export interface VariationRow {
  id: string;
  code: string;
  title: string;
  description: string | null;
  amount_cents: number;
  /** INTERNAL estimated cost, ex VAT; null = unknown. Withheld from viewers who may not see cost (redactVariationCosts). */
  estimated_cost_cents?: number | null;
  status: string;
  raised_by_email: string;
  priced_by_email: string | null;
  decided_by_email: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  created_at: string;
}

export function isVariationStatus(s: string): s is VariationStatus {
  return (VARIATION_STATUSES as readonly string[]).includes(s);
}

/** V001, V002, … — the next free code for a project. */
export function nextVariationCode(existingCodes: readonly string[]): string {
  const max = existingCodes.reduce((m, c) => {
    const n = /^V(\d+)$/.exec(c);
    return n ? Math.max(m, Number(n[1])) : m;
  }, 0);
  return `V${String(max + 1).padStart(3, "0")}`;
}

export function assertVariationTransition(from: VariationStatus, to: VariationStatus): void {
  const ok = from === "DRAFT" && (to === "APPROVED" || to === "REJECTED");
  if (!ok) throw new Error(`A ${from} variation cannot become ${to}. Only a DRAFT can be approved or rejected; decisions are final.`);
}

export interface ContractPosition {
  originalContractCents: Cents;
  approvedVariationsCents: Cents;
  revisedContractCents: Cents;
}

/** Only APPROVED variations count. Unknown statuses count for nothing (fail closed). */
export function contractPosition(originalContractCents: Cents, variations: readonly Pick<VariationRow, "status" | "amount_cents">[]): ContractPosition {
  const approved = variations.filter((v) => v.status === "APPROVED").reduce((n, v) => n + v.amount_cents, 0);
  return { originalContractCents, approvedVariationsCents: approved, revisedContractCents: originalContractCents + approved };
}

// ── Cin7 POC REPRESENTATION (display only — nothing is ever sent) ───────────────────────────────

export const NOT_SENT_TO_CIN7 = "NOT SENT TO CIN7" as const;

export interface CommitmentRepresentation {
  label: string;
  /** The Sale reference this WOULD be in Cin7. A placeholder: no Cin7 document exists. */
  saleRef: string;
  state: typeof NOT_SENT_TO_CIN7;
  valueCents: Cents;
}

/** Original contract = SO-POC-001; each APPROVED variation gets the next SO-POC-00n under the same Project. */
export function cin7PocRepresentation(originalContractCents: Cents, variations: readonly VariationRow[]): CommitmentRepresentation[] {
  const approved = variations.filter((v) => v.status === "APPROVED").sort((a, b) => (a.code < b.code ? -1 : 1));
  return [
    { label: "Original contract", saleRef: "SO-POC-001", state: NOT_SENT_TO_CIN7, valueCents: originalContractCents },
    ...approved.map((v, i) => ({ label: `Variation ${v.code} — ${v.title}`, saleRef: `SO-POC-${String(i + 2).padStart(3, "0")}`, state: NOT_SENT_TO_CIN7, valueCents: v.amount_cents })),
  ];
}

export interface ClaimAllocationInput {
  label: string;
  /** How much of the claim sits on this commitment, ex VAT. */
  amountCents: Cents;
  /** The commitment's remaining capacity, ex VAT. */
  remainingCents: Cents;
}

/**
 * One Project claim may span original + variation value. Validates a proposed split: the parts must sum to the claim and no
 * commitment may be drawn beyond its remaining capacity. Production may raise separate Cin7 invoices per commitment; the POC
 * only represents the allocation.
 */
export function allocateClaim(claimCents: Cents, parts: readonly ClaimAllocationInput[]): { ok: true; parts: readonly ClaimAllocationInput[] } | { ok: false; error: string } {
  const sum = parts.reduce((n, p) => n + p.amountCents, 0);
  if (sum !== claimCents) return { ok: false, error: `The allocation (${sum}) must equal the claim (${claimCents}).` };
  const over = parts.find((p) => p.amountCents < 0 || p.amountCents > p.remainingCents);
  if (over) return { ok: false, error: `${over.label}: allocation exceeds its remaining commitment.` };
  return { ok: true, parts };
}

/** Removes the internal estimated cost from variations for a viewer who may not see cost. */
export function redactVariationCosts<T extends { variations: VariationRow[] }>(view: T, canSeeCost: boolean): T {
  if (canSeeCost) return view;
  return { ...view, variations: view.variations.map((v) => ({ ...v, estimated_cost_cents: null })) };
}
