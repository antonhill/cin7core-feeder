import type { QuoteRole } from "@/newquip/quote/roles";
import type { ApprovalDocType } from "./types";

// NewQuip FUNCTIONAL ROLES and APPROVAL POLICIES (pure; safe for client and server). The platform's two organisation tiers (member, owner/admin) stay in
// place for account administration; a functional role says what a person does in the quotation / project / approval process. One person may hold several.

export const FUNCTIONAL_ROLES = ["REP", "ESTIMATOR", "MANAGER", "PROJECT_MANAGER", "PROCUREMENT", "ADMINISTRATOR"] as const;
export type FunctionalRole = (typeof FUNCTIONAL_ROLES)[number];
export const ROLE_LABEL: Record<FunctionalRole, string> = {
  REP: "Salesperson / Rep", ESTIMATOR: "Estimator", MANAGER: "Manager", PROJECT_MANAGER: "Project Manager", PROCUREMENT: "Procurement", ADMINISTRATOR: "Administrator",
};
export const ROLE_DESCRIPTION: Record<FunctionalRole, string> = {
  REP: "Captures and submits commercial quotations.",
  ESTIMATOR: "Reviews scope, quantities, costing and margin; signs a quotation off.",
  MANAGER: "Approves commercial quotations, claims and variations.",
  PROJECT_MANAGER: "Manages project activity and submits claims.",
  PROCUREMENT: "Reviews purchasing requirements and approved cost targets.",
  ADMINISTRATOR: "Maintains users, roles, templates and approval policies. Does not approve unless also a Manager.",
};
export const isFunctionalRole = (v: unknown): v is FunctionalRole => typeof v === "string" && (FUNCTIONAL_ROLES as readonly string[]).includes(v);

export type ApprovalStage = "ESTIMATOR" | "MANAGER";
export const STAGE_LABEL: Record<ApprovalStage, string> = { ESTIMATOR: "Estimator review", MANAGER: "Manager approval" };
export interface StagePolicy { stage: ApprovalStage; role: FunctionalRole; /** A named approver; null = any holder of the role. */ approverEmail: string | null }
export type PolicySet = Record<ApprovalDocType, StagePolicy[]>

export const DEFAULT_POLICIES: PolicySet = {
  QUOTE: [{ stage: "ESTIMATOR", role: "ESTIMATOR", approverEmail: null }, { stage: "MANAGER", role: "MANAGER", approverEmail: null }],
  CLAIM: [{ stage: "MANAGER", role: "MANAGER", approverEmail: null }],
  VARIATION: [{ stage: "MANAGER", role: "MANAGER", approverEmail: null }],
};

/** The same shape rules the database enforces (approval_policy_save), for an early readable error. */
export function validatePolicy(docType: ApprovalDocType, stages: readonly StagePolicy[]): string[] {
  const errors: string[] = [];
  const names = stages.map((s) => s.stage).join(",");
  if (docType === "QUOTE" && names !== "ESTIMATOR,MANAGER") errors.push("A quotation always needs an estimator stage followed by a manager stage.");
  if (docType !== "QUOTE" && names !== "MANAGER") errors.push(`A ${docType.toLowerCase()} has a single manager stage.`);
  for (const s of stages) {
    if (!isFunctionalRole(s.role)) errors.push(`Unknown role "${String(s.role)}".`);
    if (s.approverEmail !== null && !/^[^@\s]+@[^@\s]+$/.test(s.approverEmail)) errors.push(`"${s.approverEmail}" is not a valid approver email.`);
  }
  return errors;
}

export const stageOf = (policies: PolicySet, docType: ApprovalDocType, stage: ApprovalStage): StagePolicy =>
  policies[docType].find((s) => s.stage === stage) ?? DEFAULT_POLICIES[docType].find((s) => s.stage === stage) ?? { stage, role: "MANAGER", approverEmail: null };

/**
 * The roles a person effectively holds.
 *  - With explicit assignments: exactly those (an organisation administrator additionally holds ADMINISTRATOR, which never approves by itself).
 *  - With none and strict roles ON: nothing (an administrator keeps ADMINISTRATOR so they can assign roles).
 *  - With none and strict roles OFF (the default): the Phase H tier behaviour - member = rep + estimator; owner/admin = rep + estimator + manager + administrator.
 */
export function effectiveRoles(assigned: ReadonlySet<FunctionalRole> | readonly FunctionalRole[], adminTier: boolean, strict: boolean): ReadonlySet<FunctionalRole> {
  const set = new Set<FunctionalRole>(assigned);
  if (set.size > 0) { if (adminTier) set.add("ADMINISTRATOR"); return set; }
  if (strict) return new Set<FunctionalRole>(adminTier ? ["ADMINISTRATOR"] : []);
  return new Set<FunctionalRole>(adminTier ? ["REP", "ESTIMATOR", "MANAGER", "ADMINISTRATOR"] : ["REP", "ESTIMATOR"]);
}

/** The quotation workflow's three-role vocabulary, from functional roles. */
export function toQuoteRoles(roles: ReadonlySet<FunctionalRole>): ReadonlySet<QuoteRole> {
  const out = new Set<QuoteRole>();
  if (roles.has("REP")) out.add("rep");
  if (roles.has("ESTIMATOR")) out.add("estimator");
  if (roles.has("MANAGER")) out.add("manager");
  return out;
}

/** May this person administer roles, templates and policies? An organisation owner/admin, or an explicit Administrator. */
export const canAdminister = (roles: ReadonlySet<FunctionalRole>, adminTier: boolean): boolean => adminTier || roles.has("ADMINISTRATOR");
