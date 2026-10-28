# Finding: SO-00018 is a Simple Sale — the Advanced Sale restriction is correct

Captured 2026-10-27 on the PR #122 Preview with a temporary, manager-only, read-only diagnostic (reused `fetchSaleDetail`; since removed).

| Sale | SaleID | Type | Order.Status | TaxRule |
|---|---|---|---|---|
| SO-00015 | `4fe3d99c-241d-4404-8795-4c448842108b` | **Advanced Sale** | AUTHORISED | Standard Rate Sales |
| SO-00018 | `d99db61e-2af5-497b-81b2-e5610c251056` | **Simple Sale** | AUTHORISED | Standard Rate Sales |

- The adapter is not at fault: right instance ("NewQuip POC", the org's only active instance), right SaleID, Cin7's own `Type` value. `linkCin7Sale` correctly refused. The check is unchanged.
- SO-00018 (created 2026-10-27, reference "NEWQUIP CIN7 CLAIM WRITER TEST") carries one ordinary service product line (ER009, qty 1, R100, 15%) and one DRAFT invoice INV-00020 for that line (from the Toolbox cache; not fulfilled, not paid). That is the shape of a Simple Sale (one order, one invoice, one fulfilment) and not the shape of the Advanced Sale SO-00015 (order line only, invoices added later).
- Cin7 help: sales made in Sales -> Sales are Simple Sales unless Settings -> General settings "Default Load Advanced Sales Order" is on; a Simple Sale can be converted to Advanced, never back. Only an Advanced Sale supports several invoices per sale. The exact creation path of SO-00018 is inferred, not observed.
