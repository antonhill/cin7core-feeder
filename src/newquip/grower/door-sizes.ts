// PVC SST DOOR SIZES (NewQuip handoff 2026-11-25 s1; Sean / Teresa 2026-11-24). The Rep chooses the size EXPLICITLY; nothing defaults it. Each size has its own Budget basis (an entry in the Manager-controlled
// register, matched by `specification`) and its own Cin7 product code (NQ3444 / NQ3444-B) for the Estimator. No cost is held here: the evidenced BOM costs live in the register entries, each with its own approval.
export type DoorSize = "2.1x1.2" | "2.1x1.0";
export const DOOR_SIZES: Readonly<Record<DoorSize, { label: string; sku: string; specification: string }>> = {
  "2.1x1.2": { label: "2.1 m × 1.2 m", sku: "NQ3444", specification: "PVC single door 2.1 x 1.2 m (NQ3444)" },
  "2.1x1.0": { label: "2.1 m × 1.0 m", sku: "NQ3444-B", specification: "PVC single door 2.1 x 1.0 m (NQ3444-B)" },
};
export const DOOR_SIZE_KEYS = Object.keys(DOOR_SIZES) as DoorSize[];
export const isDoorSize = (v: unknown): v is DoorSize => typeof v === "string" && Object.prototype.hasOwnProperty.call(DOOR_SIZES, v);
export const doorSpecificationFor = (size: unknown): string | null => (isDoorSize(size) ? DOOR_SIZES[size].specification : null);

/** The reason on a door line whose size the Rep has not chosen. Rep-owned: stage1-steps routes it to the Rep's Equipment step, not to the Estimator. */
export const DOOR_SIZE_REQUIRED_REASON = "Choose the door size to price this item.";
