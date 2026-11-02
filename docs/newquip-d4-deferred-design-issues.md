# NewQuip D4: deferred design issues (recorded, not scheduled)

Owner decision (D4 merge-blocking corrections): record these, do NOT start another wholesale redesign. Assess them during the final owner browser UAT and prioritise before the customer demo where necessary.

| # | Issue | Where | Evidence / note | Demo-blocking? (to decide in UAT) |
|---|---|---|---|---|
| 1 | Solution Builder stage 2 is very long | `src/app/newquip-grower/[id]/page.tsx` | about 9,700px tall at 1440 and 18,400px at 390 (fixture); dense but complete | owner to judge |
| 2 | Products & Stock layout | `src/app/projects/[id]` physical/delivery panels | scored 3.7 of 5 in the D4 re-audit, lowest screen | owner to judge |
| 3 | Approvals first row is below the fold on a phone | `src/app/approvals/page.tsx` | table header 745px (fixture) and the independent audit measured the first row at 908px, against an 844px viewport; filters now collapse to Show + Status + "More filters" + Clear filters | owner to judge on a real phone |
| 4 | Minor remaining disabled-control explanations | mapping panel ("Exclude from the Sale", "Look for a saved mapping" reason fields), stage progress buttons | these controls disable without a visible reason | no, low |
| 5 | Customer portal and PDF currency format | `portal/`, `src/lib/newquip-quotes` PDF | portal uses ICU formatting; PDF prints the same visible digits but not through `format-money.ts`; aligning the portal needs an edit to its pinned import list | owner to decide |
| 6 | Computed (not stored) discrepancy messages use the shared SA money format | `customer-invoice.ts`, `profitability.ts`, `consolidated-report.ts` | on-screen only. The Cin7 posting and Sale-creation mismatch messages are STORED (`last_error_message`), so `cin7-posting.ts` and `cin7-sale-creation.ts` were reverted to their original plain text (`R142500.00`), as was the approval email body | confirm in UAT that the on-screen messages read acceptably |
| 7 | Browser-level unsaved-work evidence | see `newquip-unsaved-work-protection.md` | no navigation method exercised in the real signed-in app; Back/Forward protection is Chromium-only | UAT checklist |

Other open P3s from the D4 audit (3-row header at 390px, clipped tab strip at 1280px, 13px checkboxes, "Content seal" digests, a hung reload request keeping a variation Save disabled) are unchanged.
