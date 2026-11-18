// THE ACTIVE BUDGET BASIS REGISTER. It ships EMPTY on purpose: no product mapping and no rate is activated until an authorised NewQuip Manager / designated commercial approver has approved it AND that approval is
// recorded outside the code (budgetBasisProblems() requires the approval reference, the approver, their role, the time, who entered the record, and the evidence with its own date and stated uncertainty).
// A developer editing this file is NOT an approval: the procedure in docs/newquip-budget-pricing-coverage.md requires the named approver's own review of the pull request. A database-backed approval screen
// is a later step (it needs a migration and an explicit owner decision). Until an entry exists the item is reported by the coverage view with its exact blocker.
import type { BudgetBasisEntry } from "./budget-basis";

export const ACTIVE_BUDGET_BASIS: readonly BudgetBasisEntry[] = [];
