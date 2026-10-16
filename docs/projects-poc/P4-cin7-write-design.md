# Projects POC — Gate P4: Cin7 write-design report

**Status: DESIGN ONLY. V1 = PASS; Option A is PROVISIONALLY VIABLE. No Cin7 write exists in code and none has ever been made (LIVE CIN7 WRITES: NONE). P5 (one trial draft invoice) is NOT AUTHORISED and needs Anton's separate, explicit approval.**

### Evidence legend (used throughout P0 and P4)
- **PROVEN** — confirmed against a real Cin7 account and recorded in this repo (e.g. the `/sale` + `/sale/quote` create contract, 2026-08-26).
- **OBSERVED** — seen in a real GET response from the read-only V1 probe on the NewQuip trial org (2026-10-16). OBSERVED is never upgraded to PROVEN.
- **UNVERIFIED** — everything else, including every invoice-create detail below. An item stays UNVERIFIED until it is PROVEN by an authorised probe.

### V1 status (read-only probe) — PASS
**V1 = PASS for architecture discovery.** See `P0-cin7-architecture.md` §9 for the full evidence, caveats and decision-rule outcome. OBSERVED in the NewQuip trial org (GET only):
- one Sale can contain multiple invoices — **but that example was created manually in the Cin7 UI by Anton, not through the API**;
- invoices can exist before packing, and invoiced quantity can exceed packed quantity;
- an invoice can exist without a fulfilment;
- invoice value can be carried through `AdditionalCharges` (existing charge lines only);
- the invoice id field is `TaskID`; `InvoiceNumber` is present; `Memo` was empty on every invoice seen; no invoice-level searchable reference was observed.

**Architecture:** Option A (Toolbox Project → one Cin7 Advanced Sale → multiple progress invoices) is **PROVISIONALLY VIABLE**; Option C (one Sale per claim) is retained as the fallback. The earlier LBL-derived worry (invoicing fulfilment-coupled, from another account) is not borne out on NewQuip, but the API's ability to CREATE any of this is untested.

**Still UNVERIFIED — these are the P5 questions:** `POST /sale/invoice` endpoint; exact request body; API creation of a second invoice on an existing Sale; draft / non-authorised invoice status on create; a writable and searchable idempotency/reference field; writable free-text `AdditionalCharges` on an invoice; invoice-total constraints; Xero behaviour.

### Updates since first draft
- Role policy recorded as provisional: `provisional-role-policy.md`.
- Stale-claim policy implemented: a stale draft is rejected at approval (`STALE_DRAFT`) and never silently recalculated; the user explicitly recalculates, which creates a new draft (new snapshot, `supersedes_claim_id` lineage) and cancels the old one (`CANCELLED_BEFORE_WRITE`, original lines/snapshot untouched). §6 step 2.1's "re-verify snapshot hash" therefore also gates P5: a claim whose snapshot is stale can never reach `CIN7_PENDING`.
Every item marked **UNVERIFIED** has no create-side evidence in this repository or from Cin7 documentation retrievable in this session; the read-only probe (P0 §9) has run, so what remains must be settled by one authorised create probe (P5) before any code is written.

## 1. Invoice endpoint

| | |
|---|---|
| Endpoint | **UNVERIFIED.** The repo has no invoice-create contract. By analogy with the proven `POST /sale/quote`, the candidate is `POST /sale/invoice` — **not confirmed to exist with that shape**. |
| Draft state | **UNVERIFIED** whether a `DRAFT`/`NOT AUTHORISED`-style status is accepted on create (the quote step accepted `Status: "DRAFT"`). |
| Classification | When written, the call MUST be registered in `docs/cin7-post-classification.json` as `nonIdempotentCreate`, or the repository test fails the build. |
| Gateway | Only through `cin7Request` in `src/cin7/http.ts` (CCT-ADR-0006): fixed origin, shared rate limiter (CCT-ADR-0009), ambiguity thrown not retried. |

## 2. Proposed request (HYPOTHETICAL — shape copied from the proven quote contract; to be proven in P5)

```jsonc
POST /sale/invoice            // UNVERIFIED path
{
  "SaleID": "<cin7 sale id>",                 // the project's anchor Sale
  "Status": "DRAFT",                           // UNVERIFIED allowed value
  "InvoiceDate": "2026-10-15",
  "Memo": "PRJ-001-C02",                       // our claim number = reconciliation reference (UNVERIFIED which field persists/searchable)
  "AdditionalCharges": [                       // free-text lines, no SKU (shape proven on /sale/quote; UNVERIFIED on invoices)
    { "Description": "Manufacturing — Progress claim 50% → 65%", "Quantity": 1, "Price": 450000.00,
      "Discount": 0, "Tax": 67500.00, "TaxRule": "<resolved rule>", "Total": 450000.00, "Account": "<revenue account>" },
    { "Description": "Delivery — Progress claim 0% → 25%", "Quantity": 1, "Price": 500000.00, ... }
  ]
}
```

Money would be converted from integer cents to a 2-dp number only at this edge. `Tax` is sent per line (Cin7 uses the value we send — proven for quotes), rounded half-up per line exactly as the engine does; `Total` is net when tax-exclusive, gross when inclusive (proven for quotes).

**Expected response (UNVERIFIED):** invoice id + number + `Total`/`Tax`/`TotalBeforeTax`, mirroring the quote response.

## 3. Relationship to the Advanced Sale (anchor)

Preferred (Option A, see P0): one Advanced Sale per Project, created from the approved baseline with **one service/charge line per stage** (value = stage value), so progress invoices are partial invoices of stage lines and no stock is drawn down. **OBSERVED (V1, read-only):** a Sale can hold several invoices (a UI-created fixture) and an invoice can precede fulfilment. **UNVERIFIED:** (a) that the **API** allows a second/partial invoice against such lines; (b) that the API can create an invoice before fulfilment; (c) whether the Sale total must cover all invoices. Fallback (Option C): one small Sale per claim, `ExternalID = <project>/<claim>`, fully provable with the existing create contract.

## 4. Free-text / service-line requirements

If `AdditionalCharges` is rejected on invoices, stage lines need a Service-type product SKU. Cleanest configuration: **one generic service product "Project Progress Claim" per instance, created by the owner** (never auto-created by the Toolbox), referenced by SKU on every stage line with the stage description in the line `Name`/`Description`. **Do not create production SKUs without owner approval.** Revenue account and tax rule come from the customer/instance, not constants.

## 5. Fulfilment, multiple-invoice and Xero implications

- **Fulfilment:** the Toolbox allocates BOM lines to stages for visibility only; physical stock moves stay on separate Cin7 documents. **OBSERVED (V1, NewQuip):** invoices exist before packing and without a fulfilment link, so existing invoices are not coupled to fulfilment state. Whether the **API** will create an invoice that is not tied to a fulfilment is **UNVERIFIED**; if it refuses, Option A fails and Option C is used.
- **Multiple invoices per sale:** Sales model `Invoices[]` as an array (`src/cin7/sales.ts`) and the warehouse queue already handles multi-invoice fulfilment links (0097). **OBSERVED (V1):** one NewQuip Sale carries 2 invoices — created manually in the Cin7 UI by Anton. Whether the API can CREATE a second invoice on an existing Sale is **UNVERIFIED**.
- **Xero:** **UNVERIFIED / DEFERRED.** Connection state is not knowable from Toolbox data. If connected, each authorised Cin7 invoice would presumably sync as its own Xero invoice (reference/number uniqueness unverified). The Toolbox does not touch Xero; Xero Projects is not used.

## 6. Idempotency mechanism (design — the money-critical part)

Already implemented locally and DB-enforced (migration 0101, `project-store.ts`):

1. A claim has a **durable idempotency key** (`unique(org_id, idempotency_key)`) and a **unique claim number** (`unique(org_id, claim_number)`); one Cin7 link per claim (`unique(claim_id)` on `project_cin7_links`); one per `(org_id, external_id)`.
2. **State is persisted BEFORE the network call.** Order of operations for P5:
   1. Re-read claim; require `APPROVED`; re-verify snapshot hash + baseline hash (fail closed on drift).
   2. In one DB transaction: `APPROVED → CIN7_PENDING` and insert the `project_cin7_links` row (`external_id = claim number`). The unique constraints make a concurrent second submit fail here, before any Cin7 call.
   3. **Before writing, check Cin7** for an existing document carrying our reference (GET the sale's `Invoices[]`); if found, adopt it (→ `CIN7_CREATED`), never create.
   4. Single `cin7Request` with `nonIdempotentCreate: true` — never retried inside the gateway.
3. Results: definite success → `CIN7_CREATED` with ids; **definite pre-send failure (validation 4xx, nothing created)** → may release only with `no_write_evidence`; **any ambiguous outcome → `FAILED_UNCERTAIN`**, which keeps the value reserved and blocks overlapping billing.

## 7. Ambiguous-timeout recovery

Never "request failed ⇒ create again". A `FAILED_UNCERTAIN` claim is resolved only by **reconciliation**: GET the Sale and look for an invoice carrying our claim reference.
- Found → `CIN7_CREATED` (store ids), then reconcile.
- Positively not found → `FAILED_CONFIRMED_NO_WRITE` with `no_write_evidence {method: EXTERNAL_ID_LOOKUP_EMPTY, checkedAt, detail}`. The DB refuses to release a reserving claim without that evidence. **Not age-based** (consistent with CCT-ADR-0002): elapsed time alone never releases a claim. Whether an invoice's reference is searchable/immediately consistent is **UNVERIFIED** — if not, an uncertain claim stays reserved until a human resolves it.

## 8. Reconciliation procedure

After create (and on demand): re-read the Cin7 invoice and verify **customer, reference/claim number, line count + descriptions, subtotal, tax, total, document id, status** against the frozen claim snapshot (all integer-cent comparisons). Store the evidence in `project_cin7_links.reconciliation_evidence`; only then `CIN7_CREATED → RECONCILED`. A locally `CIN7_CREATED` claim with no verified evidence is not reconciled. Any mismatch leaves the claim `CIN7_CREATED`, flags it, and blocks nothing silently — corrections are future credit-adjustment scope.

## 9. Safety rules for P5

- NewQuip **TRIAL** organisation only; throwaway/trial customer; one claim; DRAFT state only.
- Before the call, report to Anton: target org, customer, endpoint, document type, exact payload, expected Cin7 state, rollback (void/delete the draft in Cin7 UI; local claim stays `FAILED_UNCERTAIN` until reconciled).
- Duplicate-retry proof: after the first create, repeat the action and show no second invoice appears.
- `no-cin7-write.test.ts` must be consciously edited for the new module-level write path — it currently forbids any Cin7 import under `src/lib/projects` / `src/app/projects`.

## 10. Recommendation

The read-only probe has run (V1 = PASS): **Option A is PROVISIONALLY VIABLE**, with Option C retained as the fallback. **P5 is NOT AUTHORISED** and needs Anton's separate, explicit approval, a reviewed exact payload, idempotency key and reconciliation plan, and the NewQuip POC trial organisation only. P5 must settle the UNVERIFIED items above; if the API cannot create a second invoice on an existing Sale, or cannot create a charge-only invoice, fall back to Option C.
