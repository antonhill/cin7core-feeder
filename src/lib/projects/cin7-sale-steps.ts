import type { RailStep } from "@/components/ui/step-rail-model";

// CIN7 SALE CREATION STEPS (pure). Four steps over the panel that already exists. A step's status comes ONLY from the panel's own state (scope blockers, the four typed Cin7
// references, the last pre-flight result, the confirmation tick, the creation record) and never from the step having been visited. The steps are navigation and guidance:
// nothing here enables, disables or authorises Create (the panel's existing gates do that) and nothing here calls an action.
//
//   1 Resolve scope   2 Cin7 references   3 Preflight check (optional)   4 Confirm & create

export type SaleStepId = "scope" | "refs" | "preflight" | "confirm";
export const SALE_STEP_IDS: readonly SaleStepId[] = ["scope", "refs", "preflight", "confirm"];
export const SALE_STEP_LABEL: Record<SaleStepId, string> = { scope: "Resolve scope", refs: "Cin7 references", preflight: "Preflight check (optional)", confirm: "Confirm & create" };

export interface SaleStepInput {
  /** `status.blockers.length` and the unmapped, unresolved scope items. */
  blockerCount: number;
  unresolvedCount: number;
  customer: string;
  location: string;
  account: string;
  taxRule: string;
  /** The last pre-flight result: null when none ran. `inputsKey` is the references it was run with. */
  preflight: { verdictReady: boolean; inputsKey: string } | null;
  confirmed: boolean;
  /** The creation record, if one exists (the Create form is then gone). */
  creationState: string | null;
}

export const referencesKey = (r: { customer: string; location: string; account: string; taxRule: string }) => JSON.stringify([r.customer.trim(), r.location.trim(), r.account.trim(), r.taxRule.trim()]);

export function missingReferences(r: { customer: string; location: string; account: string; taxRule: string }): string[] {
  return [["customer name", r.customer], ["location", r.location], ["revenue account", r.account], ["tax rule", r.taxRule]].filter(([, v]) => !v.trim()).map(([k]) => k);
}

/** The three things the final step lists next to Create. Facts the viewer already has: nothing that is hidden from them. */
export function saleRequirements(i: Pick<SaleStepInput, "blockerCount" | "unresolvedCount" | "customer" | "location" | "account" | "taxRule" | "confirmed">): Array<{ id: string; label: string; met: boolean }> {
  return [
    { id: "scope", label: "Scope resolved", met: i.blockerCount === 0 && i.unresolvedCount === 0 },
    { id: "refs", label: "Cin7 references entered", met: missingReferences(i).length === 0 },
    { id: "confirm", label: "Confirmation ticked", met: i.confirmed },
  ];
}

/** Steps "Next incomplete step" may jump to: the optional pre-flight never pulls the viewer there (it is skipped, not completed). */
export const guidedSteps = (steps: readonly RailStep[]): RailStep[] => steps.map((s) => (s.optional && s.status !== "attention" ? { ...s, status: "unavailable" as const } : s));
/** True only when every REQUIRED step is complete (the optional pre-flight does not count). */
export const requiredStepsComplete = (steps: readonly RailStep[]): boolean => steps.filter((s) => !s.optional).every((s) => s.status === "complete");

export function saleSteps(i: SaleStepInput): RailStep[] {
  const created = i.creationState !== null;
  const open = i.blockerCount + i.unresolvedCount > 0;
  const scope: RailStep = created
    ? { id: "scope", label: SALE_STEP_LABEL.scope, status: open ? "attention" : "complete" }
    : open ? { id: "scope", label: SALE_STEP_LABEL.scope, status: "attention", note: `${Math.max(i.blockerCount, i.unresolvedCount)} to resolve` } : { id: "scope", label: SALE_STEP_LABEL.scope, status: "complete" };
  const missing = missingReferences(i);
  const refs: RailStep = created ? { id: "refs", label: SALE_STEP_LABEL.refs, status: "unavailable", note: "Sale already requested" }
    : missing.length === 0 ? { id: "refs", label: SALE_STEP_LABEL.refs, status: "complete" } : { id: "refs", label: SALE_STEP_LABEL.refs, status: "incomplete", note: `Missing: ${missing.join(", ")}` };
  const stale = i.preflight !== null && i.preflight.inputsKey !== referencesKey(i);
  const preflight: RailStep = created ? { id: "preflight", label: SALE_STEP_LABEL.preflight, status: "unavailable", note: "Sale already requested" }
    : i.preflight === null ? { id: "preflight", label: SALE_STEP_LABEL.preflight, status: "incomplete", optional: true }
    : stale ? { id: "preflight", label: SALE_STEP_LABEL.preflight, status: "incomplete", optional: true, note: "References changed since the last check" }
    : i.preflight.verdictReady ? { id: "preflight", label: SALE_STEP_LABEL.preflight, status: "complete", optional: true }
    : { id: "preflight", label: SALE_STEP_LABEL.preflight, status: "attention", optional: true, note: "Last check: not ready" };
  const confirm: RailStep = created
    ? i.creationState === "RECONCILED" ? { id: "confirm", label: SALE_STEP_LABEL.confirm, status: "complete" } : { id: "confirm", label: SALE_STEP_LABEL.confirm, status: "attention", note: "Not yet verified" }
    : { id: "confirm", label: SALE_STEP_LABEL.confirm, status: "incomplete", note: i.confirmed ? "Confirmation ticked" : undefined };
  return [scope, refs, preflight, confirm];
}
