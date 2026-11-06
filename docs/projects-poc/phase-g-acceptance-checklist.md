# Phase G - end-to-end acceptance checklist (NewQuip)

Run once, on ONE Preview of `feature/newquip-completion`, after the owner has (a) approved and applied migrations 0107, 0108, 0109 (each after its own GO sentence,
see `hosted-migration-010{7,8,9}-plan.md`) and (b) opened ONE Cin7 write window for that Preview branch only (never Production; flag removed and verified absent afterwards).
Use the existing NewQuip test data and genuine Cin7 SKUs. Do not touch SO-00023 or INV-00021/27/28/29 or unrelated projects.

| # | Step | Expected | Evidence to record |
|---|---|---|---|
| 0 | Preconditions: ledger shows 0107-0109; baseline digests (plans) unchanged for existing data; Production flag absent | pass | ledger rows, digests |
| 1 | Template -> Solution Builder -> quote (Load Demo Defaults) | R10,000,000 ex VAT, READY | quote ref |
| 2 | Approve with 3 unresolved mappings (M75, PP penning, FORTIS) | approval is NOT blocked; items shown UNMAPPED | screenshot |
| 3 | Create project, **choose** a schedule | default 40/55/5 = R4m / R5.5m / R500k; six-stage and custom selectable; total must be exactly 100% | stages |
| 4 | Resolve the three mappings (multi-SKU, running-metre conversion, BOM component as reference only); save one as a reusable mapping; apply it on a second project | Sale lines exact; BOM never a Sale line; v1 then v2 history kept | resolutions, mapping versions |
| 5 | Create the Cin7 Advanced Sale (R0 physical lines, charges, R15% VAT) | read-back RECONCILED; totals = plan | SO number |
| 6 | Deposit invoice (no product lines) | ex VAT = deposit; VAT and total exact | INV, amounts |
| 7 | Plan 2 deliveries; allocate SKUs; mark one LOADING | allocations audited; capped by ordered qty | audit rows |
| 8 | Delivery claim for delivery 1 **before** it ships | allocated products proposed at R0; shipped irrelevant; post | INV, lines |
| 9 | Ship in Cin7 (Toolbox does not ship) ; re-open Products & Fulfilment | shipped/stock from Cin7; no duplicate invoicing; outstanding units correct | read-back |
| 10 | Variation: search Cin7 catalogue, add product (or service-only), price, approve, start billing, create ITS OWN Sale, claim and post - all from the original project's Variations tab | separate SO + INV; scope independent | SO/INV |
| 11 | Consolidated report | contract + variations = revised; original vs variation invoices separate; total invoiced; remaining contract value distinct from claimable now; physical by scope; no double counting | numbers |
| 12 | Costing | invoice-line cost, recognised COGS and incurred shown separately; zero recognised COGS is an exception not a margin; non-stock costs recorded (labour/transport/subcontractor); by SKU/section/stage/supplier; budget variance; expected final margin | report |
| 13 | Customer invoice | printed NewQuip Progress Invoice shows only commercial lines; totals equal Cin7 and `reconcileCustomerInvoice` | PDF |
| 14 | Permissions | other organisation refused on every NewQuip-only action; members cannot approve/post/see cost | test org |
| 15 | Close the window | flag removed; deployment redeployed; absence verified in project env and deployment | vercel env ls |

Stop (do not retry) on any failed or uncertain Cin7 write; reconcile first. Report once at the end.
