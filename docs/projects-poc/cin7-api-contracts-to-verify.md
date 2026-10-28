# Cin7 API contracts that must be PROVEN before real use

Everything below is implemented behind the server-side write flag (`NEWQUIP_CIN7_WRITES_ENABLED`, off by default) and fails closed on read-back. None is proven against Cin7 yet. Each needs a disposable-Sale proof with a separate owner GO; manual UI behaviour (the Looms) is not proof of API behaviour.

| # | Contract | Code | Assumption | How the code guards it | Proof (disposable, owner GO) |
|---|---|---|---|---|---|
| C1 | Create an **Advanced** Sale via `POST /sale` | `src/cin7/sale-order-write.ts` | body field `SaleType: "Advanced"` with `SkipQuote: true` yields `Type = "Advanced Sale"` | read-back requires `Type = Advanced Sale`; otherwise not linked | create once; read `Type`, `Order.Status` |
| C2 | Add the order via `POST /sale/order` | same | accepts `Lines` (R0) + `AdditionalCharges` + `Status: "AUTHORISED"` in one call | read-back requires `Order.Status = AUTHORISED`, lines and charges as planned | same proof |
| C3 | `AdditionalCharges[].Tax` is a monetary VAT amount | `sale-invoice-write.ts`, `sale-order-write.ts` | amount, not a rate (INV-00021: rate 15 became R15 per charge) | VAT sent as `taxAmount`; read-back compares Cin7's VAT in cents | re-prove on the new invoice and Sale |
| C4 | R0 product lines on an order carry no revenue/VAT | `sale-order-write.ts` | `Price: 0` lines are accepted and total 0 | read-back requires `Price = 0` on every physical line | same proof; also check VAT/COGS effect |
| C5 | `ExternalID` on the Sale is stored and echoed by `GET /sale?ID=` | `findSaleByExternalIdForCustomer`, `verifyCreatedSale` | proven for quotes (live 2026-08-26) | verification requires the exact ExternalID | same proof |
| C6 | Invoice with R0 product `Lines` plus `AdditionalCharges` via `POST /sale/invoice` | `sale-invoice-write.ts` | line fields as in the quote writer | quantities validated against order + prior invoices; read-back checks lines are R0 and quantities match | invoice with lines, then with charges only |
| C7 | Over-invoicing: Cin7 rejects invoicing more quantity than ordered, and charges beyond the order's contract charges | `resolvePhysicalLines` (Toolbox prevents quantity) | unknown for charges | Toolbox bounds quantity; contract-charge ceiling is enforced by claims (cumulative <= approved) | attempt over-quantity; attempt charge beyond order (T3) |
| C8 | Invoice lines are returned on `GET /sale` (`Invoices[].Lines[].SKU/Quantity/Price`) | `cin7-adapter.ts` | fields as in `Cin7SaleInvoiceLine` | missing lines => "invoice lines not returned" difference | read a lines-bearing invoice |
| C9 | A fulfilment of R0 lines posts COGS, no revenue | physical lifecycle (Slice F) | unknown | read-only display only | ship a disposable line; read `COGSAmount` |
| C10 | Assembly demand/shortfall visibility for a finished-goods SKU on an authorised Sale | Slice F | `/ref/productavailability` Sku filter unverified; finished-goods list proven read-only | reads only; unknown => shown as unknown | read-only probes |

## Recorded outcomes
(none yet) - append evidence per proof: exact commit, Cin7 document references, sanitised request/response, before/after state, PASS/FAIL.
