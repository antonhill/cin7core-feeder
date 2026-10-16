// ROUND 3 — what is still OPEN after Sean's Round 2 answers. These are NOT resolved anywhere in code: each one is
// surfaced to the estimator and in docs/newquip-grower-poc-rule-register.md. Never mark an item resolved without NewQuip's
// written answer. (Source: NewQuip_Grower_POC_Sean_Validation_v3_Round2 feedback.xlsx + the owner's Round 2 brief.)

export type Round3Priority = "BLOCKER" | "HIGH" | "MEDIUM";

export interface Round3Item {
  n: number;
  priority: Round3Priority;
  topic: string;
  question: string;
  /** What the configurator does meanwhile. */
  interim: string;
  status: "OPEN";
}

export const ROUND3_OPEN_ITEMS: Round3Item[] = [
  { n: 1, priority: "BLOCKER", topic: "Project pricing", status: "OPEN",
    question: "What exactly does \"Project = Cost + 20%\" mean? The Master shows Cost, ROE, Freight and MU as distinct, and MU is not universally 20%.",
    interim: "Project quotes show ESTIMATOR PRICING REQUIRED; the estimator enters the selling price. No formula is applied." },
  { n: 2, priority: "BLOCKER", topic: "Price source of truth", status: "OPEN",
    question: "Should production pricing come from the NewQuip Master Excel, Cin7 Core, or another controlled source?",
    interim: "Interim: Cin7 synced price tiers, shown explicitly on the budget. The source is swappable." },
  { n: 3, priority: "HIGH", topic: "CCM feeder quantity / rounding", status: "OPEN",
    question: "Exact feeder quantity rule (45 pigs per CCM feeder): rounding, per-pen vs total, hospital / split pens.",
    interim: "Capacity is shown; the estimator enters and confirms the quantity." },
  { n: 4, priority: "HIGH", topic: "Drinker rounding / minimum", status: "OPEN",
    question: "Rounding and per-pen minimum for 15 pigs per drinker; hospital / split-pen behaviour; why Topigs used 54.",
    interim: "A suggested figure is shown (unrounded); the estimator confirms the quantity." },
  { n: 5, priority: "HIGH", topic: "Slat area → units / wastage", status: "OPEN",
    question: "How slatted floor area converts to slats (wastage, rounding, custom sizes).",
    interim: "The estimator enters the slatted floor area and the final slat quantity." },
  { n: 6, priority: "HIGH", topic: "Penning running-metre rates / products", status: "OPEN",
    question: "Current running-metre rate and SKU for small / medium / large pig sizes, and tier breaks.",
    interim: "The estimator selects the pig size and enters running metres; pricing is ESTIMATOR PRICING REQUIRED." },
  { n: 7, priority: "HIGH", topic: "NQ3132 pricing treatment", status: "OPEN",
    question: "The Master shows Retail 0 for NQ3132 (replaces TRA1.1KW3PH). What is the current commercial price treatment?",
    interim: "PRICING EXCEPTION — ESTIMATOR REVIEW REQUIRED. Never quoted as zero." },
  { n: 8, priority: "MEDIUM", topic: "FORTIS 1.2 SKU", status: "OPEN",
    question: "What is the current SKU for FORTIS 1.2 (and the correct clip / cable SKUs)?",
    interim: "FORTIS 1.2 — SKU REQUIRED / UNMAPPED. HNQ7046 (FERAX) is shown as a historic surrogate only and never substituted." },
  { n: 9, priority: "MEDIUM", topic: "Fan / cooling / controller standard scope", status: "OPEN",
    question: "Which fans, cooling and controllers belong in the standard Grower scope (the earlier Grower quote that included fans has not been ingested).",
    interim: "Ventilation / cooling is PENDING REFERENCE QUOTE VALIDATION. No fan SKU, quantity, cooling or controller rule is invented." },
  { n: 10, priority: "MEDIUM", topic: "Customer / agent price-tier behaviour (day-to-day)", status: "OPEN",
    question: "How the customer's / agent's price tier applies to day-to-day quotes.",
    interim: "The rep chooses the price tier (defaulted from the customer when Cin7 has one)." },
];

/** Ventilation / cooling scope: explicitly NOT yet validated. */
export const VENTILATION_SCOPE_STATUS = "PENDING REFERENCE QUOTE VALIDATION" as const;

/** One-line meaning of "room", shown beside the rooms input. Confirmed by Sean Round 2 #1. */
export const ROOMS_HELP = "An actual room within a building. 6 buildings × 2 rooms = 12 rooms. Every per-room quantity is multiplied by this number.";
