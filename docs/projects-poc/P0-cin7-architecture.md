# Projects POC — Gate P0: Cin7 architecture finding

Status: **INCOMPLETE BY DESIGN — Cin7 invoice behaviour is NOT yet proven. No Cin7 write is authorised or implemented.**
Updated after owner decisions (read-only probe approved; Xero unassumed; migration 0101 reserved).
Base: `origin/main` @ `866b4e8`. Branch `feature/newquip-projects-poc`.

## 1. What the repository PROVES today

| Fact | Evidence |
|---|---|
| A Cin7 Sale can be created in two non-idempotent steps (`POST /sale` then `POST /sale/quote`), by NAME references, with `ExternalID` as our reconciliation key; `TaxRule` is required on header and each line; Cin7 uses the `Tax` we send per line; `Total` is gross when tax-inclusive. | `src/cin7/sale-quote-write.ts` (confirmed live 2026-08-26, Spark Demo sandbox) |
| `AdditionalCharges[]` lines carry a free-text `Description` and **no SKU** (optional revenue `Account`). | `buildQuoteBody` |
| Ambiguous-create recovery by exact `ExternalID` match, claims that never age-reclaim when ambiguous. | `findSaleByExternalId`, `src/lib/quote-submit.ts`, CCT-ADR-0002/0007 |
| Sales read-side already models `Invoices[]` (plural), `CreditNotes[]`, `Fulfilments[]` as separate nested arrays of one Sale. | `src/cin7/sales.ts` (`Cin7SaleInvoice[]`), `docs/cin7-api-findings.md` §13f |
| Multi-invoice fulfilment links are already handled by the warehouse queue work. | migration `0097` |

## 2. What is NOT proven (and must not be assumed)

The repo contains **no Cin7 invoice-create contract**: no `POST /sale/invoice` wrapper, no probe, no recorded response. Public documentation could not be retrieved in a machine-readable form in this session (Apiary portal is JS-rendered; third-party mirrors list only Get/List/fulfilment actions). Therefore these P0 questions are **OPEN**:

1. Does `POST /sale/invoice` accept a **DRAFT** status, and what is the exact required body (`SaleID`, `Status`, `Lines[]`, `AdditionalCharges[]`, `InvoiceDate`, `BillingAddress` …)?
2. May a Sale carry **several** invoices when each is raised without matching fulfilment (Cin7 normally ties an invoice to the fulfilment/ship stage, and an Advanced Sale's invoice lines are normally constrained to ordered lines/quantities)?
3. Can an invoice use **free-text `AdditionalCharges`** (no SKU, no stock draw-down) as its only lines, i.e. "Manufacturing — progress claim to 65%"? Or must lines be Service SKUs?
4. Does the invoice total have to be ≤ the Sale's order total, and does Cin7 reject an invoice that exceeds un-invoiced order lines?
5. How does Cin7's Xero integration push *several* invoices off one Sale (reference/number uniqueness, `ExternalID` mapping)?
6. **Jobs**: no public API for Cin7 Jobs/milestones was found (a community request for Job Costing CRUD notes the absence). Treat as **no usable contract → Jobs is not a dependency** (as the brief instructs).

## 3. Recommendation (conditional)

**OPTION A — Toolbox Project → one Cin7 Advanced Sale → stage-based progress invoices — is the preferred target, CONDITIONAL on probes 1–5 passing.**

- *Advantages:* keeps Cin7 as system of record for the customer document and Xero flow; Toolbox owns baseline/stages/completion/claims (matches Source-of-Truth boundaries — Toolbox-local commercial state, Cin7 for transactions); fits the existing create/reconcile machinery (ExternalID, claims table pattern).
- *Limitations:* depends on Cin7 accepting free-text/charge-only invoices against a sale; the sale's own lines may need to represent the contract as **one service/charge line per stage** (value = stage value) so each progress invoice is a partial invoice of a stage line rather than a physical-quantity invoice.
- *Inventory:* physical stock lines should **not** live on the progress-billing Sale (or fulfilment would drive invoicing). Operational stock moves stay on separate Cin7 transactions; the Toolbox allocation table links them to stages for visibility only.
- *Xero:* unknown until probe 5; each Cin7 invoice would flow as its own Xero invoice. Claim number must be unique and carried in the invoice reference.
- *Reconciliation:* store claim↔`(cin7_sale_id, cin7_invoice_id, invoice_number)`; verify customer, reference, lines, subtotal, tax, total, status by re-reading the invoice; `RECONCILED` only with stored evidence.

**OPTION B (Cin7 Job + Sale): rejected for the POC** — no public Jobs API contract.
**OPTION C (fallback if probe 3 fails):** one Sale per claim (each claim = its own small Sale + invoice, linked by `ExternalID` = `PROJECT-REF/CLAIM-NO`). Always provable with the existing create contract, but fragments the project across many Cin7 sales and weakens "one anchor per project".

## 4. Required probe plan (needs Anton's approval; READ-ONLY first)

1. **Read-only**: `GET /sale?ID=` on existing sales in the NewQuip **trial** org with multiple `Invoices[]` — capture the live invoice shape, statuses and line model (no write).
2. Only after the P4 write-design report is approved: one create probe in the **NewQuip TRIAL org only**, against a throwaway customer, to answer questions 1–4. Record request/response in `docs/cin7-api-findings.md`. Classify the call in `docs/cin7-post-classification.json` as `nonIdempotentCreate` (a repository test fails the build otherwise).
3. Xero behaviour (question 5) can only be observed via a connected Xero org; if the trial org has none, document it as unverified.

## 5. STOP conditions

Do not build `POST /sale/invoice` code until probes 1–4 pass. If question 3 fails, fall back to Option C or re-scope; do not improvise undocumented endpoints.

> Evidence legend: **PROVEN** = confirmed on a real Cin7 account and recorded here; **OBSERVED** = seen in a real read-only GET response; **UNVERIFIED** = anything else. §1 items are PROVEN; §2 items are UNVERIFIED; nothing is OBSERVED yet.

## 6. Read-only probe — status (owner-approved GET-only on the NewQuip TRIAL instance)

**NOT YET RUN — blocked on credentials, not on approval.**

- The Toolbox credential path (`loadCin7Credentials`) needs the Toolbox's `SUPABASE_SERVICE_ROLE_KEY` and `ENCRYPTION_KEY`. Neither exists on this machine: the only `.env.local` files found belong to the unrelated `cashflowforecaster` project, which must not be used here. No Toolbox `.env.local` exists in any worktree.
- Nothing was fetched, so there is **no evidence yet** for: multiple `Invoices[]`, invoice IDs/statuses/totals, line representation, invoice-vs-fulfilment coupling, or reconciliation references. Nothing below is inferred.
- **To close this gap** a person with the NewQuip trial credentials runs `scripts/probe-sale-invoices-readonly.mjs` (GET-only, prints structure/counts only — no keys, names or addresses; a test pins that it contains no write verbs and a single network function). Paste its output here and this section is updated with the evidence.

## 7. Xero connection finding

**XERO BEHAVIOUR = UNVERIFIED / DEFERRED.** The Toolbox stores no Xero connection metadata (`grep` of `src/` and migrations finds Xero mentioned only in comments about Cin7's own Xero/QuickBooks sync). Whether NewQuip's Cin7 account has Xero connected cannot be proven from Toolbox data, and no Xero read, write or configuration change was made. This does not block the POC.

## 8. Gate V3 evidence (migration chain, not Cin7)
Full-chain replay of migrations 0001→0101 (102 files, no duplicate numbers) in PGlite on generic Supabase-platform stubs only (`auth`, roles, `storage`): all applied in order; 77 tables, all with RLS enabled (matches `scripts/migration-audit.mjs`); 0101 needs no app-table stubs. 24/26 repo SQL tests pass on that chain; the 2 failures (0058/0059, lock-expiry timing) fail identically **without** 0101. This is NOT the repository's normal mechanism (`supabase start` + `db reset`, needs Docker, unavailable here) — see the final report.

## 9. Gate V1 — read-only invoice probe: PREPARED, NOT RUN

**Status: NOT RUN. There are NO NewQuip observations yet.** This machine has no Toolbox credentials (no `SUPABASE_SERVICE_ROLE_KEY` / `ENCRYPTION_KEY`); per owner direction the probe is **prepared here and run by the owner** in a trusted environment that already holds them. Nothing in this section is NewQuip evidence until the output is pasted back.

### How it is run (GET only; NewQuip trial org only)
```
# 1. resolve org + instance by NAME only — decrypts nothing, calls Cin7 not at all
node scripts/probe-sale-invoices-readonly.mjs --org-name "NewQuip" --dry-run
# 2. the probe (add --instance-name "<name>" if the org has several active instances)
node scripts/probe-sale-invoices-readonly.mjs --org-name "NewQuip" --max 100
```
(Alternative with raw `CIN7_ACCOUNT_ID` / `CIN7_APP_KEY` for the trial account is still supported.) Read-only guarantees, all pinned by tests: one HTTP call site (GET); database reads are `select` only on `organizations` / `cin7_instances`; org must resolve uniquely and the instance must be unique and active or the script stops; the decrypted key stays in memory, is never printed or written; output is structure/counts only with reference-style text reduced to a masked shape; decrypt is proven byte-compatible with `src/cin7/crypto.ts`. The analysis code was self-tested against canned Cin7-shaped data (including a multi-invoice sale); that is NOT NewQuip evidence.

### What the probe captures
List level (all sales, no per-sale calls): invoice-state × picking × packing × shipping cross-tab. Per sale (up to `--max`, partially/invoiced first): invoice count/ids/numbers/statuses/dates/totals, lines vs `AdditionalCharges`, reference fields (`Memo`, `Reference`, `ExternalID`, …) as shapes, the invoice-side `LinkedFulfillmentNumber` and fulfilment-side `LinkedInvoiceNumber`, fulfilment pick/pack/ship statuses, and ordered / packed / invoiced quantities (to see whether invoicing and fulfilment are independent).

### Already recorded in this repository — a DIFFERENT account (LBL), historical, NOT NewQuip
Classification: **OBSERVED on the LBL account, as recorded in repo comments** — not re-verified, not NewQuip, never to be upgraded to PROVEN.
- `Invoices[]` is an array; a Sale "can be invoiced more than once over its life (e.g. partial shipments)" (`src/cin7/sales.ts`).
- Invoice `Status` values AUTHORISED, DRAFT, PAID seen live 2026-08-15; no VOIDED example seen (`src/cin7/sales.ts`).
- Invoices and fulfilments carry a two-way cross-reference — `Fulfilments[].LinkedInvoiceNumber` ↔ invoice `LinkedFulfillmentNumber` — confirmed live 2026-08-18; LBL's own flow is **one invoice per fulfilment** on multi-fulfilment sales (`supabase/migrations/0081_fulfilment_grain_invoicing.sql`).
- PROVEN from the documented API spec: credit-note lines reuse `SaleInvoiceLineModel` (`docs/cin7-api-findings.md` §13f). Nothing recorded states whether invoice `AdditionalCharges` exist or can be created.

**Reading (hypothesis only, to be tested on NewQuip):** on LBL, Cin7's multi-invoice behaviour looks **fulfilment-coupled** (an invoice covers a fulfilment). If NewQuip's data shows the same, Option A (progress invoices not tied to physical fulfilment) is at risk. The decisive NewQuip question is therefore: *does any invoice exist that is NOT linked to a fulfilment, or that was raised before packing?*

### Decision rules the NewQuip result will be judged against (set BEFORE seeing data)
| NewQuip observation | Recommendation |
|---|---|
| ≥1 sale with >1 invoice **and** ≥1 invoice not linked to a fulfilment / invoiced before any pack (invoiced qty > packed qty) | **OPTION A — PROVISIONALLY VIABLE** (still needs the P5 create proof; create contract stays UNVERIFIED) |
| >1 invoice per sale exist but every invoice is linked to a fulfilment and none precedes packing | **OPTION C — FALLBACK MORE LIKELY** |
| no sale with >1 invoice in the sample | **INSUFFICIENT EVIDENCE** (do not manufacture an example) |

### Observations table (to be filled from the owner's run — sanitized)
| Item | Result |
|---|---|
| Sales in list / inspected / with invoices / with >1 invoice | _pending_ |
| Invoice object keys; id field used | _pending_ |
| Invoice statuses observed | _pending_ |
| Totals independent per invoice? Invoice sum vs order lines total | _pending_ |
| Invoice ↔ fulfilment: linked count / not linked / invoiced-before-pack / part-packed-and-invoiced | _pending_ |
| Reference fields present (`Memo`/`Reference`/`ExternalID`/number/id) | _pending_ |
| Line detail returned in `GET /sale`? `AdditionalCharges` on invoices? | _pending_ — an observed charge line on an existing invoice would be OBSERVED only, never proof that the API accepts creating one |
| `POST /sale/invoice` contract | **UNVERIFIED** — a GET response cannot prove a create contract |
| Xero | **UNVERIFIED / DEFERRED** |
