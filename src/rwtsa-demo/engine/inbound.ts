import { daysBetween } from "./calendar";

export type PoStatusClass = "on-water" | "on-order" | "received" | "unclassified";

/**
 * Classifies a purchase-order status text. The workbook's exact status vocabulary is not yet known, so anything that is not
 * recognised is `unclassified`: it is excluded from inbound and its quantity is reported, never guessed at.
 * Received/closed/cancelled lines are excluded because received stock is already in the Stock tab.
 */
export function classifyPoStatus(status: string): PoStatusClass {
  const s = status.toLowerCase().trim();
  // Negated, partial or in-progress wording is ambiguous: never guess, report it as unclassified.
  if (/\b(not|un|awaiting|partial(ly)?|incomplete|arriving|pending delivery|delivery pending|production complete)\b|\bun(shipped|delivered|received)\b|not yet/.test(s)) return "unclassified";
  if (/\b(received|delivered|arrived|complete|completed|closed|cancel(l?ed)?|grn)\b/.test(s)) return "received";
  if (/\b(on the water|on water|in transit|at sea|sailing|shipped|vessel|afloat)\b/.test(s)) return "on-water";
  if (/\b(on order|ordered|planned|booked|confirmed|open|pending|in production)\b/.test(s)) return "on-order";
  return "unclassified";
}

/** Projection week of an ETA-to-stores date; <= 0 means on or before the stock date. */
export function etaWeek(stockDate: string, etaStores: string): number {
  return Math.ceil(daysBetween(stockDate, etaStores) / 7);
}

/**
 * Splits `total` units across `weights` so the parts sum to `total` exactly (largest-remainder, ties by input order).
 * Integer totals give integer parts. Returns null when no weight is positive (nothing to split by).
 */
export function allocateUnits(total: number, weights: readonly (readonly [string, number])[]): [string, number][] | null {
  const w = weights.map(([k, v]) => [k, Number.isFinite(v) && v > 0 ? v : 0] as const);
  const sum = w.reduce((a, [, v]) => a + v, 0);
  if (sum <= 0) return null;
  if (!Number.isInteger(total)) return w.map(([k, v]) => [k, (total * v) / sum]);
  const exact = w.map(([k, v]) => ({ k, share: (total * v) / sum }));
  const parts = exact.map((e) => ({ k: e.k, n: Math.floor(e.share + 1e-9), frac: e.share - Math.floor(e.share + 1e-9) }));
  let left = total - parts.reduce((a, p) => a + p.n, 0);
  const order = parts.map((_, i) => i).sort((a, b) => parts[b].frac - parts[a].frac || a - b);
  for (const i of order) {
    if (left <= 0) break;
    if (w[i][1] > 0) {
      parts[i].n += 1;
      left -= 1;
    }
  }
  return parts.map((p) => [p.k, p.n]);
}
