// Projects -> Cin7: reduces the raw `Fulfilments` of a Sale read back from Cin7 to explicit FACTS, so verifyCreatedSale can tell an EMPTY fulfilment
// container (Cin7 creates one for a commercial-only Advanced Sale: Pick/Pack/Ship all AUTHORISED with no lines) from real physical activity.
// Pure and Cin7-free (it takes `unknown`). It never trusts a status: FULFILLED is what the empty container itself reports. Anything it cannot read
// positively is recorded in `unreadable`, and verification treats unreadable as a failure (fail closed).

export interface ReadBackStage { lineCount: number; totalQuantity: number }
export interface ReadBackShip { lineCount: number; shippedCount: number; hasShipmentDate: boolean }
export interface ReadBackFulfilment {
  number: number | null;
  /** The invoice this fulfilment is linked to, if any (Cin7 uses "" when none). */
  linkedInvoice: string | null;
  pick: ReadBackStage;
  pack: ReadBackStage;
  ship: ReadBackShip;
  /** Reasons the fulfilment could not be read with certainty. Non-empty means it must not be treated as empty. */
  unreadable: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The only fields Cin7 documents on a stage (src/cin7/sales.ts). Any other key might carry stock we do not understand, so it makes the fulfilment unreadable. */
const PICK_PACK_KEYS = new Set(["Status", "Lines"]);
const SHIP_KEYS = new Set(["Status", "RequireBy", "Lines"]);
function unknownKeys(stage: Record<string, unknown>, name: string, allowed: Set<string>, unreadable: string[]) {
  for (const k of Object.keys(stage)) if (!allowed.has(k)) unreadable.push(`${name} has an unexpected field "${k.slice(0, 40)}"`);
}

/** Lines of a stage: absent = none; present must be a list of objects. */
function linesOf(stage: Record<string, unknown>, name: string, unreadable: string[]): Array<Record<string, unknown>> {
  const l = stage.Lines;
  if (l === undefined || l === null) return [];
  if (!Array.isArray(l)) { unreadable.push(`${name} lines are not a list`); return []; }
  const out: Array<Record<string, unknown>> = [];
  for (const x of l) { if (isObj(x)) out.push(x); else unreadable.push(`${name} has a line that cannot be read`); }
  return out;
}

function stageOf(raw: unknown, name: string, unreadable: string[]): ReadBackStage {
  if (!isObj(raw)) { unreadable.push(`${name} is missing`); return { lineCount: 0, totalQuantity: 0 }; }
  unknownKeys(raw, name, PICK_PACK_KEYS, unreadable);
  const lines = linesOf(raw, name, unreadable);
  let total = 0;
  for (const l of lines) {
    const q = l.Quantity;
    if (q === undefined || q === null || q === "" || !Number.isFinite(Number(q))) unreadable.push(`${name} has a line with no readable quantity`);
    else total += Number(q);
  }
  return { lineCount: lines.length, totalQuantity: total };
}

function shipOf(raw: unknown, unreadable: string[]): ReadBackShip {
  if (!isObj(raw)) { unreadable.push("Ship is missing"); return { lineCount: 0, shippedCount: 0, hasShipmentDate: false }; }
  unknownKeys(raw, "Ship", SHIP_KEYS, unreadable);
  const lines = linesOf(raw, "Ship", unreadable);
  return {
    lineCount: lines.length,
    shippedCount: lines.filter((l) => l.IsShipped === true).length,
    hasShipmentDate: lines.some((l) => typeof l.ShipmentDate === "string" && l.ShipmentDate.trim() !== ""),
  };
}

/** `raw` is the Sale's `Fulfilments` value exactly as Cin7 returned it. Absent/null = no fulfilments; anything not a list is unreadable. */
export function readBackFulfilments(raw: unknown): ReadBackFulfilment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return [{ number: null, linkedInvoice: null, pick: { lineCount: 0, totalQuantity: 0 }, pack: { lineCount: 0, totalQuantity: 0 }, ship: { lineCount: 0, shippedCount: 0, hasShipmentDate: false }, unreadable: ["Fulfilments is not a list"] }];
  return raw.map((f): ReadBackFulfilment => {
    const unreadable: string[] = [];
    if (!isObj(f)) return { number: null, linkedInvoice: null, pick: { lineCount: 0, totalQuantity: 0 }, pack: { lineCount: 0, totalQuantity: 0 }, ship: { lineCount: 0, shippedCount: 0, hasShipmentDate: false }, unreadable: ["a fulfilment cannot be read"] };
    const n = f.FulfillmentNumber === undefined || f.FulfillmentNumber === null || f.FulfillmentNumber === "" ? Number.NaN : Number(f.FulfillmentNumber);
    const inv = typeof f.LinkedInvoiceNumber === "string" ? f.LinkedInvoiceNumber.trim() : f.LinkedInvoiceNumber === undefined || f.LinkedInvoiceNumber === null ? "" : (unreadable.push("the linked invoice cannot be read"), "");
    return {
      number: Number.isFinite(n) ? n : null, linkedInvoice: inv || null,
      pick: stageOf(f.Pick, "Pick", unreadable), pack: stageOf(f.Pack, "Pack", unreadable), ship: shipOf(f.Ship, unreadable), unreadable,
    };
  });
}

/** Why a fulfilment is NOT an empty container (empty array = it is empty and readable). */
export function fulfilmentActivity(f: ReadBackFulfilment): string[] {
  const label = `fulfilment ${f.number ?? "(unnumbered)"}`;
  const r: string[] = [];
  for (const u of f.unreadable) r.push(`${label} cannot be read: ${u}`);
  if (f.pick.lineCount > 0 || f.pick.totalQuantity !== 0) r.push(`${label} has picked stock (${f.pick.lineCount} line(s), quantity ${f.pick.totalQuantity})`);
  if (f.pack.lineCount > 0 || f.pack.totalQuantity !== 0) r.push(`${label} has packed stock (${f.pack.lineCount} line(s), quantity ${f.pack.totalQuantity})`);
  if (f.ship.lineCount > 0) r.push(`${label} has ${f.ship.lineCount} shipment line(s)`);
  if (f.ship.shippedCount > 0) r.push(`${label} has shipped units`);
  if (f.ship.hasShipmentDate) r.push(`${label} has a shipment date`);
  if (f.linkedInvoice) r.push(`${label} is linked to invoice ${f.linkedInvoice}`);
  return r;
}
