# NewQuip POC — Final Sean Feedback Implementation Matrix

Source: `Copy of NewQuip_Pre_POC_Questions v4 3 Sean.xlsx`, received 2026-10-27.

This is the authoritative POC implementation contract. Where Sean confirmed a rule, implement it. Where Sean explicitly said the rep/estimator chooses, keep it manual by design. Do not infer missing engineering rules.

| Area | Sean final answer | Final POC treatment | Blocking? |
|---|---|---|---|
| Rooms | ±600 pigs is **per room** | `pigsPerRoom`; all per-room quantities multiply by room count | No |
| Lighting | `ceil(area / 25)` confirmed | DEFAULT / SUGGESTED minimum, upward override allowed with reason | No |
| CCM feeder | 45 pigs per feeder. Base product PNQ082; PNQ082-WINDOW when customer wants a window | Show 45-pig capacity; estimator confirms quantity until rounding/split-pen logic is explicitly defined. Window is a selectable product variant, not a replacement identity. | No |
| Drinkers | 15 pigs per drinker | Show calculated suggestion; estimator confirms final quantity because rounding/minimum/pen handling was not supplied | No |
| Slats | Rep manually enters requirement | ESTIMATOR INPUT by design; do not derive units from area | No |
| Penning | Small R1,300/rm; Medium R1,500/rm; Large R2,200/rm | Running metres × confirmed rate by pig size. SKU may remain unresolved for POC. | No |
| M75 | Feeding-system size is client preference; reps know what to do | ESTIMATOR INPUT / manual system selection and pricing. Do not port W/W1 formulas for POC. | No |
| Ventilation | AS.03 reference contains fans | Optional inside Grower. Keep engineering-review/manual until AS.03 is ingested. | No |
| Template name | Grower House Template v1 | Use this exact POC name | No |
| Template sections | Everything in reference quote mandatory, modifiable for customer request | Required by default; allow customer-driven exclusions/optional ventilation with visible reason | No |
| Template metadata | Read-only detail recommended | Show version, status, sections, rule refs, mapping refs, override policy | No |
| POC price source | Cin7 is demo data; use workbook | NewQuip Master workbook snapshot is POC price authority | No |
| Project pricing | **Landed cost + 20% markup** | Project sell = landed cost × 1.20. Landed cost follows workbook commercial basis before MU. | No |
| Zero price / NQ3132 | Flag **N/A**, supplier quote required | Never quote zero. Show supplier-quote-required / N/A; estimator must resolve if the line is commercially required | No |
| Cost visibility | Estimator Rene; FM Sean | Cost/margin visible only to permitted estimator/FM/admin roles | No |
| Quote workflow | Rep drafts with client → estimator double-check → manager final approval/send → Cin7 later | POC states: REP DRAFT → ESTIMATOR REVIEW → MANAGER APPROVED / FINAL. No Cin7 write. | No |
| Customer confirmation boundary | Client amount is confirmed when rep sends to estimator | Rep → Estimator handoff records customer confirmation; manager approval creates final accepted baseline | No |
| Customer quote detail | Summary view; customer does not need each stock line | Customer output is grouped summary, not raw BOM | No |
| Project stages | Existing stage template confirmed | Deposit / Manufacturing / Equipment Ready / Delivery / Installation / Commissioning | No |
| Physical progress | Reps + estimator may update | Permit operational progress updates for those roles | No |
| Commercial progress | Manager approves | Manager-only commercial approval | No |
| Variations | Estimator + Manager | Estimator raises/prices; manager approves/rejects | No |
| Post-acceptance changes | Must be Variations | Never edit the accepted baseline | No |
| Variation → Cin7 | No live writing | Show separate POC commitment/Sale representation only | No |
| Claim across original + variation | Yes | One Project claim may allocate across multiple commercial commitments | No |
| Cin7 environment | Read-only | No write actions from POC | No |
| Cin7 POC writes | **No writes** | Hard fail closed | No |
| Xero | Unnecessary for POC | Exclude except conceptual handoff | No |
| Real data | Real data allowed/preferred for POC | Use real NewQuip data where access permits | No |
| Engineering authority | Shirnel | Record as governance owner | No |
| Product mapping authority | Shirnel | Record as governance owner | No |
| Commercial pricing authority | Shirnel | Record as governance owner | No |
| Mobile | Desktop sufficient | Responsive desktop only for POC | No |
| Photos | Future roadmap | Exclude from POC | No |
| Branding | Newquip Agri Supplies | Use client-facing branding/label where appropriate | No |
| POC success | Must work and remain within commercial range | Technical acceptance below is Spark's explicit definition of “works” | No |
| Quote → Project / Variation depth | Follow Spark recommendation | Working internal interactions; Cin7/Xero simulated/read-only | No |
| Demo data | App will be used daily; demo data for testing | Use repeatable fixture for tests, but preserve real-data operation | No |

## Spark clarification for POC-02

The following are **manual by design / POC-safe** and are not blockers:
- M75 system size/configuration
- slat final quantity
- PVC door selection
- delivery
- installation
- tank sizing unless separately confirmed
- ventilation engineering scope until AS.03 is ingested
- feeder final quantity until rounding/split-pen logic is supplied
- drinker final quantity until rounding/minimum logic is supplied

A manual item is not a defect if the UI labels it clearly and captures the estimator's decision.

## POC acceptance gates

### Gate 1
`Grower House Template v1 → configuration → estimator review → final quote → accepted baseline → Project` works without database intervention.

### Gate 2
The created Project can demonstrate:
- physical progress
- manager-approved commercial progress
- R950,000 ex VAT golden claim
- approved Variation V001
- original baseline unchanged
- revised contract = original + approved variations
- read-only/simulated Cin7 commitment representation

## Safety
- No live Cin7 writes.
- No Xero writes.
- No production Supabase migration push.
- Never silently price a required item at zero.
- Never replace an unresolved product identity with a historic surrogate.
