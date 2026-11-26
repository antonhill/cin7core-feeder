# NewQuip Grower Budget Pricing: requirements closure matrix (status only)

Date: 2026-11-25. Branch `feature/newquip-grower-pricing-handoff-2026-11-25`.

This register closes requirements NewQuip has ALREADY answered, so previously answered questions are not re-asked. It carries **no supplier costs, no customer prices and no internal test costs**: the evidence (workbooks, Sage inventory master, original customer quotation) and the pre-filled cost-approval sheet are kept outside the repository in `NewQuip-Requirements-Closure-and-Cost-Approval-Workbook.xlsx`.

Evidence reviewed: the 2026-11-25 handoff; the 24 Nov Budget Pricing Completion workbook; the Sage Evolution inventory master (export 2026-09-15); Sean's 17 Nov cost clarification and survey; the door assembly note; the Cin7 cost loading workbook; NewQuip's original Topigs Warden quotation (AS.23.4015.07); the 13/14 Nov mapping and decision packs; live UAT results on NQ-Q-0008, NQ-Q-0009 and NQ-Q-0010.

Status key: ALREADY CONFIRMED, IMPLEMENTED AND VERIFIED, INTERNAL RECONCILIATION REQUIRED, AWAITING COST SHEET RETURN, GENUINELY MISSING COMMERCIAL APPROVAL.

| ID | Topic | Requirement | Status | Owner for what is left |
|---|---|---|---|---|
| Q01 | PVC doors | Both door BOMs complete (NQ3444 2.1x1.2 m = KNQ199 + NQ3845 + NQ3846; NQ3444-B 2.1x1 m = KNQ086 + NQ3845 + NQ3846) | ALREADY CONFIRMED | - |
| Q03 | PVC doors | Door variant chosen by dimensions; descriptions updated; old NQ2112/2113/2114/2161/2281 not to be used | ALREADY CONFIRMED | - |
| Q03b | PVC doors | Door selection mapping; do NQ3444-B, NQ3845, NQ3846 exist in Cin7 | GENUINELY MISSING COMMERCIAL APPROVAL | Teresa / Shirnel |
| Q02 | PVC doors | Approve the door Budget cost basis | GENUINELY MISSING COMMERCIAL APPROVAL | Shirnel / Rene |
| Q02b | PVC doors | Sage latest cost for the KNQ086 door panel looks anomalous (see confidential workbook) | INTERNAL RECONCILIATION REQUIRED | Spark / NewQuip finance |
| Q04 | THOMAS-CL1 | CL1 product mapping | IMPLEMENTED AND VERIFIED | - |
| Q05 | THOMAS-BF | BF HO05084507, one per room | IMPLEMENTED AND VERIFIED | Rene (yes/no) |
| Q06-Q08 | Control panels | Interim Budget price R85,000 (CL1 and BF) / R65,000 (one); no wait for the 60+ configuration BOM catalogue | IMPLEMENTED AND VERIFIED | NewQuip: name the approver (record only) |
| Q09 | Emergency windows | 11-line component BOM beyond ERT003 | GENUINELY MISSING COMMERCIAL APPROVAL | Rene (resend the BOM list) |
| Q10 | Emergency windows | ERT003 one per room with override; shared parts one per two windows | IMPLEMENTED AND VERIFIED | - |
| Q11 | Cooling | 3 m rounding, minimum length | IMPLEMENTED AND VERIFIED | - |
| Q12 | Cooling | Rod formula 4 per gutter kit plus 2 per tank kit | IMPLEMENTED AND VERIFIED | - |
| Q13 | Cooling | KNQCOOL16 total per system | IMPLEMENTED AND VERIFIED | - |
| Q14 | Cooling | Plumbing scales over 20 m; NQ3341 pipe | IMPLEMENTED AND VERIFIED | - |
| Q15 | Cooling | Fractional consumables | IMPLEMENTED AND VERIFIED | - |
| Q16 | Cooling | Component costs | AWAITING COST SHEET RETURN | NewQuip (return cost sheet) |
| Q16b | Cooling | Filter element code N3771 | GENUINELY MISSING COMMERCIAL APPROVAL | Rene (yes/no and cost) |
| Q16c | Cooling | Sikaflex 551 vs 552 | GENUINELY MISSING COMMERCIAL APPROVAL | Rene (yes/no) |
| Q17 | Cone fans | Cost basis and age rule | INTERNAL RECONCILIATION REQUIRED | Shirnel (yes/no) |
| Q17b | Cone fans | MUG4D14A1M10238 (3-blade) | IMPLEMENTED AND VERIFIED | - |
| Q18 | Cone fans | Quantity | ALREADY CONFIRMED | - |
| Q19 | Manure plug | MNQ048 = MNQ039 + MNQ040 + MNQ041; costs usable | IMPLEMENTED AND VERIFIED | - |
| Q20 | Manure plug | Quantity | ALREADY CONFIRMED | - |
| Q21 | Cup drinker | 7-part BOM, not NB3542-03; customer name; costs | IMPLEMENTED AND VERIFIED | - |
| Q22 | LED | FERAX parts and quantities; costs | IMPLEMENTED AND VERIFIED | Owner decision (FERAX) |
| Q23 | General cost policy | Default Cin7 cost source, fallback, age rules | INTERNAL RECONCILIATION REQUIRED | Spark |
| Q23b | Freight | Sage landed ZAR cost versus freight factor | INTERNAL RECONCILIATION REQUIRED | Spark / Manager |
| Q24 | UAT | Standard-plus-additions and additions-only scenarios | IMPLEMENTED AND VERIFIED | - |
| Q25 | UAT | Preview, email, watermark | IMPLEMENTED AND VERIFIED | - |
| M75 | M75 system | Approved price (not the R250,000 UAT test figure) | ALREADY CONFIRMED | - |
| M75b | M75 system | Optional: an approved Budget default per system | GENUINELY MISSING COMMERCIAL APPROVAL | Sean (optional) |
| MAP | Mappings | CL1, BF, ERT003, fan, plug, cooling package | IMPLEMENTED AND VERIFIED | Spark (apply after return, separately authorised) |

## Counts
- ALREADY CONFIRMED: 5
- GENUINELY MISSING COMMERCIAL APPROVAL: 6
- INTERNAL RECONCILIATION REQUIRED: 4
- IMPLEMENTED AND VERIFIED: 16
- AWAITING COST SHEET RETURN: 1

## Rules kept
No cost invented, no Cin7 write, no inventory valuation change and no approval gate bypassed. A live read-only Cin7 check on 2026-11-25 (GET only) found no supplier record for any checked product and several expected product records missing; details are in the confidential workbook.
