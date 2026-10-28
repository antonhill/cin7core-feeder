// Projects -> Cin7: the PURE rules for creating the Advanced Sale of a billing project. Generic (nothing here knows about NewQuip) and
// Cin7-free (no import from src/cin7): the server-side store injects the Cin7 port. Everything is derived from the project's FROZEN
// stage schedule; no figure is recalculated from progress, cost or stock.
import { createHash } from "node:crypto";

export const CREATE_CONFIRMATION_TEXT = "Create a Cin7 Advanced Sale for this project";
export const STALE_CREATION_PENDING_MS = 5 * 60 * 1000;

export const SALE_MESSAGES = {
  safeFailure: "Cin7 rejected the request. No Sale was created.",
  uncertain: "The outcome of the Sale creation is uncertain. Do not retry until it has been reconciled.",
  inFlight: "A Sale creation for this project is already in progress.",
  verification: "The Sale was created but does not read back as planned; it was NOT linked.",
} as const;

/** Stable, searchable key carried in the Cin7 Sale's ExternalID. The project reference already includes the variation code (PRJ-...-V001). */
export const externalIdFor = (projectRef: string): string => `NEWQUIP-PROJECTS-SALE:${projectRef}`;

export interface CreationStageInput { name: string; valueCents: number }
export interface CreationProductInput { sku: string; name: string; quantity: number }
export interface CreationInputs {
  projectRef: string;
  role: "BASE" | "VARIATION";
  customerName: string;
  location: string;
  taxRule: string;
  taxRateBps: number;
  revenueAccount: string;
  contractCents: number;
  stages: CreationStageInput[];
  physicalLines: CreationProductInput[];
  /** YYYY-MM-DD */
  saleOrderDate: string;
}

export interface PlannedCharge { description: string; amountCents: number; taxCents: number }
export interface PlannedLine { sku: string; name: string; quantity: number }
export interface CreationPlan {
  externalId: string;
  role: "BASE" | "VARIATION";
  customer: string;
  location: string;
  taxRule: string;
  revenueAccount: string;
  saleOrderDate: string;
  lines: PlannedLine[];
  charges: PlannedCharge[];
  contractCents: number;
  taxCents: number;
  totalCents: number;
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/**
 * Builds the plan, or explains why it cannot. The contract value is carried as ONE charge per billing stage (so the Sale's commercial
 * content matches the schedule claims are raised against); the stages must total the contract to the cent. VAT is a per-charge MONETARY
 * amount rounded exactly as claims round it, so the Sale's VAT equals the VAT the claims will add up to. Physical lines carry quantity
 * only - they are always sent at R0.
 */
export function buildCreationPlan(i: CreationInputs): { ok: true; plan: CreationPlan; fingerprint: string } | { ok: false; error: string } {
  if (!i.customerName.trim()) return { ok: false, error: "The Cin7 customer name is required." };
  if (!i.location.trim()) return { ok: false, error: "The Cin7 location is required." };
  if (!i.taxRule.trim()) return { ok: false, error: "The project has no tax rule." };
  if (!i.revenueAccount.trim()) return { ok: false, error: "The Cin7 revenue account code is required." };
  if (!Number.isInteger(i.taxRateBps) || i.taxRateBps < 0 || i.taxRateBps > 10_000) return { ok: false, error: "The project's tax rate is not valid." };
  if (!isDate(i.saleOrderDate)) return { ok: false, error: "The Sale date is not a valid YYYY-MM-DD date." };
  if (!Number.isSafeInteger(i.contractCents) || i.contractCents <= 0) return { ok: false, error: i.contractCents < 0 ? "A negative contract value is not supported: Toolbox never creates a negative Sale or a credit note." : "The contract value must be a positive whole number of cents." };

  const stages = i.stages.filter((s) => s.valueCents !== 0); // a zero-value stage carries nothing to bill
  if (stages.length === 0) return { ok: false, error: "The project has no billable stage value." };
  let sum = 0;
  const names = new Set<string>();
  for (const s of stages) {
    if (!Number.isSafeInteger(s.valueCents) || s.valueCents < 0) return { ok: false, error: `Stage "${s.name}" has an invalid value.` };
    if (names.has(s.name)) return { ok: false, error: `Stage name "${s.name}" is used twice.` };
    names.add(s.name);
    sum += s.valueCents;
  }
  if (sum !== i.contractCents) return { ok: false, error: `The stages total ${sum} cents but the contract is ${i.contractCents}; nothing was sent.` };

  const seen = new Set<string>();
  for (const l of i.physicalLines) {
    if (!l.sku.trim() || seen.has(l.sku)) return { ok: false, error: `SKU ${l.sku || "(blank)"} is missing or listed twice.` };
    seen.add(l.sku);
    if (!Number.isFinite(l.quantity) || l.quantity <= 0) return { ok: false, error: `Quantity for ${l.sku} must be a positive number.` };
  }

  const charges: PlannedCharge[] = stages.map((s) => ({
    description: `${i.projectRef} - ${s.name}`, amountCents: s.valueCents, taxCents: Math.round((s.valueCents * i.taxRateBps) / 10_000),
  }));
  const taxCents = charges.reduce((n, c) => n + c.taxCents, 0);
  const plan: CreationPlan = {
    externalId: externalIdFor(i.projectRef), role: i.role, customer: i.customerName.trim(), location: i.location.trim(), taxRule: i.taxRule.trim(),
    revenueAccount: i.revenueAccount.trim(), saleOrderDate: i.saleOrderDate,
    lines: i.physicalLines.map((l) => ({ sku: l.sku, name: l.name, quantity: l.quantity })),
    charges, contractCents: i.contractCents, taxCents, totalCents: i.contractCents + taxCents,
  };
  return { ok: true, plan, fingerprint: createHash("sha256").update(JSON.stringify(plan)).digest("hex") };
}

// ── read-back verification ──────────────────────────────────────────────────

/** What the Sale looks like as read back from Cin7. Money is integer cents or null when Cin7 did not return a readable number. */
export interface SaleReadBack {
  id: string;
  type: string | null;
  orderStatus: string | null;
  customer: string | null;
  externalId: string | null;
  taxRule: string | null;
  lines: Array<{ sku: string | null; quantity: number | null; priceCents: number | null }>;
  charges: Array<{ description: string | null; priceCents: number | null; taxCents: number | null }>;
  invoiceCount: number;
  fulfilmentCount: number;
}

const rand = (c: number) => `R${(c / 100).toFixed(2)}`;

/** Differences between the planned Sale and the Sale Cin7 holds. Empty = it read back exactly as planned. A missing/unreadable value is a difference. */
export function verifyCreatedSale(plan: CreationPlan, s: SaleReadBack): string[] {
  const d: string[] = [];
  if ((s.type ?? "").toLowerCase() !== "advanced sale") d.push(`type is "${s.type ?? "unknown"}", not an Advanced Sale`);
  if ((s.orderStatus ?? "").toUpperCase() !== "AUTHORISED") d.push(`order status is "${s.orderStatus ?? "unknown"}", not AUTHORISED`);
  if (s.customer !== plan.customer) d.push(`customer is "${s.customer ?? "unknown"}" not "${plan.customer}"`);
  if (s.externalId !== plan.externalId) d.push(`ExternalID is "${s.externalId ?? "missing"}" not "${plan.externalId}"`);
  if (s.taxRule !== plan.taxRule) d.push(`tax rule is "${s.taxRule ?? "unknown"}" not "${plan.taxRule}"`);
  if (s.invoiceCount !== 0) d.push(`${s.invoiceCount} invoice(s) already exist`);
  if (s.fulfilmentCount !== 0) d.push(`${s.fulfilmentCount} fulfilment(s) already exist`);

  const got = new Map<string, { qty: number; price: number | null }>();
  for (const l of s.lines) {
    if (!l.sku) { d.push("an order line has no SKU"); continue; }
    const prev = got.get(l.sku);
    got.set(l.sku, { qty: (prev?.qty ?? 0) + (l.quantity ?? Number.NaN), price: l.priceCents });
    if (l.priceCents !== 0) d.push(`line ${l.sku} carries a price (${l.priceCents === null ? "unreadable" : rand(l.priceCents)}); physical lines must be R0`);
  }
  for (const p of plan.lines) {
    const g = got.get(p.sku);
    if (!g) d.push(`${p.sku} is missing from the order`);
    else if (!Number.isFinite(g.qty) || Math.abs(g.qty - p.quantity) > 1e-9) d.push(`${p.sku} quantity ${g.qty} vs planned ${p.quantity}`);
  }
  for (const k of got.keys()) if (!plan.lines.some((p) => p.sku === k)) d.push(`unplanned order line ${k}`);

  if (s.charges.length !== plan.charges.length) d.push(`${s.charges.length} contract charge(s) vs ${plan.charges.length} planned`);
  let net = 0; let tax = 0; let readable = true;
  for (const c of s.charges) {
    if (c.priceCents === null || c.taxCents === null) { readable = false; continue; }
    net += c.priceCents; tax += c.taxCents;
  }
  if (!readable) d.push("contract charge amounts not returned by Cin7");
  else {
    if (net !== plan.contractCents) d.push(`contract value ${rand(net)} vs planned ${rand(plan.contractCents)}`);
    if (tax !== plan.taxCents) d.push(`contract VAT ${rand(tax)} vs planned ${rand(plan.taxCents)}`);
  }
  for (const c of plan.charges) {
    if (!s.charges.some((x) => x.description === c.description && x.priceCents === c.amountCents && x.taxCents === c.taxCents)) d.push(`charge "${c.description}" (${rand(c.amountCents)} + ${rand(c.taxCents)} VAT) not found as planned`);
  }
  return d;
}

export const isStaleCreationPending = (requestedAt: string, now: number = Date.now()): boolean => now - Date.parse(requestedAt) > STALE_CREATION_PENDING_MS;
