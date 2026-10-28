import { cin7Request } from "@/cin7/http";
import type { Cin7Credentials } from "@/cin7/types";

/**
 * Diagnostic only, strictly read-only: fetches the LIVE Cin7 sale detail for a
 * small, named set of orders and returns each fulfilment's Pick/Pack/Ship
 * payload as Cin7 actually sent it, so the Ship contract can be verified
 * before any persistence or queue change is built on it.
 *
 * Why this exists: the repo's typings (`Cin7SaleFulfilmentShipLine`) describe
 * Ship lines as shipment date/carrier/boxes/tracking/IsShipped with no SKU or
 * quantity, taken from Cin7's Apiary spec — which this project has repeatedly
 * found wrong or incomplete. Nothing here normalises the response: the raw
 * fulfilment objects are returned verbatim (credential-shaped keys and signed
 * download links redacted), and `unknownFields` lists every key the live
 * payload carries that the typings below do not declare.
 *
 * Network surface is deliberately minimal and fixed: `GET /saleList?Search=`
 * (order number → sale id) and `GET /sale?ID=` — through the shared
 * `cin7Request` gateway, so the fixed Cin7 origin applies. No method other
 * than GET is ever issued, and this is not a generic proxy: callers cannot
 * choose the path.
 */

export const SHIP_CONTRACT_MAX_ORDERS = 10;
const ORDER_NUMBER_RE = /^[A-Za-z0-9._-]{1,40}$/;

/** Keys the repo's typings already declare, per level — anything else in the live payload is reported as unknown. */
const KNOWN_FULFILMENT_KEYS = new Set(["TaskID", "FulfillmentNumber", "LinkedInvoiceNumber", "FulFilmentStatus", "Pick", "Pack", "Ship"]);
const KNOWN_STAGE_KEYS = new Set(["Status", "Lines"]);
const KNOWN_SHIP_KEYS = new Set(["Status", "RequireBy", "Lines"]);
const KNOWN_PICKPACK_LINE_KEYS = new Set(["SKU", "Name", "Quantity", "Location", "LocationID", "BatchSN", "Box"]);
const KNOWN_SHIP_LINE_KEYS = new Set(["ID", "ShipmentDate", "Carrier", "Boxes", "TrackingNumber", "TrackingURL", "IsShipped"]);

const SECRET_KEY_RE = /^(application-?key|api-?auth\w*|authorization|password|secret|token|access-?token)$/i;
/** Attachment links are signed/expiring (see Cin7SaleAttachment) — never echoed. */
const SIGNED_LINK_KEYS = new Set(["DownloadUrl"]);

/** Recursively copies a JSON value, replacing credential-shaped keys and signed links. Everything else is preserved exactly. */
export function redactRaw(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactRaw);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_RE.test(key) || SIGNED_LINK_KEYS.has(key) ? "[REDACTED]" : redactRaw(v);
    }
    return out;
  }
  return value;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === "object") as Record<string, unknown>[]) : [];
}

function unknownKeys(records: Record<string, unknown>[], known: Set<string>): string[] {
  const found = new Set<string>();
  for (const record of records) for (const key of Object.keys(record)) if (!known.has(key)) found.add(key);
  return [...found].sort();
}

export interface ShipContractFulfilment {
  taskId: unknown;
  fulfilmentNumber: unknown;
  linkedInvoiceNumber: unknown;
  fulfilmentStatus: unknown;
  pickStatus: unknown;
  packStatus: unknown;
  shipStatus: unknown;
  packLines: Record<string, unknown>[];
  /** Total of Pack.Lines[].Quantity — what an AUTHORISED Ship would have to account for. */
  packedQuantity: number;
  shipLines: Record<string, unknown>[];
  /** Verbatim fulfilment object (redacted only for secrets). */
  raw: unknown;
}

export interface ShipContractOrder {
  orderNumber: string;
  saleId: string | null;
  error?: string;
  /** Order-level fields from the /saleList entry (statuses, invoice number, etc.) — verbatim. */
  listEntry?: unknown;
  invoices?: { invoiceNumber: unknown; status: unknown; invoiceDate: unknown; lines: { sku: unknown; quantity: unknown }[]; invoicedQuantity: number }[];
  orderLines?: { sku: unknown; quantity: unknown; backorderQuantity: unknown }[];
  fulfilments?: ShipContractFulfilment[];
  /** Keys present in the live payload that the repo typings do not declare, per level. */
  unknownFields?: {
    fulfilment: string[];
    pickPackStage: string[];
    ship: string[];
    packLine: string[];
    pickLine: string[];
    shipLine: string[];
  };
  /** Top-level keys of the sale detail response, to spot anything related to shipping outside Fulfilments[]. */
  detailTopLevelKeys?: string[];
}

function sumQuantity(lines: Record<string, unknown>[], field = "Quantity"): number {
  return lines.reduce((total, line) => total + (typeof line[field] === "number" ? (line[field] as number) : 0), 0);
}

/** Pure: turns one already-fetched list entry + detail response into the report shape. Exported for tests. */
export function buildShipContractOrder(orderNumber: string, listEntry: Record<string, unknown>, detail: Record<string, unknown>): ShipContractOrder {
  const fulfilments = asRecords(detail.Fulfilments);
  const pickLines: Record<string, unknown>[] = [];
  const packLines: Record<string, unknown>[] = [];
  const shipLines: Record<string, unknown>[] = [];
  const stageObjects: Record<string, unknown>[] = [];
  const shipObjects: Record<string, unknown>[] = [];

  const reported: ShipContractFulfilment[] = fulfilments.map((f) => {
    const pick = (f.Pick ?? {}) as Record<string, unknown>;
    const pack = (f.Pack ?? {}) as Record<string, unknown>;
    const ship = (f.Ship ?? {}) as Record<string, unknown>;
    const fPick = asRecords(pick.Lines);
    const fPack = asRecords(pack.Lines);
    const fShip = asRecords(ship.Lines);
    pickLines.push(...fPick);
    packLines.push(...fPack);
    shipLines.push(...fShip);
    if (f.Pick) stageObjects.push(pick);
    if (f.Pack) stageObjects.push(pack);
    if (f.Ship) shipObjects.push(ship);
    return {
      taskId: f.TaskID,
      fulfilmentNumber: f.FulfillmentNumber,
      linkedInvoiceNumber: f.LinkedInvoiceNumber,
      fulfilmentStatus: f.FulFilmentStatus,
      pickStatus: pick.Status,
      packStatus: pack.Status,
      shipStatus: ship.Status,
      packLines: redactRaw(fPack) as Record<string, unknown>[],
      packedQuantity: sumQuantity(fPack),
      shipLines: redactRaw(fShip) as Record<string, unknown>[],
      raw: redactRaw(f),
    };
  });

  const invoices = asRecords(detail.Invoices).map((inv) => {
    const lines = asRecords(inv.Lines);
    return {
      invoiceNumber: inv.InvoiceNumber,
      status: inv.Status,
      invoiceDate: inv.InvoiceDate,
      lines: lines.map((l) => ({ sku: l.SKU, quantity: l.Quantity })),
      invoicedQuantity: sumQuantity(lines),
    };
  });

  const order = (detail.Order ?? {}) as Record<string, unknown>;

  return {
    orderNumber,
    saleId: typeof listEntry.SaleID === "string" ? listEntry.SaleID : null,
    listEntry: redactRaw(listEntry),
    invoices,
    orderLines: asRecords(order.Lines).map((l) => ({ sku: l.SKU, quantity: l.Quantity, backorderQuantity: l.BackorderQuantity })),
    fulfilments: reported,
    unknownFields: {
      fulfilment: unknownKeys(fulfilments, KNOWN_FULFILMENT_KEYS),
      pickPackStage: unknownKeys(stageObjects, KNOWN_STAGE_KEYS),
      ship: unknownKeys(shipObjects, KNOWN_SHIP_KEYS),
      packLine: unknownKeys(packLines, KNOWN_PICKPACK_LINE_KEYS),
      pickLine: unknownKeys(pickLines, KNOWN_PICKPACK_LINE_KEYS),
      shipLine: unknownKeys(shipLines, KNOWN_SHIP_LINE_KEYS),
    },
    detailTopLevelKeys: Object.keys(detail).sort(),
  };
}

/** Parses a free-text list (commas/whitespace/newlines) into validated, de-duplicated order numbers. Throws on anything malformed. */
export function parseOrderNumbers(input: string): string[] {
  const parts = [...new Set(input.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
  if (!parts.length) throw new Error("Enter at least one order number.");
  if (parts.length > SHIP_CONTRACT_MAX_ORDERS) throw new Error(`At most ${SHIP_CONTRACT_MAX_ORDERS} orders per run.`);
  const bad = parts.find((p) => !ORDER_NUMBER_RE.test(p));
  if (bad) throw new Error(`"${bad}" is not a valid order number.`);
  return parts;
}

/** Read-only. One /saleList lookup + one /sale detail GET per order, sequential (rate limits). */
export async function inspectSaleShipContract(creds: Cin7Credentials, orderNumbers: string[]): Promise<ShipContractOrder[]> {
  const results: ShipContractOrder[] = [];
  for (const orderNumber of orderNumbers) {
    try {
      const list = await cin7Request<{ SaleList?: Record<string, unknown>[] }>(creds, "/saleList", {
        query: { Page: 1, Limit: 5, Search: orderNumber },
      });
      const match = (list.SaleList ?? []).find((entry) => entry.OrderNumber === orderNumber);
      if (!match || typeof match.SaleID !== "string") {
        results.push({ orderNumber, saleId: null, error: `No sale found with Order Number "${orderNumber}"` });
        continue;
      }
      const detail = await cin7Request<Record<string, unknown>>(creds, "/sale", { query: { ID: match.SaleID } });
      results.push(buildShipContractOrder(orderNumber, match, detail));
    } catch (e) {
      results.push({ orderNumber, saleId: null, error: e instanceof Error ? e.message : "Unknown error" });
    }
  }
  return results;
}
