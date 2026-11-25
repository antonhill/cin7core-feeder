// UAT-ONLY PROVISIONAL BUDGET BASIS. NOT AN APPROVAL.
// Spark Consulting authorised these costing assumptions for NewQuip INTERNAL UAT only (written directive, 2026-11-26). They are NOT an approval by a NewQuip Manager or commercial approver, are NOT a supplier
// transaction, and must never be used for a real customer quotation. The production-oriented Manager-controlled register (budget-basis-register.ts) is untouched and keeps its approval requirements.
//
// ISOLATION. The amounts are commercial costs, so they are NOT in this repository. They are supplied only through the server-side environment variable NEWQUIP_UAT_PROVISIONAL_BASIS on the UAT deployment
// (JSON: { "<itemKey>|<specification>": { "amount": <ZAR cost ex VAT>, "asOf": "YYYY-MM-DD" } }). With the variable absent (every other environment) this module yields nothing and behaves as if it did not exist.
// A line priced this way is always PROVISIONAL, says so in Rep-safe words, takes the existing project markup ONCE, and takes NO freight (an evidenced landed ZAR cost basis).
import type { GrowerItemKey } from "./types";

export interface UatProvisionalRate { itemKey: GrowerItemKey; specification: string; /** ZAR cost ex VAT (landed basis). */ amount: number; /** Date the figure was true (YYYY-MM-DD). */ asOf: string }

export const UAT_PROVISIONAL_ENV = "NEWQUIP_UAT_PROVISIONAL_BASIS";
export const UAT_PROVISIONAL_PLAIN = "Provisional: priced from an internal UAT allowance, not an approved NewQuip price, so it will change once NewQuip approves a basis for it.";

/** Parse the environment value defensively: anything malformed, non-positive or non-ZAR-shaped is ignored (never throws, never guesses). */
export function uatProvisionalRatesFromEnv(env: Record<string, string | undefined> = process.env): UatProvisionalRate[] {
  const raw = env[UAT_PROVISIONAL_ENV];
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const out: UatProvisionalRate[] = [];
  for (const [key, v] of Object.entries(parsed as Record<string, unknown>)) {
    const i = key.indexOf("|");
    const rec = v as { amount?: unknown; asOf?: unknown } | null;
    if (i <= 0 || !rec || typeof rec.amount !== "number" || !Number.isFinite(rec.amount) || rec.amount <= 0 || typeof rec.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(rec.asOf)) continue;
    out.push({ itemKey: key.slice(0, i) as GrowerItemKey, specification: key.slice(i + 1), amount: rec.amount, asOf: rec.asOf });
  }
  return out;
}
export const uatRateFor = (rates: readonly UatProvisionalRate[] | undefined, itemKey: GrowerItemKey, specification: string): UatProvisionalRate | null =>
  (rates ?? []).find((r) => r.itemKey === itemKey && r.specification === specification) ?? null;
