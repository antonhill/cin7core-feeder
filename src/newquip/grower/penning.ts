import { FEEDBACK_2026_11 } from "./commercial";
import type { GrowerConfigurationInput, PenningPigSize } from "./types";

// GROWER PENNING AS A COMPONENT SYSTEM (Sean / Tereesha 2026-11, Penning sheet). Pure; no I/O, no price, no quantity of a component.
//
// The COMMERCIAL line is unchanged: running metres x the approved rate for the pig size (commercial.ts / quote-bridge.ts). This module adds the SCOPE a build needs and that estimating and handover
// will read: which post, cap, hinge, lock and gate components exist, and the custom polypropylene PANEL specification. It deliberately emits NO component quantity: post spacing, the number of door
// and gate openings, panel cutting and wastage, and handedness are not supplied engineering rules, so each is an explicit Estimator decision rather than an invented number.

export type PenningRole = "door_cap" | "gate_kit" | "door_hinge_post" | "gate_hinge_post" | "starter_post" | "door_lock_post" | "support_post" | "gate_lock_post" | "centre_post" | "z_section_post";
export interface PenningComponent {
  sku: string;
  role: PenningRole;
  /** The Cin7 product name (synced catalogue copy; the live product is re-checked at sign-off). */
  name: string;
  heightMm: number | null;
  hand: "left" | "right" | null;
  /** Where it applies, in plain words. */
  application: string;
}

const C = (sku: string, role: PenningRole, name: string, heightMm: number | null, hand: PenningComponent["hand"], application: string): PenningComponent => ({ sku, role, name, heightMm, hand, application });

/** Every component on Sean's Grower Penning Posts list. All are for the 50 mm panel. No Cin7 product is created or changed. */
export const PENNING_COMPONENTS: readonly PenningComponent[] = [
  C("KNQ085", "door_cap", "CAP FOR DOOR SST (H=780MM) / 50MM PANEL", 780, null, "Door post cap, 780 mm"),
  C("KNQ085-880MM", "door_cap", "CAP FOR DOOR SST (H=880MM) / 50MM PANEL", 880, null, "Door post cap, 880 mm"),
  C("KNQ085-980MM", "door_cap", "CAP FOR DOOR SST (H=980MM) / 50MM PANEL", 980, null, "Door post cap, 980 mm"),
  C("KNQ074-A", "gate_kit", "PLASTIC DOOR KIT (FOR GATES) WITHOUT BOLTS", null, null, "Plastic gate (door) kit, bolts not included"),
  C("KNQ042-900", "door_hinge_post", "SST L/H DOOR POST HINGE (50MM PANEL) H=900MM", 900, "left", "Door post, hinge side, left hand"),
  C("KNQ043-900", "door_hinge_post", "SST R/H DOOR POST HINGE (50MM PANEL) H=900MM", 900, "right", "Door post, hinge side, right hand"),
  C("KNQ044-900", "gate_hinge_post", "SST GATE POST HINGE (50MM PANEL) H=900MM", 900, null, "Gate post, hinge side"),
  C("KNQ045-900", "starter_post", "SST STARTER POST H=900MM (50MM PANEL)", 900, null, "Starter post"),
  C("KNQ048-900", "door_lock_post", "SST L/H DOOR POST LOCK (50MM PANEL) H=900MM", 900, "left", "Door post, lock side, left hand"),
  C("KNQ049-900", "door_lock_post", "SST R/H DOOR POST LOCK (50MM PANEL) H = 900MM", 900, "right", "Door post, lock side, right hand"),
  C("KNQ050-900", "support_post", "SST HEAVY DUTY SUPPORT POST (50MM PANEL) H=900MM", 900, null, "Heavy-duty support post (also the confirmed M75 support post)"),
  C("KNQ051-900", "gate_lock_post", "SST L/H GATE POST LOCK COMPLET (50MM PANEL) H=900M", 900, "left", "Gate post, lock side, left hand, complete"),
  C("KNQ052-900", "gate_lock_post", "SST R/H GATE POST LOCK COMPLETE (50MM PANEL) H=900", 900, "right", "Gate post, lock side, right hand, complete"),
  C("KNQ079-900", "centre_post", "CENTER 4-WAY POST H=900MM (EXCL CAP) / 50MM PANEL", 900, null, "Centre 4-way post, excluding its cap"),
  C("KNQ130-900", "z_section_post", "SST Z-SECTION POST (HEIGHT=900MM)", 900, null, "Z-section post"),
];

/**
 * The custom polypropylene panel. Panel codes (KNQPP001-015 in the worksheet) are opened IN CIN7 WHEN THE ORDER IS PLACED, because every order is a custom size from the room dimensions. So a
 * quotation carries a SPECIFICATION, never an existing SKU, and nothing here creates or looks up a panel product. The listed heights, colours and lengths are the worksheet's EXAMPLES, not a rule.
 */
export const PENNING_PANEL = {
  material: "Polypropylene panel, ventilated",
  thicknessMm: 50,
  exampleColours: ["GREEN", "BLACK"],
  exampleHeightsMm: [880, 900, 950, 1000],
  skuStatus: "No SKU at quotation: the panel code is created when the order is placed.",
  source: FEEDBACK_2026_11,
} as const;

export interface PenningScope {
  roomLengthM: number; roomWidthM: number; rooms: number;
  pigSize: PenningPigSize | null;
  /** The Estimator-entered running metres for ONE room (not derived), or null while not entered. */
  runningMetresPerRoom: number | null;
  /** Per-room metres x rooms: the quantity the commercial line already uses. */
  projectRunningMetres: number | null;
  /** The room's outer perimeter, 2 x (length + width), shown as CONTEXT only. The pen layout decides the real running metres, so this is never used as a quantity. */
  roomPerimeterReferenceM: number;
  components: ReadonlyArray<PenningComponent & { quantity: null; quantityStatus: "estimator_decision" }>;
  panel: typeof PENNING_PANEL & { requiredFromEstimator: string[] };
  /** What the Estimator must decide, in plain words. Empty only when nothing is outstanding (never, today: the engineering rules are not supplied). */
  decisions: string[];
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function penningScope(input: Pick<GrowerConfigurationInput, "lengthM" | "widthM" | "rooms" | "penningPigSize" | "penningRunningMetresPerRoom">): PenningScope {
  const rm = input.penningRunningMetresPerRoom != null && Number.isFinite(input.penningRunningMetresPerRoom) && input.penningRunningMetresPerRoom >= 0 ? input.penningRunningMetresPerRoom : null;
  const decisions = [
    ...(!input.penningPigSize ? ["Select the pig size (it sets the running-metre rate)."] : []),
    ...(rm === null ? ["Enter the penning running metres for one room (it depends on the pen layout, so it is not derived from the room size)."] : []),
    "Number and placement of door and gate openings, and whether each is a door (KNQ074-A kit, door posts) or a gate (gate posts).",
    "Post arrangement: starter, centre 4-way, Z-section and support posts. Post spacing is not supplied, so no count is calculated.",
    "Door hand (left / right) and cap height (780 / 880 / 980 mm) for each opening.",
    "Panel colour and height, and the cut length of each panel run. Cutting and wastage rules are not supplied.",
  ];
  return {
    roomLengthM: input.lengthM, roomWidthM: input.widthM, rooms: input.rooms,
    pigSize: input.penningPigSize ?? null,
    runningMetresPerRoom: rm,
    projectRunningMetres: rm === null ? null : r2(rm * input.rooms),
    roomPerimeterReferenceM: r2(2 * (input.lengthM + input.widthM)),
    components: PENNING_COMPONENTS.map((c) => ({ ...c, quantity: null, quantityStatus: "estimator_decision" as const })),
    panel: { ...PENNING_PANEL, requiredFromEstimator: ["colour", "height (mm)", "cut length of each run (mm)", "number of panels"] },
    decisions,
  };
}
