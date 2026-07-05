/**
 * Data consistency/accuracy checks against a live Cin7 Core product catalog
 * (see fetchAllProductsWithBom) — flags gaps clients routinely struggle to
 * even find, let alone fix, in Cin7's own UI: missing Brand, no sales price
 * configured at all, incomplete inventory setup, and missing Revenue/COGS
 * GL accounts, plus near-duplicate category names. Scoped to products only
 * for now (Anton: "starting with the product data").
 *
 * Fixes for the field-completeness issues are a straightforward "same value
 * for every selected product" bulk apply (see app/audit/actions.ts); missing
 * sales pricing is report-only — there's no single sensible shared price
 * across different products, so bulk-fixing that doesn't make sense the way
 * it does for Brand/Location/UOM/GL accounts.
 */

export type ProductAuditIssueType =
  | "missing_brand"
  | "missing_sales_pricing"
  | "missing_location"
  | "missing_uom"
  | "missing_inventory_account"
  | "missing_revenue_account"
  | "missing_cogs_account";

export interface ProductAuditIssue {
  type: ProductAuditIssueType;
  productId: string;
  sku: string;
  name: string;
  /** Blank when the product itself has no Category set — still worth surfacing as its own filter option, not dropped. */
  category: string;
}

export interface CategoryDuplicateGroup {
  /** Each near-duplicate spelling of what looks like the same category, with how many products currently sit under it. */
  names: { name: string; productCount: number }[];
}

export interface ProductAuditResult {
  issues: ProductAuditIssue[];
  duplicateCategories: CategoryDuplicateGroup[];
  /** Every distinct category seen across the whole catalog (not just ones with issues) — e.g. so "Finished Products" still appears as a filter option even if it currently has zero issues. */
  categories: string[];
}

interface RawProduct {
  ID?: string;
  SKU?: string;
  Name?: string;
  Category?: string;
  Brand?: string;
  Type?: string;
  DefaultLocation?: string;
  UOM?: string;
  InventoryAccount?: string;
  RevenueAccount?: string;
  COGSAccount?: string;
  [key: string]: unknown;
}

function productRef(p: RawProduct): { productId: string; sku: string; name: string; category: string } {
  return { productId: p.ID ?? "", sku: p.SKU ?? "", name: p.Name ?? p.SKU ?? "", category: p.Category?.trim() ?? "" };
}

/** Products with no Brand set at all. */
export function findMissingBrand(products: RawProduct[]): ProductAuditIssue[] {
  return products.filter((p) => !p.Brand?.trim()).map((p) => ({ type: "missing_brand", ...productRef(p) }));
}

/** Products with none of the 10 price tiers set to a positive amount — no sell price configured anywhere. */
export function findMissingSalesPricing(products: RawProduct[]): ProductAuditIssue[] {
  return products
    .filter((p) => {
      for (let i = 1; i <= 10; i++) {
        const value = Number(p[`PriceTier${i}`] ?? 0);
        if (value > 0) return false;
      }
      return true;
    })
    .map((p) => ({ type: "missing_sales_pricing", ...productRef(p) }));
}

/**
 * Stock-type products missing the fields needed to actually track inventory
 * for them — DefaultLocation, UOM, or InventoryAccount. Service/Fixed Asset
 * products are exempt since they're not stock-tracked to begin with.
 */
export function findInventoryGaps(products: RawProduct[]): ProductAuditIssue[] {
  const issues: ProductAuditIssue[] = [];
  for (const p of products) {
    if (p.Type !== "Stock") continue;
    const ref = productRef(p);
    if (!p.DefaultLocation?.trim()) issues.push({ type: "missing_location", ...ref });
    if (!p.UOM?.trim()) issues.push({ type: "missing_uom", ...ref });
    if (!p.InventoryAccount?.trim()) issues.push({ type: "missing_inventory_account", ...ref });
  }
  return issues;
}

/** Products missing RevenueAccount and/or COGSAccount — each checked independently since a product could be missing one but not the other. */
export function findMissingGLAccounts(products: RawProduct[]): ProductAuditIssue[] {
  const issues: ProductAuditIssue[] = [];
  for (const p of products) {
    const ref = productRef(p);
    if (!p.RevenueAccount?.trim()) issues.push({ type: "missing_revenue_account", ...ref });
    if (!p.COGSAccount?.trim()) issues.push({ type: "missing_cogs_account", ...ref });
  }
  return issues;
}

/** Classic dynamic-programming edit distance — no dependency needed for a well-known ~15-line algorithm. */
function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/** Same string after trimming/collapsing whitespace/lowercasing, but different raw spelling — an exact "duplicate" Cin7 itself wouldn't stop you creating via CSV bulk import. */
function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Genuinely different spellings close enough to almost certainly be the same
 * category. Below 6 characters, fuzzy matching is skipped entirely (only
 * exact normalize-equality counts) — short names have too many legitimately
 * different 1-edit-apart pairs ("Bar" vs "Car") for edit distance alone to
 * be reliable.
 */
function isNearDuplicate(a: string, b: string): boolean {
  const at = a.trim();
  const bt = b.trim();
  if (normalize(at) === normalize(bt)) return true;

  const minLen = Math.min(at.length, bt.length);
  if (minLen < 6) return false;

  const distance = levenshtein(at, bt);
  const threshold = Math.min(2, Math.floor(minLen * 0.15));
  return distance > 0 && distance <= threshold;
}

/**
 * Groups categories whose names look like data-entry variants of the same
 * thing (trailing whitespace, casing, a character or two off) rather than
 * genuinely distinct categories. Products are counted per exact raw Category
 * string, since that's what's actually stored on each product record.
 */
export function findDuplicateCategories(products: RawProduct[]): CategoryDuplicateGroup[] {
  const countByName = new Map<string, number>();
  for (const p of products) {
    // Deliberately NOT trimmed here — the raw (untrimmed) string is the map
    // key, since a trailing-whitespace variant is exactly the kind of
    // duplicate this check exists to catch. Trimming first would silently
    // collapse "Widgets" and "Widgets " into the same key before the
    // near-duplicate comparison ever ran.
    const category = p.Category;
    if (!category || !category.trim()) continue;
    countByName.set(category, (countByName.get(category) ?? 0) + 1);
  }
  const names = [...countByName.keys()];

  const groups: string[][] = [];
  const assigned = new Set<string>();
  for (let i = 0; i < names.length; i++) {
    if (assigned.has(names[i])) continue;
    const group = [names[i]];
    assigned.add(names[i]);
    for (let j = i + 1; j < names.length; j++) {
      if (assigned.has(names[j])) continue;
      if (isNearDuplicate(names[i], names[j])) {
        group.push(names[j]);
        assigned.add(names[j]);
      }
    }
    if (group.length > 1) groups.push(group);
  }

  return groups.map((group) => ({
    names: group.map((name) => ({ name, productCount: countByName.get(name) ?? 0 })),
  }));
}

export function runProductAudit(products: RawProduct[]): ProductAuditResult {
  const categories = [...new Set(products.map((p) => p.Category?.trim()).filter((c): c is string => Boolean(c)))].sort();

  return {
    issues: [
      ...findMissingBrand(products),
      ...findMissingSalesPricing(products),
      ...findInventoryGaps(products),
      ...findMissingGLAccounts(products),
    ],
    duplicateCategories: findDuplicateCategories(products),
    categories,
  };
}
