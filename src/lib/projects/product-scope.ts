// Projects - the approved PHYSICAL PRODUCT SCOPE (pure, generic). One register per billing scope, inherited from the approved quotation
// (or, for a variation, entered once when its billing starts) so that no SKU is ever re-typed downstream. Everything the Cin7 Advanced Sale
// and the invoice proposals need about products comes from here:
//   * a MAPPED item carries a genuine Cin7 SKU and an approved quantity;
//   * an UNMAPPED item (package with no authoritative SKU list, an unresolved product, an estimator-priced system) is reported explicitly and
//     BLOCKS Sale creation until a manager records a controlled, audited resolution (map it to a real SKU, or exclude it with a reason);
//   * nothing is ever invented, defaulted or substituted.
// It contains NO cost or margin (it lives in the project baseline, which every project viewer can read); internal economics stay in the
// access-controlled quotation margin sheet.

export type ScopeKind = "BASE" | "VARIATION";
/** FINISHED_GOOD: a product the quote sells as a single SKU. DIRECT_COMPONENT: a component of a package the customer receives as supplied parts. */
export type ProductType = "FINISHED_GOOD" | "DIRECT_COMPONENT";

export type ScopeResolution =
  | { kind: "MAP"; sku: string; quantity: number; reason: string; by: string; at: string }
  | { kind: "EXCLUDE"; reason: string; by: string; at: string };

export interface ScopeItem {
  /** Stable key within the register (quote line, or quote line + component SKU). Used to prevent duplicate inheritance and to target resolutions. */
  id: string;
  sku: string | null;
  description: string;
  quantity: number | null;
  unit: string;
  productType: ProductType;
  origin: { lineRef: string; label: string; packageKey: string | null; section: string | null; source: "QUOTE" | "VARIATION" | "P0" | "LEGACY" };
  scope: ScopeKind;
  /** Customer-facing selling price per unit, ex VAT (not cost, not margin). Null when the quote carries none for this item. */
  sellingUnitCents: number | null;
  mapping: { status: "MAPPED" } | { status: "UNMAPPED"; reason: string };
  resolution?: ScopeResolution;
}

export interface SaleScopeLine { sku: string; quantity: number; description: string; sources: string[] }
export interface EffectiveScope {
  /** What goes on the Sales Order: one line per SKU (quantities of the same SKU from several items are summed, never duplicated). */
  lines: SaleScopeLine[];
  /** Items that stop Sale creation: unmapped with no resolution, or invalid. */
  blockers: string[];
  /** Items deliberately kept off the Sales Order, with the manager's reason. */
  excluded: Array<{ id: string; description: string; reason: string }>;
}

const validQty = (q: unknown): q is number => typeof q === "number" && Number.isFinite(q) && q > 0;

export function effectiveScope(items: readonly ScopeItem[]): EffectiveScope {
  const bySku = new Map<string, SaleScopeLine>();
  const blockers: string[] = [];
  const excluded: EffectiveScope["excluded"] = [];
  const add = (sku: string, qty: number, description: string, source: string) => {
    const cur = bySku.get(sku);
    if (cur) { cur.quantity += qty; cur.sources.push(source); } else bySku.set(sku, { sku, quantity: qty, description, sources: [source] });
  };
  for (const it of items) {
    if (it.resolution?.kind === "EXCLUDE") { excluded.push({ id: it.id, description: it.description, reason: it.resolution.reason }); continue; }
    if (it.resolution?.kind === "MAP") {
      if (!it.resolution.sku.trim() || !validQty(it.resolution.quantity)) blockers.push(`${it.description}: the recorded mapping is invalid.`);
      else add(it.resolution.sku, it.resolution.quantity, it.description, it.id);
      continue;
    }
    if (it.mapping.status === "UNMAPPED") { blockers.push(`${it.description}: ${it.mapping.reason}`); continue; }
    if (!it.sku || !it.sku.trim()) { blockers.push(`${it.description}: no Cin7 SKU.`); continue; }
    if (!validQty(it.quantity)) { blockers.push(`${it.description} (${it.sku}): no usable quantity.`); continue; }
    add(it.sku, it.quantity, it.description, it.id);
  }
  return { lines: [...bySku.values()], blockers, excluded };
}

/**
 * The register of a project, read from its (immutable-after-claims) baseline snapshot. Projects created from an approved quotation carry
 * `physicalScope`; older or non-quote projects (disposable P0 projects, fixtures) fall back to their baseline lines that carry a real SKU.
 */
export function scopeFromSnapshot(snapshot: unknown): ScopeItem[] {
  const s = (snapshot ?? {}) as { physicalScope?: ScopeItem[]; lines?: Array<{ lineRef: string; sku: string | null; description: string; quantity: number }>; provenance?: { kind?: string }; sourceQuoteRef?: string; kind?: string };
  if (Array.isArray(s.physicalScope)) return s.physicalScope;
  if (s.kind === "VARIATION_BILLING") return [];
  const p0 = (s.sourceQuoteRef ?? "").startsWith("P0-DISPOSABLE");
  return (s.lines ?? []).filter((l) => l.sku && validQty(l.quantity)).map((l): ScopeItem => ({
    id: l.lineRef, sku: l.sku, description: l.description, quantity: l.quantity, unit: "each", productType: "FINISHED_GOOD",
    origin: { lineRef: l.lineRef, label: l.description, packageKey: null, section: null, source: p0 ? "P0" : "LEGACY" }, scope: "BASE", sellingUnitCents: null, mapping: { status: "MAPPED" },
  }));
}

export interface ResolveInput { itemId: string; kind: "MAP" | "EXCLUDE"; sku?: string; quantity?: number; reason: string; by: string; at: string }

/** Records a controlled resolution on an UNMAPPED item (pure). Refuses unknown items, items that are already mapped/resolved, and missing reasons. */
export function applyResolution(items: readonly ScopeItem[], r: ResolveInput): { ok: true; items: ScopeItem[] } | { ok: false; error: string } {
  const it = items.find((x) => x.id === r.itemId);
  if (!it) return { ok: false, error: "That product is not in the project's scope." };
  if (it.mapping.status !== "UNMAPPED") return { ok: false, error: "Only an unmapped item can be resolved; mapped products come from the approved quotation." };
  if (it.resolution) return { ok: false, error: "This item already has a recorded resolution." };
  if (!r.reason.trim()) return { ok: false, error: "A reason is required." };
  let resolution: ScopeResolution;
  if (r.kind === "EXCLUDE") resolution = { kind: "EXCLUDE", reason: r.reason.trim(), by: r.by, at: r.at };
  else {
    if (!r.sku || !r.sku.trim()) return { ok: false, error: "Enter the Cin7 SKU to map this item to." };
    if (!validQty(r.quantity)) return { ok: false, error: "Enter a positive quantity." };
    resolution = { kind: "MAP", sku: r.sku.trim(), quantity: r.quantity, reason: r.reason.trim(), by: r.by, at: r.at };
  }
  return { ok: true, items: items.map((x) => (x.id === r.itemId ? { ...x, resolution } : x)) };
}

/** Builds the register of a VARIATION from SKUs chosen once (controlled scope addition) when its billing starts. */
export function variationScope(variationCode: string, products: ReadonlyArray<{ sku: string; description: string; quantity: number }>): { ok: true; items: ScopeItem[] } | { ok: false; error: string } {
  const seen = new Set<string>();
  const items: ScopeItem[] = [];
  for (const p of products) {
    const sku = p.sku.trim();
    if (!sku || seen.has(sku)) return { ok: false, error: `SKU ${sku || "(blank)"} is missing or listed twice.` };
    seen.add(sku);
    if (!validQty(p.quantity)) return { ok: false, error: `Quantity for ${sku} must be a positive number.` };
    items.push({ id: `${variationCode}:${sku}`, sku, description: p.description.trim() || sku, quantity: p.quantity, unit: "each", productType: "FINISHED_GOOD",
      origin: { lineRef: `${variationCode}:${sku}`, label: `Variation ${variationCode}`, packageKey: null, section: null, source: "VARIATION" }, scope: "VARIATION", sellingUnitCents: null, mapping: { status: "MAPPED" } });
  }
  return { ok: true, items };
}
