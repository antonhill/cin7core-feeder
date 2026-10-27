// Final NewQuip POC decisions from Sean, received 2026-10-27.
// This file is intentionally NewQuip-domain configuration. Do not move these values into generic Toolbox modules.

export const GROWER_TEMPLATE = {
  id: "grower-house-v1",
  name: "Grower House Template v1",
  version: "1.0",
  status: "active",
} as const;

export const FINAL_GROWER_DECISIONS = {
  pigsBasis: "per_room",
  lighting: {
    minimumM2PerLight: 25,
    rounding: "ceil",
    upwardOverrideAllowed: true,
    overrideReasonRequired: true,
  },
  feeder: {
    capacityPigs: 45,
    baseSku: "PNQ082",
    windowSku: "PNQ082-WINDOW",
    quantityTreatment: "estimator_confirmed",
  },
  drinker: {
    pigsPerDrinker: 15,
    quantityTreatment: "suggest_then_estimator_confirm",
  },
  slats: {
    quantityTreatment: "estimator_input",
  },
  penning: {
    unit: "running_metre",
    rateExVatByPigSize: {
      SMALL: 1300,
      MEDIUM: 1500,
      LARGE: 2200,
    },
  },
  m75: {
    treatment: "estimator_input",
    reason: "System size is a client preference; reps select/configure it manually for the POC.",
  },
  ventilation: {
    optionalInsideGrower: true,
    treatment: "engineering_review",
    reference: "AS.03",
  },
  pricing: {
    pocPriceSource: "newquip_master_workbook",
    projectMarkupPctOnLandedCost: 20,
    zeroPriceTreatment: "supplier_quote_required",
  },
  workflow: {
    customerConfirmedAt: "rep_to_estimator_handoff",
    states: ["REP_DRAFT", "ESTIMATOR_REVIEW", "MANAGER_APPROVED_FINAL"],
    managerCreatesAcceptedBaseline: true,
  },
  project: {
    stages: ["Deposit", "Manufacturing", "Equipment Ready", "Delivery", "Installation", "Commissioning"],
    physicalProgressRoles: ["rep", "estimator"],
    commercialApprovalRoles: ["manager"],
  },
  variations: {
    raiseAndPriceRoles: ["estimator", "manager"],
    approvalRoles: ["manager"],
    postAcceptanceChangesMustBeVariations: true,
    separateCommercialCommitment: true,
  },
  integrations: {
    cin7: "read_only",
    xero: "out_of_poc",
  },
  governance: {
    engineeringRuleAuthority: "Shirnel",
    productMappingAuthority: "Shirnel",
    commercialPricingAuthority: "Shirnel",
  },
} as const;
