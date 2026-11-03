// WHY nothing can be claimed yet (UX-006 PR f). Pure, display-only: derived from stage data the workspace already holds; it never changes claimability.
export type ClaimableStage = { approvedBps: number; claimableCents: number; remainingCents: number };
export type NothingClaimableReason = { text: string; tab?: "stages" };

export function nothingClaimableReasons(i: { stages: readonly ClaimableStage[]; scheduleBalanced: boolean; uncertainClaimBlocking: boolean; isAdmin: boolean }): NothingClaimableReason[] | null {
  if (i.stages.some((s) => s.claimableCents > 0)) return null; // something is claimable: no hint needed
  const out: NothingClaimableReason[] = [];
  if (!i.scheduleBalanced) out.push({ text: "The stage values do not reconcile to the contract value, so claiming is blocked. Check the stage values.", tab: "stages" });
  if (i.uncertainClaimBlocking) out.push({ text: "A claim has an uncertain Cin7 outcome and is blocking billing of its stages. Reconcile it in the claims list above." });
  if (i.stages.length === 0) { out.push({ text: "This project has no billing stages yet." }); return out; }
  const unapproved = i.stages.filter((s) => s.approvedBps === 0 && s.remainingCents > 0).length;
  const spent = i.stages.filter((s) => s.approvedBps > 0 && s.remainingCents > 0).length;
  if (unapproved > 0) out.push({ text: i.isAdmin ? `${unapproved === i.stages.length ? "No stage has" : `${unapproved} of ${i.stages.length} stages have no`} approved commercial progress. Use Approve commercial progress on the Stages tab.` : `${unapproved === i.stages.length ? "No stage has" : `${unapproved} of ${i.stages.length} stages have no`} approved commercial progress. An owner or admin must approve it on the Stages tab.`, tab: "stages" });
  if (spent > 0) out.push({ text: `${spent === 1 ? "One stage has" : `${spent} stages have`} approved progress that is already billed or committed. ${i.isAdmin ? "Approve a higher commercial percentage" : "An owner or admin must approve a higher commercial percentage"} to claim more.`, tab: "stages" });
  if (unapproved === 0 && spent === 0) out.push({ text: "Every stage is already fully billed or committed." });
  return out;
}
