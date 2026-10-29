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

/** FINISHED_GOOD goes on the Sales Order. BOM_COMPONENT is an internal manufacturing input already inside a finished good: it is recorded for traceability but is NEVER a Sale line (no double counting). */
export type MappedLineRole = "FINISHED_GOOD" | "BOM_COMPONENT";
export interface MappedLine {
  sku: string;
  /** Units of this SKU per ONE unit of the quoted item (e.g. 0.05 for a 20 m roll per metre of fencing). Kept for audit. */
  factor: number;
  /** Final quantity on the order = item quantity x factor, rounded to 6 dp. */
  quantity: number;
  /** Unit of measure of the SKU, as the manager entered it (display only). */
  unit: string;
  role: MappedLineRole;
}
export type ScopeResolution =
  | { kind: "MAP"; sku: string; quantity: number; reason: string; by: string; at: string }
  | { kind: "MAP_LINES"; lines: MappedLine[]; itemQuantity: number; /** Set when the lines came from a saved reusable mapping: the project keeps its OWN copy, this only records where it came from. */ mappingRef?: { packageKey: string; version: number }; reason: string; by: string; at: string }
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
  /** BOM components recorded against a mapped package for traceability. They are NOT Sale lines (their cost is inside the finished good). */
  referenceOnly: Array<{ id: string; sku: string; quantity: number; description: string }>;
}

const validQty = (q: unknown): q is number => typeof q === "number" && Number.isFinite(q) && q > 0;

export function effectiveScope(items: readonly ScopeItem[]): EffectiveScope {
  const bySku = new Map<string, SaleScopeLine>();
  const blockers: string[] = [];
  const excluded: EffectiveScope["excluded"] = [];
  const referenceOnly: EffectiveScope["referenceOnly"] = [];
  const add = (sku: string, qty: number, description: string, source: string) => {
    const cur = bySku.get(sku);
    if (cur) { cur.quantity += qty; cur.sources.push(source); } else bySku.set(sku, { sku, quantity: qty, description, sources: [source] });
  };
  for (const it of items) {
    if (it.resolution?.kind === "EXCLUDE") { excluded.push({ id: it.id, description: it.description, reason: it.resolution.reason }); continue; }
    if (it.resolution?.kind === "MAP_LINES") {
      const res = it.resolution;
      const recomputed = buildMappedLines(res.itemQuantity, res.lines.map((l) => ({ sku: l.sku, factor: l.factor, unit: l.unit, role: l.role })));
      if (!recomputed.ok) { blockers.push(`${it.description}: the recorded mapping is invalid (${recomputed.error})`); continue; }
      for (const l of res.lines) {
        if (l.role === "BOM_COMPONENT") referenceOnly.push({ id: it.id, sku: l.sku, quantity: l.quantity, description: it.description });
        else add(l.sku, l.quantity, it.description, it.id);
      }
      continue;
    }
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
  for (const ref of referenceOnly) if (bySku.has(ref.sku)) blockers.push(`${ref.description}: ${ref.sku} is a BOM component here but is also sold as a Sale line, which would double count it.`);
  return { lines: [...bySku.values()], blockers, excluded, referenceOnly };
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

export interface ResolveLineInput { sku: string; factor: number; unit?: string; role?: MappedLineRole }
export interface ResolveInput { itemId: string; kind: "MAP" | "MAP_LINES" | "EXCLUDE"; sku?: string; quantity?: number; lines?: ResolveLineInput[]; mappingRef?: { packageKey: string; version: number }; reason: string; by: string; at: string }

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Validates and prices the lines of a multi-SKU mapping against the quoted item's quantity (pure). */
export function buildMappedLines(itemQuantity: number | null, lines: readonly ResolveLineInput[] | undefined): { ok: true; lines: MappedLine[] } | { ok: false; error: string } {
  if (!validQty(itemQuantity)) return { ok: false, error: "The quoted item has no usable quantity, so its SKUs cannot be quantified." };
  if (!lines || lines.length === 0) return { ok: false, error: "Add at least one Cin7 SKU line." };
  const seen = new Set<string>();
  const out: MappedLine[] = [];
  for (const l of lines) {
    const sku = (l.sku ?? "").trim();
    if (!sku) return { ok: false, error: "Every line needs a Cin7 SKU." };
    if (seen.has(sku)) return { ok: false, error: `${sku} is listed twice; combine it into one line.` };
    seen.add(sku);
    if (!validQty(l.factor)) return { ok: false, error: `${sku}: the quantity per quoted unit must be a positive number.` };
    const quantity = r6(itemQuantity * l.factor);
    if (!(quantity > 0)) return { ok: false, error: `${sku}: the converted quantity rounds to zero.` };
    out.push({ sku, factor: l.factor, quantity, unit: (l.unit ?? "").trim() || "each", role: l.role === "BOM_COMPONENT" ? "BOM_COMPONENT" : "FINISHED_GOOD" });
  }
  if (!out.some((l) => l.role === "FINISHED_GOOD")) return { ok: false, error: "At least one line must be a finished good for the Sales Order. If this item has no physical product, exclude it instead." };
  return { ok: true, lines: out };
}

/** Records a controlled resolution on an UNMAPPED item (pure). Refuses unknown items, items that are already mapped/resolved, and missing reasons. */
export function applyResolution(items: readonly ScopeItem[], r: ResolveInput): { ok: true; items: ScopeItem[] } | { ok: false; error: string } {
  const it = items.find((x) => x.id === r.itemId);
  if (!it) return { ok: false, error: "That product is not in the project's scope." };
  if (it.mapping.status !== "UNMAPPED") return { ok: false, error: "Only an unmapped item can be resolved; mapped products come from the approved quotation." };
  if (it.resolution) return { ok: false, error: "This item already has a recorded resolution." };
  if (!r.reason.trim()) return { ok: false, error: "A reason is required." };
  let resolution: ScopeResolution;
  if (r.kind === "MAP_LINES") {
    const built = buildMappedLines(it.quantity, r.lines);
    if (!built.ok) return { ok: false, error: built.error };
    resolution = { kind: "MAP_LINES", lines: built.lines, itemQuantity: it.quantity as number, ...(r.mappingRef ? { mappingRef: r.mappingRef } : {}), reason: r.reason.trim(), by: r.by, at: r.at };
  } else if (r.kind === "EXCLUDE") resolution = { kind: "EXCLUDE", reason: r.reason.trim(), by: r.by, at: r.at };
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

/** The key a reusable mapping is stored under: the quote package the item came from, else the quote line itself. */
export function packageKeyOf(item: Pick<ScopeItem, "id" | "origin">): string {
  return item.origin.packageKey ?? item.id.replace(/:UNMAPPED$/, "");
}

/** A reusable mapping as the scope needs it (the version is frozen into every resolution that uses it). */
export interface LibraryMapping { packageKey: string; version: number; lines: ReadonlyArray<{ sku: string; factor: number; unit: string; role: MappedLineRole }> }
export const MAPPING_LIBRARY_ACTOR = "mapping-library";

/**
 * Applies the ACTIVE reusable mappings to a register's still-UNMAPPED items (pure). Each hit becomes an ordinary MAP_LINES resolution carrying the
 * mapping version it came from, so the register that is sealed into an approved quotation keeps its OWN copy: a later mapping version never changes it.
 * Items that are already mapped, already resolved, or have no usable quantity / no mapping are returned untouched (still reported as unresolved).
 */
export function applyMappingLibrary(items: readonly ScopeItem[], library: ReadonlyMap<string, LibraryMapping>, at: string): ScopeItem[] {
  return items.map((it) => {
    if (it.mapping.status !== "UNMAPPED" || it.resolution) return it;
    const m = library.get(packageKeyOf(it));
    if (!m) return it;
    const built = buildMappedLines(it.quantity, m.lines.map((l) => ({ sku: l.sku, factor: l.factor, unit: l.unit, role: l.role })));
    if (!built.ok) return it;
    return { ...it, resolution: { kind: "MAP_LINES", lines: built.lines, itemQuantity: it.quantity as number, mappingRef: { packageKey: m.packageKey, version: m.version }, reason: `Reusable mapping ${m.packageKey} v${m.version} applied automatically.`, by: MAPPING_LIBRARY_ACTOR, at } };
  });
}

/** Items that still stop a Sale, for display before approval: unmapped and unresolved (an exclusion or mapping counts as resolved). */
export function unresolvedItems(items: readonly ScopeItem[]): ScopeItem[] {
  return items.filter((i) => i.mapping.status === "UNMAPPED" && !i.resolution);
}
