import type { Snapshot } from "./snapshot";

export interface Check { name: string; pass: boolean; detail: string }
const QTY = ["OnHand", "Allocated", "Available", "OnOrder", "InTransit"] as const;

/** The first-live-run contract verdict. Counts and field TYPES only - no stock values, names or identifiers. */
export function contractVerdict(s: Snapshot): { overall: "PASS" | "FAIL"; checks: Check[] } {
  const ep = (p: string) => s.endpoints.find((e) => e.path === p);
  const loc = ep("/ref/location"), av = ep("/ref/productavailability");
  const types = s.verification.fieldTypes;
  const qtyBad = QTY.filter((f) => types[f] !== "number");
  const badPaging = s.endpoints.filter((e) => !e.complete || e.reportedTotal === null || e.records !== e.reportedTotal);
  const badBond = s.stock.filter((r) => r.unrestricted !== r.physical - r.bond || r.usable !== r.unrestricted - r.allocatedUnrestricted);
  const checks: Check[] = [
    { name: "account identity", pass: s.source.identity.status === "VERIFIED", detail: s.source.identity.status },
    { name: "locations endpoint", pass: !!loc && loc.complete && loc.records > 0, detail: loc ? `${loc.records} locations in ${loc.pages} page(s)` : "not read" },
    { name: "Bond location ID", pass: s.locationMapping.bond.verifiedInLocationList, detail: s.locationMapping.bond.verifiedInLocationList ? "configured ID is present in the account's location list" : "configured ID NOT found in the account's location list" },
    { name: "availability structure", pass: !!av && av.records > 0 && types.SKU === "string" && (types.Location === "string" || types.LocationID === "string" || types.LocationId === "string"), detail: av ? `${av.records} rows; SKU ${types.SKU ?? "absent"}, Location ${types.Location ?? types.LocationID ?? types.LocationId ?? "absent"}` : "not read" },
    { name: "stock quantity fields", pass: qtyBad.length === 0, detail: qtyBad.length ? `missing or not numeric: ${qtyBad.join(", ")}` : `${QTY.join(", ")} are all numeric` },
    { name: "pagination", pass: badPaging.length === 0 && s.endpoints.length > 0, detail: s.endpoints.map((e) => `${e.path}: ${e.pages} page(s), ${e.records}/${e.reportedTotal ?? "no total"}`).join("; ") },
    { name: "SKU/location uniqueness", pass: s.verification.skuLocationDuplicatesFound === 0, detail: `${s.verification.skuLocationDuplicatesFound} duplicate problem(s)` },
    { name: "completeness", pass: s.completeness.status === "COMPLETE", detail: s.completeness.status === "COMPLETE" ? "COMPLETE" : `INCOMPLETE (${s.completeness.problems.length} problem(s))` },
    { name: "Bond classification", pass: badBond.length === 0, detail: badBond.length ? `${badBond.length} SKU(s) where Bond is not excluded from usable stock` : "Bond is excluded from unrestricted and usable stock for every SKU" },
    { name: "GET only, no writes", pass: s.source.readOnly === true && s.source.method === "GET" && s.verification.methodsUsed.length === 1 && s.verification.methodsUsed[0] === "GET", detail: `methods used: ${s.verification.methodsUsed.join(",") || "none"}; ${s.verification.requests} request(s)` },
  ];
  return { overall: checks.every((c) => c.pass) ? "PASS" : "FAIL", checks };
}
