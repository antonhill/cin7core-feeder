# Projects POC — Gate P4: Cin7 write-design report

**Status: DESIGN ONLY. No Cin7 write exists in code. P5 (one trial draft invoice) needs Anton's separate, explicit approval.**

### Evidence legend (used throughout P0 and P4)
- **PROVEN** — confirmed against a real Cin7 account and recorded in this repo (e.g. the `/sale` + `/sale/quote` create contract, 2026-08-26).
- **OBSERVED** — seen in a real GET response from the read-only probe. **Nothing is OBSERVED yet: the probe has not been run** (no Toolbox credentials on the build machine; see `gate-runbooks.md`).
- **UNVERIFIED** — everything else, including every invoice-create detail below. An item stays UNVERIFIED until it is PROVEN by an authorised probe.

### V1 status (read-only probe)
**Prepared, NOT RUN — no NewQuip observations exist yet.** See `P0-cin7-architecture.md` §9 for the run commands, what is captured, the pre-committed decision rules (A / C / INSUFFICIENT EVIDENCE) and the observations table awaiting the owner's run. Current standing recommendation: **INSUFFICIENT EVIDENCE.**

**New risk flagged from the repository's own LBL records (OBSERVED on another account, not NewQuip):** Cin7's multi-invoice behaviour there is fulfilment-coupled (invoice ↔ fulfilment cross-reference; one invoice per fulfilment). Unknown #1 for Option A is now whether an invoice can exist **without** a fulfilment link / before packing. A GET probe can show whether such invoices exist; only the P5 create proof can show whether the API will create one.

### Updates since first draft
- Role policy recorded as provisional: `provisional-role-policy.md`.
- Stale-claim policy implemented: a stale draft is rejected at approval (`STALE_DRAFT`) and never silently recalculated; the user explicitly recalculates, which creates a new draft (new snapshot, `supersedes_claim_id` lineage) and cancels the old one (`CANCELLED_BEFORE_WRITE`, original lines/snapshot untouched). §6 step 2.1's "re-verify snapshot hash" therefore also gates P5: a claim whose snapshot is stale can never reach `CIN7_PENDING`.
Every item marked **UNVERIFIED** has no evidence in this repository or from Cin7 documentation retrievable in this session; it must be settled by the read-only probe (P0 §6) and then one authorised create probe before any code is written.

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

Preferred (Option A, see P0): one Advanced Sale per Project, created from the approved baseline with **one service/charge line per stage** (value = stage value), so progress invoices are partial invoices of stage lines and no stock is drawn down. **UNVERIFIED:** (a) that Cin7 allows partial/multiple invoices against such lines; (b) that an invoice may precede fulfilment; (c) whether the Sale total must cover all invoices. Fallback (Option C): one small Sale per claim, `ExternalID = <project>/<claim>`, fully provable with the existing create contract.

## 4. Free-text / service-line requirements

If `AdditionalCharges` is rejected on invoices, stage lines need a Service-type product SKU. Cleanest configuration: **one generic service product "Project Progress Claim" per instance, created by the owner** (never auto-created by the Toolbox), referenced by SKU on every stage line with the stage description in the line `Name`/`Description`. **Do not create production SKUs without owner approval.** Revenue account and tax rule come from the customer/instance, not constants.

## 5. Fulfilment, multiple-invoice and Xero implications

- **Fulfilment:** the Toolbox allocates BOM lines to stages for visibility only; physical stock moves stay on separate Cin7 documents. Whether Cin7 couples an invoice to fulfilment state is **UNVERIFIED** — this is precisely what the read-only probe inspects (`Invoices[]` vs `Fulfilments[]` states). If invoicing requires fulfilment, Option A fails and Option C is used.
- **Multiple invoices per sale:** Sales model `Invoices[]` as an array (`src/cin7/sales.ts`) and the warehouse queue already handles multi-invoice fulfilment links (0097), so the read side tolerates it; whether Cin7 will CREATE a second invoice on a sale is **UNVERIFIED**.
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

Do **not** proceed to P5 until the read-only probe has been run on the trial instance. Outcomes decide the anchor: multiple invoices present and decoupled from fulfilment ⇒ Option A; otherwise Option C.
