import { isOptionalItemKey } from "./types";

/** Who may CHOOSE a Cin7 product for a quotation line. The server enforces the same rule on every search and save (a Rep is refused); this only decides what the screen offers. */
export const canMapProducts = (roles: ReadonlySet<string>): boolean => roles.has("estimator") || roles.has("manager");

export type MappingControl = "chooser" | "waiting_for_estimator" | "none";

/**
 * What the Line decisions row offers for an optional additional element (GROWER-OPT-001..007) that is IN the quotation. The chooser sits in the same row
 * that says "Product mapping not yet confirmed", so the fix is where the problem is shown. A Rep (or a read-only view) is told who maps it instead.
 */
export function mappingControlFor(itemKey: string, basis: string, roles: ReadonlySet<string>, editable: boolean): MappingControl {
  if (!isOptionalItemKey(itemKey) || basis === "not_selected") return "none";
  return editable && canMapProducts(roles) ? "chooser" : "waiting_for_estimator";
}
