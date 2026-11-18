import "server-only";

// FIGURES SEAN / TEREESHA SUPPLIED (2026-11). SERVER-ONLY ON PURPOSE: these are supplier cost figures, so they must never be imported by a client component (that would ship them in the JavaScript
// every viewer downloads, a Rep included). They reach a cost-entitled viewer only through a server action. Each is a labelled REFERENCE: never a selling price, never a verified landed cost, and never
// silently replacing a Cin7 supplier cost. A figure that differs from Cin7 is a PROPOSED sourced override until its basis and applicable date are established.

export interface SuppliedFigure { sku: string; amountZar: number; per: "each" | "metre"; note: string; basis: string }

export const SUPPLIED_COSTS: ReadonlyArray<SuppliedFigure> = [
  { sku: "NQ1942", amountZar: 30, per: "each", note: "M75 complete drop kit", basis: "A component figure only: not the drop-kit package cost, not the M75 system price, and its basis (cost, landed cost or price) is not stated. Cin7 holds no supplier record for NQ1942." },
  { sku: "NQ.TUBE.63", amountZar: 52.72, per: "each", note: "63mm clear drop tube (not in the synced catalogue copy)", basis: "A component figure only; its basis is not stated." },
  { sku: "NQ3444", amountZar: 9000, per: "each", note: "PVC door: mixture of Kunlong and local parts", basis: "Not stated whether this is a supplier cost, a landed cost or a price: it is NOT a selling price, no markup is applied to it, and it is not an approved cost." },
  { sku: "NQ1163", amountZar: 57.37, per: "metre", note: "Auger quoted per metre; Cin7 unit is Item", basis: "'Quoted per meter, use a per meter cost.' Cin7 reports the unit as Item and holds its own supplier cost for NQ1163; the two have NOT been reconciled and no conversion between them is established." },
  { sku: "NQ1764", amountZar: 119.79, per: "each", note: "M75 tube clamp", basis: "Confirmed as the new imported cost; applicable date not stated." },
  { sku: "NQ1017", amountZar: 3.14, per: "each", note: "Washer M8x25x2", basis: "Confirmed as the new imported cost; applicable date not stated." },
  { sku: "NYNUT", amountZar: 0.82, per: "each", note: "Nylock nut M8", basis: "Confirmed as the new imported cost; applicable date not stated." },
];
