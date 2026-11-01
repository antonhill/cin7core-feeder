# NewQuip owner UAT tracking (1 November 2026)

Single tracking document for UAT-001 to UAT-024. Statuses: FIXED AND VERIFIED, IMPLEMENTED AWAITING LIVE UAT, INVESTIGATION COMPLETE DECISION NEEDED,
BLOCKED BY EXTERNAL INTEGRATION, DEFERRED WITH REASON, plus NOT STARTED (work not yet begun; not a completion claim).

"FIXED AND VERIFIED" is reserved for findings the owner has confirmed live. Code plus tests is at most IMPLEMENTED, AWAITING LIVE UAT.

| ID | Finding | Status | Where | Evidence |
|---|---|---|---|---|
| UAT-001 | Additional element product mapping control | NOT STARTED | - | - |
| UAT-002 | POC selling-price overrides / pricing source | NOT STARTED | - | - |
| UAT-003 | Exclusion recalculation feedback | NOT STARTED | - | - |
| UAT-004 | Cost override vs Procurement workflow | NOT STARTED | - | - |
| UAT-005 | Cost override inputs disappear | IMPLEMENTED, AWAITING LIVE UAT | PR-A | `previewCostOverrides`; reason-without-amount no longer becomes a R0 override (found by independent review); 5 tests; mutations killed |
| UAT-006 | Estimator sign-off button persists | IMPLEMENTED, AWAITING LIVE UAT | PR-A | completed state in UI; server refuses a second sign-off, atomic `is null` guard; test + mutation |
| UAT-007 | Customer emails missing from Outlook | INVESTIGATION COMPLETE, DECISION NEEDED | - | Both sends recorded ACCEPTED with Resend IDs (07:04:08Z first send, 07:07:04Z deliberate re-send, rep@ as sender, [PREVIEW] subject). Application side is consistent; not a sending-code defect on this evidence. Toolbox notifications from the same sender domain DID reach the mailbox (07:00, 07:16Z), and the Junk folder holds neither quote email, so the loss is specific to the customer-quote message (likely tenant quarantine / anti-spoof or attachment policy). Owner check: Microsoft 365 Message trace + Quarantine for 07:04-07:08Z. No emails sent. |
| UAT-008 | Create Project visible to Reps | IMPLEMENTED, AWAITING LIVE UAT | PR-A | server requires Manager (`PROJECT_CREATE_ROLES`); UI hides control; mutation killed |
| UAT-009 | Opening Commitments collapsed by default | NOT STARTED | - | - |
| UAT-010 | Cin7 location / account dropdowns | NOT STARTED | - | needs Cin7 account-type acceptance evidence |
| UAT-011 | Cin7 Sale confirmation checkbox | NOT STARTED | - | - |
| UAT-012 | Cin7 Sale wording / recovery section | NOT STARTED | - | - |
| UAT-013 | Selective progress claims | NOT STARTED | - | - |
| UAT-014 | Preview Claim / Refresh Preview | NOT STARTED | - | - |
| UAT-015 | Claim History redesign | NOT STARTED | - | status/next-action clarity partly addressed by UAT-016/017/022 |
| UAT-016 | Claim actions after submission | IMPLEMENTED, AWAITING LIVE UAT | PR-A | no Recalculate/Submit when submitted (UI + server); Cancel relabelled "Withdraw claim"; 2 existing tests moved to the controlled return-to-draft path |
| UAT-017 | Manager approval navigation | IMPLEMENTED, AWAITING LIVE UAT | PR-A | "Open in Approvals" link; waiting text names the real stage role |
| UAT-018 | Approval filter visibility | NOT STARTED | - | - |
| UAT-019/020 | Cin7 billing vs fulfilment | NOT STARTED | - | needs Cin7 API semantics investigation; no live write without owner approval |
| UAT-021 | Project operations layout | NOT STARTED | - | - |
| UAT-022 | Incorrect Cin7 claim status | IMPLEMENTED, AWAITING LIVE UAT | PR-A | root cause: history read legacy `project_cin7_links` (0 rows); now reads `project_claim_cin7_postings` (C01 = RECONCILED, INV-00032, DRAFT); 4 tests; mutation killed |
| UAT-023 | Administrator override approval UI | IMPLEMENTED, AWAITING LIVE UAT | PR-A | root cause by code reading (database closes the request atomically; page relied on a reload); decided state applied immediately; decision panel with approver, time, override reason; not reproduced live |
| UAT-024 | Bulk product selection | NOT STARTED | - | - |

## PR-A: Priority 1 defects and permissions (this branch)

Branch `fix/newquip-uat-p1-defects`, based on `feature/newquip-completion` (#126 head `30e9ea6`).
No migrations. No Cin7 or Xero writes. No emails.
