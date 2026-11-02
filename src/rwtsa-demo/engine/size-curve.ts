/**
 * The size distribution the client documents for splitting a style-level purchase-order quantity to sizes.
 * Source: RWTSA ERP Demo Data Slice Clarifications Rev 2 (29 Oct 2026), section B "Size split": "Split bulk PO quantities by the
 * standard size curve implied by the Items min-levels / reorder points: S, M, L, XL, 2XL, 3XL, 4XL, 5XL = 10 / 20 / 24 / 20 /
 * 12 / 8 / 4 / 2 %". The workbook ReadMe repeats it. Weights are percentages; only their ratios matter.
 */
export const REV2_SIZE_CURVE: Readonly<Record<string, number>> = { S: 10, M: 20, L: 24, XL: 20, "2XL": 12, "3XL": 8, "4XL": 4, "5XL": 2 };
export const REV2_CURVE_LABEL = "RWTSA Rev2 size curve: S 10 / M 20 / L 24 / XL 20 / 2XL 12 / 3XL 8 / 4XL 4 / 5XL 2 %";
export const REV2_CURVE_PROVENANCE = "RWTSA ERP Demo Data Slice Clarifications Rev 2 (29 Oct 2026), section B 'Size split'; repeated in the workbook ReadMe; implied by the Items minimum-level and reorder-point split.";
