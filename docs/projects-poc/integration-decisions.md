# NewQuip POC integration: settled decisions (owner brief, 2026-10-28)

Status: **authoritative for the integration branch `feature/newquip-poc-integration`.** Where this file and `architecture-inventory-billing-costing.md` disagree, this file wins; the review is kept as evidence and for the production accounting gates (S1-S17, §22.8).

## Settled
1. **Cin7 Job Costing is excluded.** Do not propose it.
2. **Model: one Cin7 Advanced Sale per scope.** One Toolbox project has exactly one `BASE` Sale and zero or more `VARIATION` Sales (one per approved variation). This replaces the one-Sale-per-Project assumption of migration 0104 (`unique(project_id)`), changed additively by migration 0105.
3. **Commercial value and physical lines are separate.** The Sale carries the physical SKUs at **R0** and the approved contract value as **Additional Charges**. A zero-priced Cin7 line never overwrites the Toolbox price or margin. This removes the double-revenue risk of the earlier "Alternative 1"; the earlier "two linked Sales" alternative is not used. D1 is therefore settled; T0/T1/T2 become API-contract proofs, not model selection.
4. **Manual assembly.** Cin7 Assembly BOMs, auto-assembly OFF. Toolbox reads status only. No parallel manufacturing system. One consuming transaction per material; no routine stock adjustments.
5. **Invoice patterns:** deposit-only (charges only); progress without products (charges only); progress with physical products (selected SKU lines at R0 plus charges). Invoiced and shipped quantities are tracked independently. Physical completion is never derived from commercial percentages.
6. **Variation billing:** each variation has its own percentage billing schedule (default one 100% stage; or several named stages), validated to total 100%, cents with deterministic rounding, cumulative claims never above the approved variation value, frozen on approval, changed only by an audited amendment. Claims resolve to the variation's own Sale. V001 is not modified automatically.
7. **Margins** (selling, estimated cost, gross profit, gross margin %, markup %) are internal, shown at product, assembly, package and project level, frozen on quote approval, and never shown to customers. Seeded demo costs are acceptable for the POC; provisional vs verified cost is still distinguished.
8. **INV-00021 is immutable historical evidence**, not remediated automatically. `PRJ-NQ-Q-0001-C01` is not posted.
9. **Production Cin7 writes stay OFF**; every Cin7 write needs a durable intent record, safe failure classification and reconciliation.

## Production acceptance gates (not POC blockers)
Sean's decision on zero-priced-line SKU margin distortion; S1-S17 of the review §22.8; trusted costs and reconciled valuation; dependency-audit review (separate stream).

## Superseded
`t0-proof-runbook.md` was written for priced lines (NQ2886, qty 2, R500). The first proof under this model uses R0 lines plus a contract charge; the runbook must be re-specified before any T0 GO. The temporary `/cin7-proof/t0` page is not part of the integration (removed from this lineage).

## Implementation status (integration branch `feature/newquip-poc-integration`)
| Slice | Content | Where |
|---|---|---|
| A | Integration base (corrected #122 lineage + investigation docs + read-only Sale inspector; T0 page excluded), this decision record | merge `b3f91be` |
| E | Invoice writer: R0 physical lines, order-bounded quantities, line-aware reconciliation (VAT-as-amount and NaN fixes already in the base) | `sale-invoice-write.ts`, `cin7-posting*.ts` |
| C | Variation billing projects, percentage schedules (default one 100% stage), audited amendment, per-scope Sale routing; migration 0105 (not applied to hosted) | `variation-*.ts`, `0105_*.sql`, `migration-0105-recovery.md` |
| B | Internal margin sheet (product / assembly / section / project), audited cost overrides, frozen at approval, redacted for non-managers | `src/newquip/quote/margin.ts` |
| D | Advanced Sale creation with durable intent, read-back verification, reconciliation, manual link fallback | `sale-order-write.ts`, `cin7-sale-creation*.ts` |
| F | Read-only physical visibility (ordered / invoiced / shipped / stock / assembly) | `physical-*.ts` |
| G | Consolidated profitability and reconciliation (actual margin only when delivery + billing complete) | `profitability*.ts` |

Not done / gated: hosted migration 0105; every Cin7 contract in `cin7-api-contracts-to-verify.md`; the production accounting gates (Sean S1-S17, trusted costs, dependency audit). No Cin7 write has been made from any of this code.
