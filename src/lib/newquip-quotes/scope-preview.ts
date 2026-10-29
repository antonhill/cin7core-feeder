import "server-only";
// The INTERNAL physical-scope view of a quotation, available while the quote is still being configured and (frozen) after approval. It uses the
// same builders as the approval seal (commercialLinesOf -> buildPhysicalScope -> applyMappingLibrary), so what a salesperson sees here is what is
// sealed, and what the project and the Cin7 Sale later inherit. Carries NO cost and NO margin. Commercial package prices are never altered by it.
import type { QuoteEvaluation } from "@/newquip/grower/evaluate";
import { commercialLinesOf, type AcceptedBaseline } from "@/newquip/quote/baseline";
import { buildPhysicalScope } from "@/newquip/quote/physical-scope";
import { applyMappingLibrary, effectiveScope, packageKeyOf, type LibraryMapping, type ScopeItem } from "@/lib/projects/product-scope";

export type ScopeLineState = "MAPPED" | "FROM_LIBRARY" | "UNRESOLVED" | "EXCLUDED" | "RESOLVED_ON_PROJECT";
export interface ScopeViewItem {
  id: string; description: string; packageKey: string; quantity: number | null; unit: string; state: ScopeLineState; reason?: string;
  mappingRef?: { packageKey: string; version: number };
  /** The physical SKUs this item expands to (quantity already converted). BOM components are reference only: never on the Sales Order. */
  lines: Array<{ sku: string; quantity: number; unit: string; role: "FINISHED_GOOD" | "BOM_COMPONENT" }>;
}
export interface QuoteScopeView {
  /** True once the quote is approved: the register is the sealed one and cannot change. */
  frozen: boolean;
  items: ScopeViewItem[];
  saleLines: Array<{ sku: string; quantity: number; description: string }>;
  referenceOnly: Array<{ sku: string; quantity: number; description: string }>;
  unresolvedCount: number;
  /** Consistency problems (for example a BOM component also sold as a Sale line). */
  warnings: string[];
}

export function describeScope(items: readonly ScopeItem[], frozen: boolean): QuoteScopeView {
  const eff = effectiveScope(items);
  const out: ScopeViewItem[] = items.map((it) => {
    const base = { id: it.id, description: it.description, packageKey: packageKeyOf(it), quantity: it.quantity, unit: it.unit };
    const r = it.resolution;
    if (r?.kind === "EXCLUDE") return { ...base, state: "EXCLUDED", reason: r.reason, lines: [] };
    if (r?.kind === "MAP_LINES") return { ...base, state: r.by === "mapping-library" ? "FROM_LIBRARY" : "RESOLVED_ON_PROJECT", mappingRef: r.mappingRef, lines: r.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, unit: l.unit, role: l.role })) };
    if (r?.kind === "MAP") return { ...base, state: "RESOLVED_ON_PROJECT", lines: [{ sku: r.sku, quantity: r.quantity, unit: it.unit, role: "FINISHED_GOOD" }] };
    if (it.mapping.status === "UNMAPPED") return { ...base, state: "UNRESOLVED", reason: it.mapping.reason, lines: [] };
    return { ...base, state: "MAPPED", lines: it.sku && it.quantity ? [{ sku: it.sku, quantity: it.quantity, unit: it.unit, role: "FINISHED_GOOD" }] : [] };
  });
  return {
    frozen, items: out, unresolvedCount: out.filter((i) => i.state === "UNRESOLVED").length,
    saleLines: eff.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, description: l.description })),
    referenceOnly: eff.referenceOnly.map((r) => ({ sku: r.sku, quantity: r.quantity, description: r.description })),
    warnings: eff.blockers.filter((b) => !out.some((i) => i.state === "UNRESOLVED" && b.startsWith(i.description))),
  };
}

/** The scope view for a quote: the sealed register when approved, otherwise the live evaluation with the ACTIVE reusable mappings applied. */
export function quoteScopeView(input: { finalBaseline: AcceptedBaseline | null; evaluation: QuoteEvaluation; library: ReadonlyMap<string, LibraryMapping> | null; now: string }): QuoteScopeView {
  const b = input.finalBaseline;
  if (b) return describeScope(b.physicalScope ?? buildPhysicalScope(b.commercial.lines), true);
  const budget = input.evaluation.budget;
  if (!budget) return { frozen: false, items: [], saleLines: [], referenceOnly: [], unresolvedCount: 0, warnings: ["The quote is not priced yet, so its physical scope cannot be shown."] };
  const items = buildPhysicalScope(commercialLinesOf(budget));
  return describeScope(input.library && input.library.size ? applyMappingLibrary(items, input.library, input.now) : items, false);
}
