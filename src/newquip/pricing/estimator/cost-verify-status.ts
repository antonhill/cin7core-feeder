import type { PricingWorkspaceView } from "./workspace-view";

// THE COST & VERIFY STATUS OF A PHASE 2 QUOTATION, as data. Pure: derived only from the workspace view-model (which the page builds from the saved pricing and the loaded evaluation) and a few
// facts the page already holds. It changes no price, no gate and no stored value; it only says, in plain language, what is outstanding and what the next action is. It carries no cost or
// rate VALUE (SKU codes, currencies, counts and roles only).

export interface Phase2CostStatus {
  /** Supplier costs this quotation relies on, and how many are independently verified. */
  required: number; verified: number;
  /** SKUs with no supplier cost entered (not priced). */
  missingCost: string[];
  /** SKUs whose cost is entered but not (or no longer) independently verified. */
  needsVerification: string[];
  /** Every other plain-language item still open (an unpriceable SKU, a rate, pricing evidence). */
  other: string[];
  /** Every outstanding item, phrased from the Phase 2 state. */
  outstanding: string[];
  /** Supplier pricing is complete: nothing is outstanding and the pricing could be final. */
  complete: boolean;
}

const stripWaiver = (s: string) => s.replace(/\s*This cannot be waived by the incomplete-costing exception\.?/, "").trim();
const list = (xs: string[], max = 4) => (xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const roleText = (roles: readonly string[]) => (roles.length === 0 ? "an authorised reviewer" : `a ${roles.map((r) => r.charAt(0).toUpperCase() + r.slice(1)).join(" or ")}`);

/** What is outstanding on a Phase 2 quotation. `reviewerRoles` (from the rule version) names who may verify; used only for wording. */
export function phase2CostStatus(view: PricingWorkspaceView | null | undefined, reviewerRoles: readonly string[] = ["manager"]): Phase2CostStatus | null {
  if (!view || !view.enabled) return null;
  const used = view.rows.filter((r) => r.usedBy.length > 0);
  const missingCost = used.filter((r) => r.status === "no_input" && r.priceBasis !== "manual_price" || r.costState === "missing").map((r) => r.sku);
  const needsVerification = used.filter((r) => r.costState !== "verified" && r.costState !== "missing").map((r) => r.sku);
  const outstanding: string[] = [];
  const other: string[] = [];
  const miss = [...new Set(missingCost)];
  // A product automatic pricing tried and could not price is a PRICING EXCEPTION with a stored reason, not a cost nobody has looked at.
  const flagged = miss.filter((s) => !!used.find((r) => r.sku === s)?.autoFlag);
  const plain = miss.filter((s) => !flagged.includes(s));
  if (plain.length > 0) outstanding.push(`${plural(plain.length, "supplier cost", "supplier costs")} to enter (${list(plain)})`);
  if (flagged.length > 0) outstanding.push(`${plural(flagged.length, "pricing exception", "pricing exceptions")} with no automatic price (${list(flagged)}); each shows its reason`);
  const unver = [...new Set(needsVerification)];
  if (unver.length > 0) {
    const changed = used.filter((r) => r.costState === "review_outdated").map((r) => r.sku);
    outstanding.push(`${plural(unver.length, "supplier cost needs", "supplier costs need")} independent verification by ${roleText(reviewerRoles)} (${list(unver)})${changed.length > 0 ? `; ${list(changed)} changed since it was verified` : ""}`);
  }
  for (const r of used) if (r.status === "not_priced") other.push(`${r.sku} cannot be priced yet (${r.issues[0] ?? "check the rate and cost"})`);
  for (const c of view.currencies) {
    const rt = view.rates.find((x) => x.currency === c.currency);
    if (c.forwardCover && c.forwardCover.state !== "attested") other.push(`${c.currency} forward-cover rate: ${c.forwardCover.stateText}`);
    if (rt?.forwardExpired) other.push(`the ${c.currency} forward-cover rate has expired`);
    if (rt?.spotExpired) other.push(`the ${c.currency} spot rate is out of date: record a current rate`);
    if (!c.spot && !c.forwardCover) other.push(`no ${c.currency} exchange rate recorded`);
  }
  for (const m of view.manualEvidence) if (m.state !== "recorded") other.push(`${m.label}: ${m.state === "outdated" ? "pricing evidence no longer matches the price" : "pricing evidence not recorded"}`);
  outstanding.push(...other);
  // Anything the finality check names that the items above did not (so a new gate is never hidden): used only when nothing else explains it.
  if (outstanding.length === 0 && !view.finality.final) outstanding.push(...view.finality.reasons.map(stripWaiver));
  if (outstanding.length === 0 && !view.totals.priceComplete) outstanding.push("some lines are not priced yet");
  return { required: view.costs.required, verified: view.costs.verified, missingCost: miss, needsVerification: unver, other, outstanding: [...new Set(outstanding)], complete: outstanding.length === 0 };
}

/** The reason text for an INCOMPLETE costing of a Phase 2 quotation, phrased from the Phase 2 state (replaces the legacy "no supplier cost selected" wording). */
export function phase2CostingReason(s: Phase2CostStatus, serverReason?: string | null): string {
  if (s.outstanding.length > 0) return `Supplier pricing is not complete: ${s.outstanding.slice(0, 3).join("; ")}${s.outstanding.length > 3 ? `; and ${s.outstanding.length - 3} more` : ""}`;
  // Phase 2 itself is complete but the server still lists something (a SKU outside what Phase 2 covers): keep the server's own words.
  return serverReason ?? "a supplier cost is still unresolved";
}

/** The one-line note for the Costs step when Phase 2 supplier pricing is on and complete. */
export function phase2CostNote(s: Phase2CostStatus): string {
  return s.complete ? `Supplier costs verified (${s.verified} of ${s.required}); check them in the supplier pricing workspace` : `${s.outstanding.length} supplier-pricing item${s.outstanding.length === 1 ? "" : "s"} outstanding`;
}

// ── THE EFFECTIVE APPROVAL REQUIREMENTS ─────────────────────────────────────────────────────────
// ONE pure source for "what blocks the Manager's plain Approve right now". The page's Approve button is disabled from this list and the Next-action banner reads the SAME list, so the banner can never
// say "Ready for approval" while the button is blocked, and it always names what is outstanding. It adds and removes NO gate: it is exactly the set the button already enforced (a current Estimator
// sign-off, no unsaved edits, the quotation READY with costing complete, no outstanding baseline exception and no unmapped product only a library mapping can resolve). The Manager role and a
// transient "another action is running" are not quotation requirements and stay with the button itself.
export type ApprovalBlockerId = "signoff-missing" | "signoff-stale" | "unsaved" | "not-ready" | "costing-open" | "baseline-exception" | "mapping-blocking";
export interface ApprovalBlocker { id: ApprovalBlockerId; text: string }
export interface ApprovalBlockerInput {
  signoff: "none" | "current" | "stale";
  dirty: boolean;
  /** The quotation is not READY: its reasons (empty list: not ready, no reason given). Null when READY. */
  notReadyReasons: readonly string[] | null;
  /** The server's costing verdict is incomplete. */
  costingOpen: boolean;
  costingReason?: string | null;
  /** An approval exception is required (and sufficient): plain approval is unavailable. */
  baselineExceptionRequired: boolean;
  baselineExceptionItems?: readonly string[];
  /** Unmapped products no exception can cover (labels): they need an active library mapping. */
  blockingLabels?: readonly string[];
}
export function approvalBlockers(i: ApprovalBlockerInput): ApprovalBlocker[] {
  const out: ApprovalBlocker[] = [];
  if (i.signoff === "none") out.push({ id: "signoff-missing", text: "The Estimator sign-off is missing" });
  if (i.signoff === "stale") out.push({ id: "signoff-stale", text: "The Estimator sign-off no longer matches the current quotation" });
  if (i.dirty) out.push({ id: "unsaved", text: "There are unsaved edits: approval applies to the saved quotation" });
  if (i.notReadyReasons) out.push({ id: "not-ready", text: `The quotation is not ready${i.notReadyReasons[0] ? `: ${i.notReadyReasons[0]}` : ""}${i.notReadyReasons.length > 1 ? ` (+${i.notReadyReasons.length - 1} more)` : ""}` });
  if (i.costingOpen) out.push({ id: "costing-open", text: `Costing is incomplete${i.costingReason ? `: ${i.costingReason.replace(/\.$/, "")}` : ""}` });
  if (i.baselineExceptionRequired) out.push({ id: "baseline-exception", text: `A baseline exception is required before approval${i.baselineExceptionItems && i.baselineExceptionItems.length > 0 ? ` (${list([...i.baselineExceptionItems])})` : ""}` });
  const blocking = i.blockingLabels ?? [];
  if (blocking.length > 0) out.push({ id: "mapping-blocking", text: `${list([...blocking])} ${blocking.length === 1 ? "needs" : "need"} an active library mapping before approval` });
  return out;
}

export type NextActionTone = "success" | "warning" | "info" | "danger";
export interface NextAction { id: string; tone: NextActionTone; headline: string; detail: string | null; /** Everything still outstanding (Phase 2 items first). */ outstanding: string[] }
export interface NextActionInput {
  status: Phase2CostStatus;
  state: "REP_DRAFT" | "ESTIMATOR_REVIEW" | "MANAGER_APPROVED_FINAL";
  roles: { rep: boolean; estimator: boolean; manager: boolean };
  reviewerRoles?: readonly string[];
  dirty: boolean;
  signoff: "none" | "current" | "stale";
  /** The Estimator has marked the costing reviewed in this session. */
  costAcknowledged: boolean;
  /** The Estimator still has to mark the costing reviewed before signing off. */
  costNeedsMark: boolean;
  /** The page's own readiness blockers (quotation not READY, open mappings / manual prices), already phrased. Sign-off is refused while any exist, so no sign-off style action may be named. */
  readinessBlocked?: readonly string[];
  /** The Rep-confirmed amount no longer equals the quote total. */
  amountChanged: boolean;
  /** `approvalBlockers(...)` from the page: the SAME list that disables the Approve button. While any exists the banner never says the quotation is ready for approval. */
  approvalBlockers?: readonly ApprovalBlocker[];
  /** The SERVER's costing verdict still lists something Phase 2 does not explain. */
  serverIncomplete: boolean;
  serverReason?: string | null;
}

/** ONE prominent next action for the Cost & Verify step, from existing state only. First match wins. */
export function nextCostVerifyAction(i: NextActionInput): NextAction {
  const s = i.status;
  const roles = i.reviewerRoles ?? ["manager"];
  const out = s.outstanding;
  const A = (id: string, tone: NextActionTone, headline: string, detail: string | null = null): NextAction => ({ id, tone, headline, detail, outstanding: out });
  if (i.state === "MANAGER_APPROVED_FINAL") return A("approved", "success", "Approved: pricing is frozen", "The supplier pricing is part of the approved baseline and cannot be changed.");
  if (i.state === "REP_DRAFT") return A("rep", "info", "Waiting for Rep reconfirmation", "The quotation is with the Rep. The Rep must reconfirm the amount with the customer and resubmit it before the Estimator can continue.");
  if (i.dirty) return A("unsaved", "warning", "Save or discard your unsaved edits", "The supplier pricing workspace and the sign-off apply to the saved quotation.");
  if (s.missingCost.length > 0) return A("enter", "warning", "Enter supplier costs", `${plural(s.missingCost.length, "SKU has", "SKUs have")} no supplier cost, so ${s.missingCost.length === 1 ? "it is" : "they are"} not priced: ${list(s.missingCost)}.${i.roles.estimator ? "" : " The Estimator enters them."}`);
  if (s.needsVerification.length > 0) return A("verify", "warning", `${plural(s.needsVerification.length, "cost needs", "costs need")} independent verification by ${roleText(roles)}`, `${list(s.needsVerification)}: a cost cannot be verified by the person who entered it. Unverified costs support an indicative price only; they block sign-off and approval.`);
  if (s.other.length > 0) return A("resolve", "warning", `Resolve ${plural(s.other.length, "supplier-pricing item", "supplier-pricing items")}`, `${s.other[0]}${s.other.length > 1 ? ` (and ${s.other.length - 1} more)` : ""}.`);
  if (s.outstanding.length > 0) return A("resolve", "warning", "Resolve the outstanding supplier-pricing items", s.outstanding[0]);
  if (i.readinessBlocked && i.readinessBlocked.length > 0) { const r = i.readinessBlocked; return A("readiness", "warning", "Resolve readiness items", `${r[0]}${r.length > 1 ? ` (and ${r.length - 1} more)` : ""}. The quotation cannot be signed off or approved until it is READY.`); }
  if (i.amountChanged) return A("reconfirm", "info", "Waiting for Rep reconfirmation", "The total changed after the customer confirmed it. Return the quotation to the Rep to reconfirm the amount.");
  if (i.serverIncomplete) return A("costing", "warning", "Costing is not complete", i.serverReason ?? "A supplier cost the quotation needs is unresolved.");
  if (i.signoff === "current" && i.approvalBlockers && i.approvalBlockers.length > 0) {
    const bl = i.approvalBlockers, texts = bl.map((b) => b.text);
    const bx = bl.find((b) => b.id === "baseline-exception"), mp = bl.find((b) => b.id === "mapping-blocking");
    const who = i.roles.manager ? "approval" : "Manager approval";
    const headline = bx ? `Baseline exception required before ${who}` : mp ? `Library mapping required before ${who}` : `Not ready for ${who}`;
    return { id: "approval-blocked", tone: "warning", headline, detail: `${texts[0]}${texts.length > 1 ? ` (and ${texts.length - 1} more)` : ""}.${bx ? (i.roles.manager ? " Approve with the recorded exception in Manager approval." : " The Manager approves it with a recorded exception.") : ""}`, outstanding: [...texts, ...out] };
  }
  if (i.signoff === "current") return A("approve", "success", i.roles.manager ? "Ready for your approval" : "Ready for Manager approval", "Supplier costs are verified and the Estimator sign-off is current.");
  if (i.roles.estimator && i.costNeedsMark) return A("mark", "info", "Mark reviewed, then sign off", "Supplier costs are verified. Mark the costing reviewed in Final review, then sign off for Manager approval.");
  if (i.roles.estimator) return A("signoff", "info", "Sign off for Manager approval", i.costAcknowledged ? "The costing is marked reviewed for this session." : null);
  return A("signoff-wait", "info", "Waiting for Estimator sign-off", "Supplier costs are verified. The Estimator reviews and signs off next.");
}

// ── FX rate timestamps ──────────────────────────────────────────────────────────────────────────

/** The provider's own timestamp, when the stored rate source text carries one ("provider timestamp 2026-11-14T19:00:06Z; retrieved ..."). Defensive: null for anything it cannot read. */
export function providerTimestampOf(source: string | null | undefined): string | null {
  if (typeof source !== "string" || source.length === 0) return null;
  const m = /provider\s+(?:time\s*stamp|timestamp|time)\s*[:=]?\s*(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?)/i.exec(source);
  if (!m) return null;
  const raw = m[1].replace(" ", "T");
  return Number.isFinite(Date.parse(raw)) ? raw : null;
}
