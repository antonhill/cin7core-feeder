/**
 * Presentation only: the demonstration journey opens Scenario B on the style that has a bill of material, because the first
 * style in the workbook has none and would open as INCOMPLETE. No calculation depends on this; an unknown style falls back to the
 * page's existing default.
 */
export const SCENARIO_B_DEMO_STYLE = "RVEST-2T-NVL";
export const scenarioHref = (slug: string): string => (slug === "scenario-b" ? `/${slug}?style=${SCENARIO_B_DEMO_STYLE}` : `/${slug}`);
