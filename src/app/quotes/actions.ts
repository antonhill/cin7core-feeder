"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireModuleAccess, requireModuleWrite } from "@/lib/authorization";
import { QUOTES_MODULE } from "@/app/module-nav";
import { resolveQuoteLines, productSkusFor, type QuoteLineDraft } from "@/lib/quote-build";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchCustomerDefaults, type Cin7CustomerDefaults } from "@/cin7/customers";
import {
  fetchAllLocations,
  fetchAllPriceTiers,
  fetchAllCompanyContacts,
  fetchAllTaxRules,
  type Cin7PriceTier,
  type Cin7TaxRule,
} from "@/cin7/reference-lookups";

// Draft CRUD for the Quotation + Margin module.
//
// Cost integrity (brief: "Never trust client-calculated financial totals"): the client sends only
// the commercial inputs (product, qty, price, discount, tax mode). This layer sources each product's
// cost from the org's own synced Cin7 Average Cost (products.average_cost) and recomputes every
// margin + the footer via the pure engine — the client's numbers are never persisted.
//
// Auth: reads use requireModuleAccess('/quotes'); mutations use requireModuleWrite('/quotes')
// (module access + a writing plan — the recorded decision; no AAL2). Writes go through the
// service-role client, same convention as every other write table in this app (RLS has no client
// write policy).

export interface QuoteActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

/** A line as submitted by the builder (inputs only — cost + computed figures are server-owned). */
export type QuoteLineDraftInput = QuoteLineDraft;

export interface QuoteDraftInput {
  /** Present = update that draft; absent = create a new draft. */
  quoteId?: string;
  instanceId: string;
  customerName?: string;
  cin7CustomerId?: string;
  priceTier?: string;
  salesRep?: string;
  location?: string;
  taxInclusive?: boolean;
  notes?: string;
  lines: QuoteLineDraftInput[];
}

export interface QuoteSummary {
  id: string;
  instanceId: string;
  status: string;
  customerName: string | null;
  currency: string;
  subtotalExTax: number;
  totalIncTax: number;
  overallMarginPct: number | null;
  excludedFromMarginCount: number;
  cin7QuoteNumber: string | null;
  updatedAt: string;
}

export interface QuoteLineDetail extends QuoteLineDraftInput {
  lineNumber: number;
  averageCost: number | null;
  revenueExTax: number;
  estimatedCost: number | null;
  estimatedGp: number | null;
  marginPct: number | null;
}

export interface QuoteDetail extends QuoteSummary {
  cin7CustomerId: string | null;
  priceTier: string | null;
  salesRep: string | null;
  location: string | null;
  taxInclusive: boolean;
  notes: string | null;
  taxTotal: number;
  estimatedCost: number;
  estimatedGp: number;
  marginRevenueExTax: number;
  costedLineCount: number;
  cin7SaleId: string | null;
  createdByEmail: string | null;
  lines: QuoteLineDetail[];
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Unknown error";
}

export interface QuoteProductHit {
  sku: string;
  name: string;
  averageCost: number | null;
  /** This product's synced price per tier, keyed by tier_code ("Tier1".."Tier10"). Drives the auto unit price. */
  tierPrices: Record<string, number>;
}

/**
 * Search the org's synced product catalogue for the builder's line picker. Returns SKU, name and
 * the Cin7 Average Cost (the quote's cost basis) so the builder can show a live margin the moment a
 * product is chosen — a fast local read, no live Cin7 call during interactive building. The query is
 * sanitised to a safe charset before going into the PostgREST or() filter (no filter injection).
 */
export async function searchQuoteProductsAction(query: string): Promise<QuoteActionResult<QuoteProductHit[]>> {
  try {
    const { orgId } = await requireModuleAccess(QUOTES_MODULE.href);
    const safe = (query ?? "").replace(/[^\w\s-]/g, "").trim();
    if (safe.length < 2) return { ok: true, data: [] };
    const db = createServiceRoleClient();
    const like = `%${safe}%`;
    const { data, error } = await db
      .from("products")
      .select("sku, name, average_cost")
      .eq("org_id", orgId)
      .eq("active", true)
      .or(`sku.ilike.${like},name.ilike.${like}`)
      .order("sku", { ascending: true })
      .limit(20);
    if (error) throw new Error(error.message);

    // Attach each product's synced tier prices (price_tiers.tier_code = "Tier1".."Tier10")
    // so the builder can auto-fill the unit price from the chosen tier without a Cin7 call.
    const skus = (data ?? []).map((p) => p.sku);
    const pricesBySku = new Map<string, Record<string, number>>();
    if (skus.length > 0) {
      const { data: tiers, error: tErr } = await db
        .from("price_tiers")
        .select("product_sku, tier_code, amount")
        .eq("org_id", orgId)
        .in("product_sku", skus);
      if (tErr) throw new Error(tErr.message);
      for (const t of tiers ?? []) {
        const m = pricesBySku.get(t.product_sku) ?? {};
        m[t.tier_code] = Number(t.amount);
        pricesBySku.set(t.product_sku, m);
      }
    }

    const hits: QuoteProductHit[] = (data ?? []).map((p) => ({
      sku: p.sku,
      name: p.name,
      averageCost: p.average_cost == null ? null : Number(p.average_cost),
      tierPrices: pricesBySku.get(p.sku) ?? {},
    }));
    return { ok: true, data: hits };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export interface QuoteCustomerHit {
  name: string;
  /** The customer's Cin7 defaults — used to pre-fill the quote when the customer is chosen. */
  priceTier: string | null;
  salesRep: string | null;
  location: string | null;
  taxRule: string | null;
}

/**
 * Search the org's synced customers for the quote's customer picker (no free-typing — a customer
 * that doesn't match Cin7 fails on submit). Returns the customer's own default price tier / sales
 * rep / location so the builder can pre-fill them. Fast local read of the synced `customers` table.
 */
export async function searchQuoteCustomersAction(query: string): Promise<QuoteActionResult<QuoteCustomerHit[]>> {
  try {
    const { orgId } = await requireModuleAccess(QUOTES_MODULE.href);
    const safe = (query ?? "").replace(/[^\w\s.&'-]/g, "").trim();
    if (safe.length < 2) return { ok: true, data: [] };
    const db = createServiceRoleClient();
    const { data, error } = await db
      .from("customers")
      .select("name, price_tier, sales_representative, location, tax_rule")
      .eq("org_id", orgId)
      .ilike("name", `%${safe}%`)
      .order("name", { ascending: true })
      .limit(20);
    if (error) throw new Error(error.message);
    const hits: QuoteCustomerHit[] = (data ?? []).map((c) => ({
      name: c.name,
      priceTier: c.price_tier ?? null,
      salesRep: c.sales_representative ?? null,
      location: c.location ?? null,
      taxRule: c.tax_rule ?? null,
    }));
    return { ok: true, data: hits };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export type QuoteCustomerResolved = Cin7CustomerDefaults;

/**
 * Live-fetch the picked customer's CURRENT Cin7 sale defaults (tax rule / price tier / sales rep /
 * location) so the builder isn't bound to the last Migrate pull. One targeted Cin7 lookup by name.
 */
export async function resolveQuoteCustomerAction(
  instanceId: string,
  customerName: string,
): Promise<QuoteActionResult<QuoteCustomerResolved | null>> {
  if (!instanceId || !customerName) return { ok: false, error: "Choose an instance and a customer." };
  try {
    const { orgId } = await requireModuleAccess(QUOTES_MODULE.href);
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);
    const defaults = await fetchCustomerDefaults(creds, customerName);
    return { ok: true, data: defaults };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export interface QuoteReferenceData {
  locations: string[];
  priceTiers: Cin7PriceTier[];
  salesReps: string[];
  taxRules: Cin7TaxRule[];
}

/**
 * Load the pick-lists the builder's Location / Price tier / Sales rep selectors need, LIVE from the
 * chosen instance's Cin7 reference books (locations `/ref/location`, tiers `/ref/priceTier`, reps
 * `/me/contacts`). Fetched once when an instance is selected; the lists are small. loadCin7Credentials
 * scopes by (instance, org) and throws otherwise, so it doubles as the instance-belongs-to-org check.
 */
export async function loadQuoteReferenceDataAction(instanceId: string): Promise<QuoteActionResult<QuoteReferenceData>> {
  if (!instanceId) return { ok: false, error: "Choose a Cin7 instance." };
  try {
    const { orgId } = await requireModuleAccess(QUOTES_MODULE.href);
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);
    const [locations, priceTiers, salesReps, taxRules] = await Promise.all([
      fetchAllLocations(creds).then((ls) => ls.map((l) => l.name)),
      fetchAllPriceTiers(creds),
      fetchAllCompanyContacts(creds),
      fetchAllTaxRules(creds),
    ]);
    const uniqueSorted = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return { ok: true, data: { locations: uniqueSorted(locations), priceTiers, salesReps, taxRules } };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/** List this org's quotes, newest first; optionally scoped to one instance. Read-only. */
export async function listQuotesAction(instanceId?: string): Promise<QuoteActionResult<QuoteSummary[]>> {
  try {
    const { orgId } = await requireModuleAccess(QUOTES_MODULE.href);
    const db = createServiceRoleClient();
    let q = db
      .from("quotes")
      .select(
        "id, instance_id, status, customer_name, currency, subtotal_ex_tax, total_inc_tax, overall_margin_pct, excluded_from_margin_count, cin7_quote_number, updated_at",
      )
      .eq("org_id", orgId)
      .order("updated_at", { ascending: false });
    if (instanceId) q = q.eq("instance_id", instanceId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const rows: QuoteSummary[] = (data ?? []).map((r) => ({
      id: r.id,
      instanceId: r.instance_id,
      status: r.status,
      customerName: r.customer_name,
      currency: r.currency,
      subtotalExTax: Number(r.subtotal_ex_tax),
      totalIncTax: Number(r.total_inc_tax),
      overallMarginPct: r.overall_margin_pct == null ? null : Number(r.overall_margin_pct),
      excludedFromMarginCount: Number(r.excluded_from_margin_count),
      cin7QuoteNumber: r.cin7_quote_number,
      updatedAt: r.updated_at,
    }));
    return { ok: true, data: rows };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/** Load one quote (header + lines) belonging to this org. Read-only. */
export async function getQuoteAction(quoteId: string): Promise<QuoteActionResult<QuoteDetail>> {
  if (!quoteId) return { ok: false, error: "Missing quote id." };
  try {
    const { orgId } = await requireModuleAccess(QUOTES_MODULE.href);
    const db = createServiceRoleClient();
    const { data: h, error: hErr } = await db.from("quotes").select("*").eq("org_id", orgId).eq("id", quoteId).maybeSingle();
    if (hErr) throw new Error(hErr.message);
    if (!h) return { ok: false, error: "Quote not found." };

    const { data: lineRows, error: lErr } = await db
      .from("quote_lines")
      .select("*")
      .eq("quote_id", quoteId)
      .order("line_number", { ascending: true });
    if (lErr) throw new Error(lErr.message);

    const lines: QuoteLineDetail[] = (lineRows ?? []).map((l) => ({
      lineType: l.line_type === "charge" ? "charge" : "product",
      cin7ProductId: l.cin7_product_id,
      productSku: l.product_sku,
      productName: l.product_name,
      quantity: Number(l.quantity),
      unitPrice: Number(l.unit_price),
      discountPct: Number(l.discount_pct),
      taxRatePct: Number(l.tax_rate_pct),
      lineNumber: Number(l.line_number),
      averageCost: l.average_cost == null ? null : Number(l.average_cost),
      revenueExTax: Number(l.revenue_ex_tax),
      estimatedCost: l.estimated_cost == null ? null : Number(l.estimated_cost),
      estimatedGp: l.estimated_gp == null ? null : Number(l.estimated_gp),
      marginPct: l.margin_pct == null ? null : Number(l.margin_pct),
    }));

    return {
      ok: true,
      data: {
        id: h.id,
        instanceId: h.instance_id,
        status: h.status,
        customerName: h.customer_name,
        cin7CustomerId: h.cin7_customer_id,
        priceTier: h.price_tier,
        salesRep: h.sales_rep,
        location: h.location,
        currency: h.currency,
        taxInclusive: Boolean(h.tax_inclusive),
        notes: h.notes,
        subtotalExTax: Number(h.subtotal_ex_tax),
        taxTotal: Number(h.tax_total),
        totalIncTax: Number(h.total_inc_tax),
        estimatedCost: Number(h.estimated_cost),
        estimatedGp: Number(h.estimated_gp),
        marginRevenueExTax: Number(h.margin_revenue_ex_tax),
        overallMarginPct: h.overall_margin_pct == null ? null : Number(h.overall_margin_pct),
        costedLineCount: Number(h.costed_line_count),
        excludedFromMarginCount: Number(h.excluded_from_margin_count),
        cin7SaleId: h.cin7_sale_id,
        cin7QuoteNumber: h.cin7_quote_number,
        createdByEmail: h.created_by_email,
        updatedAt: h.updated_at,
        lines,
      },
    };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/**
 * Create or update a DRAFT quote. Sources cost server-side, recomputes all margins + totals, and
 * replaces the quote's lines. A quote already submitted to Cin7 is frozen — it can't be edited here.
 */
export async function saveQuoteAction(input: QuoteDraftInput): Promise<QuoteActionResult<{ quoteId: string }>> {
  try {
    if (!input?.instanceId) return { ok: false, error: "Choose a Cin7 instance." };
    const { orgId, email } = await requireModuleWrite(QUOTES_MODULE.href);
    const db = createServiceRoleClient();

    // The instance must belong to THIS org — never trust a client-supplied instance id.
    const { data: inst, error: instErr } = await db
      .from("cin7_instances")
      .select("id")
      .eq("id", input.instanceId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (instErr) throw new Error(instErr.message);
    if (!inst) return { ok: false, error: "That instance doesn't belong to your organization." };

    // Source cost server-side from the org's synced Cin7 Average Cost. Never from the client.
    const skus = productSkusFor(input.lines);
    const costBySku = new Map<string, number | null>();
    if (skus.length > 0) {
      const { data: prods, error: pErr } = await db
        .from("products")
        .select("sku, average_cost")
        .eq("org_id", orgId)
        .in("sku", skus);
      if (pErr) throw new Error(pErr.message);
      for (const p of prods ?? []) {
        costBySku.set(String(p.sku).trim(), p.average_cost == null ? null : Number(p.average_cost));
      }
    }

    const { lines, totals } = resolveQuoteLines(input.lines ?? [], costBySku, {
      taxInclusive: input.taxInclusive === true,
    });

    const nowIso = new Date().toISOString();
    const header = {
      org_id: orgId,
      instance_id: input.instanceId,
      customer_name: input.customerName ?? null,
      cin7_customer_id: input.cin7CustomerId ?? null,
      price_tier: input.priceTier ?? null,
      sales_rep: input.salesRep ?? null,
      location: input.location ?? null,
      tax_inclusive: input.taxInclusive === true,
      notes: input.notes ?? null,
      subtotal_ex_tax: totals.subtotalExTax,
      tax_total: totals.taxTotal,
      total_inc_tax: totals.totalIncTax,
      estimated_cost: totals.estimatedCost,
      estimated_gp: totals.estimatedGP,
      margin_revenue_ex_tax: totals.marginRevenueExTax,
      overall_margin_pct: totals.overallMarginPct,
      costed_line_count: totals.costedLineCount,
      excluded_from_margin_count: totals.excludedFromMarginCount,
      updated_at: nowIso,
    };

    let quoteId = input.quoteId ?? "";

    if (quoteId) {
      // Update: the quote must exist, belong to this org, and still be an editable draft.
      const { data: existing, error: exErr } = await db
        .from("quotes")
        .select("id, status")
        .eq("org_id", orgId)
        .eq("id", quoteId)
        .maybeSingle();
      if (exErr) throw new Error(exErr.message);
      if (!existing) return { ok: false, error: "Quote not found." };
      if (existing.status !== "draft") {
        return { ok: false, error: "This quote has been submitted to Cin7 and can no longer be edited." };
      }
      const { error: upErr } = await db.from("quotes").update(header).eq("org_id", orgId).eq("id", quoteId);
      if (upErr) throw new Error(upErr.message);
    } else {
      const { data: created, error: insErr } = await db
        .from("quotes")
        .insert({ ...header, status: "draft", created_by_email: email })
        .select("id")
        .single();
      if (insErr) throw new Error(insErr.message);
      quoteId = created.id;
    }

    // Replace-all lines: a draft editor sends the full current line set each save.
    const { error: delErr } = await db.from("quote_lines").delete().eq("quote_id", quoteId);
    if (delErr) throw new Error(delErr.message);
    if (lines.length > 0) {
      const cost_snapshot_at = nowIso;
      const rows = lines.map((l) => ({ ...l, quote_id: quoteId, org_id: orgId, cost_snapshot_at }));
      const { error: linesErr } = await db.from("quote_lines").insert(rows);
      if (linesErr) throw new Error(linesErr.message);
    }

    return { ok: true, data: { quoteId } };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/** Delete a DRAFT quote (and its lines, via cascade). A submitted quote can't be deleted here. */
export async function deleteQuoteAction(quoteId: string): Promise<QuoteActionResult<null>> {
  if (!quoteId) return { ok: false, error: "Missing quote id." };
  try {
    const { orgId } = await requireModuleWrite(QUOTES_MODULE.href);
    const db = createServiceRoleClient();
    const { data: existing, error: exErr } = await db
      .from("quotes")
      .select("id, status")
      .eq("org_id", orgId)
      .eq("id", quoteId)
      .maybeSingle();
    if (exErr) throw new Error(exErr.message);
    if (!existing) return { ok: false, error: "Quote not found." };
    if (existing.status !== "draft") {
      return { ok: false, error: "This quote has been submitted to Cin7 and can no longer be deleted here." };
    }
    const { error: delErr } = await db.from("quotes").delete().eq("org_id", orgId).eq("id", quoteId);
    if (delErr) throw new Error(delErr.message);
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}
