# Claude Code Brief — Cin7 Toolbox Quotation + Margin Module

> Saved verbatim from the brief Anton provided (2026-08-25). This is the source of
> truth for the module scope. The Phase 0 discovery report lives in
> `docs/quotation-margin-module.md`. Note: the brief's header path
> `/Users/antonhill/cin7core-feeder` is the repo at `/Users/antonhill/Documents/cin7core-feeder`.

## Purpose

Design and implement a new **Quotation + Margin** module inside:
`/Users/antonhill/cin7core-feeder`

The module must allow a user to:

* build a sales quotation inside Toolbox;
* select a Cin7 customer;
* load customer/accounting/shipping defaults;
* add products;
* see stock availability;
* see estimated line margin;
* see estimated overall quote margin;
* adjust quantity, price and discount interactively;
* save a local Toolbox draft;
* create the quote safely in Cin7 Core;
* store the margin snapshot used when the quote was created;
* link the Toolbox record to the resulting Cin7 Sale/Quote.

Cin7 Core remains the **system of record** for the authorised/saved quote.
Toolbox becomes the commercial decision layer used to construct it.

Do not clone Cin7's Advanced Sale UI pixel-for-pixel. Preserve the familiar structure, but improve the quoting workflow around margin visibility, speed and safety.

---

# 1. Important implementation posture

Before writing the Cin7 quote-create path:

1. inspect the existing Toolbox architecture;
2. inventory the existing Cin7 customer/product/price/availability data already cached locally;
3. inspect the current Cin7 write gateway/idempotency architecture;
4. probe the current Cin7 Sale API behaviour required for quote creation;
5. document the exact API contract to use;
6. only then implement.

Do not create a parallel security or API architecture.
Reuse the existing:

* Cin7 gateway;
* distributed quota coordinator;
* authentication;
* organization resolution;
* module/write authorization;
* credential loader;
* audit logging;
* non-idempotent create protection;
* reconciliation patterns;
* Supabase architecture;
* CI guardrails.

---

# 2. Product objective

The main business advantage over Cin7's native quoting screen should be:

> **The user can see the commercial impact of every line while constructing the quote.**

Each line should show:

* selling price;
* discount;
* net selling price;
* estimated cost;
* gross profit;
* estimated margin %;
* availability.

The quote footer should show:

* subtotal excl. tax;
* estimated cost;
* estimated gross profit;
* estimated overall margin %;
* tax;
* quote total incl. tax.

---

# 3. V1 scope

Implement V1 only.

## Included

* Quotes navigation/module
* Quote list
* New Quote
* Quote Detail
* Toolbox draft saving
* Customer selection
* Contact/default customer data
* Billing address
* Shipping address
* Payment terms
* Price tier
* Sales representative
* Revenue account where required
* Tax rule
* Tax inclusive setting
* Cin7 location
* Quote date
* Required-by date
* Customer reference
* Shipping notes
* General comments
* Product search
* Product lines
* Quantity
* Unit price
* Discount
* Net selling price
* Tax
* Line total
* Average Cost
* Estimated gross profit
* Estimated line margin
* Overall estimated quote margin
* Product Availability snapshot
* Additional charges
* Local draft
* Safe Cin7 quote creation
* Cin7 Sale ID / quote number
* Activity log
* Link to Cin7
* Margin snapshot preservation

## Explicitly exclude from V1

Do not implement yet:

* customer-facing online quote acceptance;
* e-signatures;
* automated quote email;
* PDF designer;
* CRM opportunity management;
* advanced approval workflows;
* automatic manager approval;
* freight-rate integrations;
* quote version comparison;
* quote templates;
* bundled kits/families beyond existing Toolbox capability;
* automatic conversion to order;
* automated follow-up reminders.

Design so these can be added later.

---

# 4. First task — inspect current data sources

Before adding API calls, determine what is already available in Supabase.
For each required field, document its preferred source:

| Data                 | Preferred source        | Fallback                        |
| -------------------- | ----------------------- | ------------------------------- |
| Customers            | local synced/cache data | targeted Cin7                   |
| Contacts             | local if available      | targeted Cin7                   |
| Products             | local cache             | targeted Cin7                   |
| SKU                  | local cache             | Cin7                            |
| Product name         | local cache             | Cin7                            |
| Price tiers          | local/cache             | Cin7                            |
| Average Cost         | local/cache             | targeted Cin7                   |
| Product Availability | existing snapshot       | targeted Cin7 only if necessary |
| Locations            | local reference cache   | Cin7                            |
| Tax rules            | local reference cache   | Cin7                            |
| Payment terms        | local reference cache   | Cin7                            |
| Sales reps           | local/cache             | Cin7                            |
| Revenue accounts     | local/cache             | Cin7                            |
| Customer addresses   | local/cache             | targeted Cin7                   |

Target architecture:
`Cin7 → Toolbox/Supabase cache → Quote UI`
not:
`every UI interaction → Cin7`
Avoid increasing API consumption unnecessarily.

---

# 5. Quote data model

Design appropriate Supabase tables.

Suggested conceptual model:

## `quotes`

Fields may include:

* id
* org_id
* cin7_instance_id
* status
* customer_id
* customer_name_snapshot
* contact_id
* contact_name_snapshot
* billing_address_snapshot
* shipping_address_snapshot
* payment_terms
* price_tier
* sales_rep
* account
* tax_rule
* tax_inclusive
* location
* quote_date
* required_by
* customer_reference
* comments
* shipping_notes
* currency
* exchange_rate
* subtotal_ex_tax
* tax_total
* total_inc_tax
* estimated_cost
* estimated_gross_profit
* estimated_margin_pct
* cin7_sale_id
* cin7_sale_number
* cin7_quote_status
* created_by
* created_at
* updated_at
* submitted_at

Possible statuses:

* `draft`
* `submitting`
* `submitted`
* `ambiguous`
* `failed`

Do not invent excessive lifecycle states unless needed.

## `quote_lines`

Suggested fields:

* id
* quote_id
* org_id
* product_id
* cin7_product_id
* sku
* product_name_snapshot
* quantity
* list_price
* unit_price
* discount_pct
* net_unit_price
* tax_rule
* tax_rate
* line_subtotal_ex_tax
* tax_amount
* line_total_inc_tax
* average_cost_snapshot
* estimated_line_cost
* estimated_gp
* estimated_margin_pct
* availability_snapshot
* price_source
* sort_order
* created_at
* updated_at

`price_source` could be:

* `tier`
* `manual`

This lets the UI clearly show whether a salesperson has manually overridden the customer's normal price.

---

# 6. Margin calculations

Margin must use **revenue excluding tax**.
Do not calculate margin on VAT-inclusive revenue.

For each line:

```text
Net Unit Price      = Unit Price × (1 - DiscountPct / 100)
Line Revenue Ex Tax = Net Unit Price × Quantity
Estimated Line Cost = Average Cost × Quantity
Estimated GP        = Line Revenue Ex Tax - Estimated Line Cost
Estimated Margin %  = Estimated GP / Line Revenue Ex Tax × 100
```

Handle: zero selling price; negative margin; 100% discount; missing cost; zero quantity; decimal quantities if supported.
If revenue is zero: `margin = N/A`. Do not divide by zero.

---

# 7. Overall quote margin

Do **not** average individual line margin percentages. Correct formula:

```text
Total Revenue Ex Tax     = sum(line revenue ex tax)
Total Estimated Cost     = sum(estimated line cost)
Estimated Gross Profit   = Total Revenue Ex Tax - Total Estimated Cost
Overall Estimated Margin % = Estimated Gross Profit / Total Revenue Ex Tax × 100
```

This correctly weights high-value lines.

---

# 8. Cost basis

Use Cin7 **Average Cost** as the V1 cost basis unless investigation proves a better available equivalent already exists in Toolbox.
Label this explicitly in the UI: `Estimated Margin` or `Estimated margin based on Cin7 Average Cost`.
Do not label it `Actual Margin`. The quote margin is an estimate at quote time; actual COGS may later differ.

---

# 9. Preserve the quote-time cost snapshot

Average Cost can change after the quote is created. Therefore store: Average Cost used on each line; calculated estimated cost; line GP; line margin; overall GP; overall margin; calculation timestamp.
The historical quote should continue showing `Quoted margin` based on the cost snapshot at creation. Do not silently recalculate old quoted margin using today's Average Cost. A future version may also show `Current estimated margin` (out of V1 unless trivial).

---

# 10. Multi-currency

Investigate the current currency architecture. Selling prices and Average Cost must be compared in the **same currency**.
If quote currency equals Cin7 base currency: calculate normally.
If quote currency differs: identify the correct Cin7/customer quote exchange rate and convert the cost basis into quote currency, or normalize both amounts into base currency before calculating.
Store: quote currency; exchange rate used; base-currency cost; quote-currency estimated cost if applicable.
Display a note such as: `Estimated margin based on Cin7 Average Cost converted at the quote exchange rate.`
Do not compare ZAR cost directly with EUR/USD selling price. Add multi-currency tests.

---

# 11. New Quote page layout

Use the Cin7 Advanced Sale screenshots as UX inspiration. Recommended desktop layout:

**Top customer/accounting/shipping section — three columns:**
- Customer details: Customer\*, Contact, Phone, Email, Reference, Billing address, Price tier\*
- Accounting details: Terms, Sales rep\*, Account\*, Tax rule\*, Tax inclusive, Skip quote only if relevant to API contract
- Shipping details: Location\*, Quote date\*, Ship-to company, Ship-to contact, Shipping address, Shipping notes, Required by, Carrier/service

Then: **Comments** (full-width).
Do not reproduce fields that have no relevance to quote creation purely because Cin7 shows them.

---

# 12. Quote line table

| Product | Available | Qty | Unit Price | Discount | Net Price | Avg Cost | GP | Margin | Tax | Total |
| ------- | --------: | --: | ---------: | -------: | --------: | -------: | -: | -----: | --- | ----: |

For narrower displays, allow columns to collapse sensibly. Product row shows SKU + description/name. Availability may show available quantity + location. Avoid hitting Cin7 live per line if the current Product Availability snapshot is fresh enough.

---

# 13. Product search

Search local Toolbox product data first. Support SKU, product name, barcode if available. Do not full-fetch Product from Cin7 when typing.
On selection populate: SKU, description, tier price, average cost, tax rule, availability, product ID. If relevant data is stale/absent, use a targeted Cin7 lookup rather than a full product scan.

---

# 14. Customer selection

When customer is selected, populate defaults where available: contact, email, phone, billing address, shipping address, payment terms, price tier, tax rule, revenue account, salesperson if customer-specific/default, currency, other relevant defaults.
Clearly distinguish inherited defaults from manually overridden fields.

---

# 15. Price tier behaviour

Use the selected customer's/default price tier. When adding a product: calculate initial selling price from the price tier; store list/tier price; mark `price_source = tier`. If user manually changes price: `price_source = manual`.
If price tier later changes and manually overridden lines exist, prompt before overwriting those manual prices. Example: "Changing price tier will reprice 8 lines. 2 lines have manually overridden prices. Preserve manual prices?" Do not silently destroy manual overrides.

---

# 16. Discount behaviour

Support line-level percentage discount in V1. Whenever discount changes, recalculate immediately: net unit price, GP, margin, tax, total, overall quote margin. Do not require a server round trip merely for arithmetic. Server must independently recalculate/validate before final Cin7 submission. Never trust client-calculated financial totals.

---

# 17. Margin intelligence

Allow organization-level margin thresholds (healthy / warning). Example: >= 35% Healthy, 25–34.99% Review, <25% Low. Do not hardcode these values globally.
For V1: visually indicate line margin; visually indicate overall margin; warn but do not block submission. Do not implement manager approval yet.

---

# 18. Required-price helper

If straightforward, include `Price required for target margin`:

```text
Required Net Price = Estimated Cost / (1 - TargetMargin)
```

Treat this as a quoting aid. If it materially increases V1 scope, defer it.

---

# 19. Additional charges

Support Cin7 quote additional charges: | Description | Qty | Price | Cost | GP | Margin | Tax | Total |.
Do not invent a zero cost where no cost is known. For an uncosted charge: `Estimated cost: —`, `Margin: N/A`.
Decide whether uncosted charges are excluded from the margin denominator/cost calculation, or included as revenue with unknown cost. Whatever choice is made must be explicit in the UI. Do not silently inflate margin.

---

# 20. Quote summary

Provide a persistent summary area (Subtotal excl VAT, Estimated cost, Estimated GP, Estimated margin %, VAT, Quote total). Also show number of lines, currency, any missing-cost warning. Example: "2 lines excluded from estimated margin because cost is unavailable."

---

# 21. Draft saving

Provide `Save Draft` — saves only to Toolbox, does not call Cin7. Drafts let a salesperson leave, return, continue editing, see previously calculated margin. Draft activity records created by, last updated, organization, Cin7 instance.

---

# 22. Cin7 quote creation — discovery/probe first

Before implementing POST logic, verify the exact current Cin7 Sale API contract required to create a quote. Probe and document: required endpoint; required fields; quote-vs-order switch; `OrderStatus` behaviour; draft vs authorised quote behaviour; response structure; Sale ID; quote/order number; customer field requirements; location requirements; revenue account; tax; price tier; additional charges; shipping fields; comments/memo; whether Sales Representative uses ID/name; whether PriceTier uses string/name; whether unknown/null fields are rejected or ignored.
Cin7 documentation appears inconsistent around quote creation status semantics. Do not guess. Use a safe test Cin7 account/record if available. **Do not create a real commercial transaction in a customer account purely for testing without an explicitly safe method.**

---

# 23. Quote create action

Provide `Create Quote in Cin7`. The server action should conceptually perform:

```text
authenticated user → resolve active org → require correct module access → requireWriteAllowed
→ load Cin7 instance → server-side quote validation → server-side recalculate totals/margin
→ idempotency claim → POST quote to Cin7 → handle definite/ambiguous result → reconcile if necessary
→ save Cin7 Sale ID/number/status → snapshot quote margin → activity log → return result
```

Do not let the browser call Cin7 directly.

---

# 24. Non-idempotent create protection

Creating a quote is a **non-idempotent create**. It must participate in the same integrity philosophy as PO and Stock Transfer creation. A lost response must not auto-resend. Use `nonIdempotentCreate: true` or the equivalent canonical mechanism.

---

# 25. Quote idempotency claim

Design a quote-creation claim mechanism. Potential stable identity: Toolbox quote UUID + org + Cin7 instance. The same Toolbox quote must not be submitted twice from a double-click/refresh. `quote_id + instance_id` should identify one Cin7 submission attempt. Statuses: pending / ambiguous / completed. Follow the hardened PO/Transfer lifecycle patterns; do not blindly reuse their schema if quote requirements differ.

---

# 26. Ambiguous-result reconciliation

If Cin7 may have created the quote but Toolbox lost the response: mark ambiguous; do not auto-resend; reconcile against Cin7; if found, bind the Toolbox quote to the existing Cin7 Sale; if absence positively confirmed, permit retry; if still uncertain, fail closed and tell the user the quote is being confirmed.
Do not match only using customer + total (not unique). Prefer a stable Toolbox-generated reference included in a Cin7 reference field if the API supports it without interfering with the customer's own visible reference. Investigate the best reconciliation key before implementation.

---

# 27. Cin7 result handling

After successful creation save: Cin7 Sale ID, Cin7 Sale/Quote number, resulting status, submitted time. Show a success summary. Provide `Open in Cin7` if a reliable Cin7 record URL can be constructed. Do not invent a URL pattern without verifying it.

---

# 28. Draft vs Cin7 status

Toolbox status and Cin7 status should be distinct fields. Do not collapse different state machines into one field.

---

# 29. Quote list

Quotes page with at minimum: | Quote | Customer | Date | Value | GP | Margin | Owner | Toolbox status | Cin7 status |. Filters: search, customer, salesperson, status, date, margin band. Sort by newest by default. Use Toolbox DB; do not call Cin7 for every list render.

---

# 30. Quote Detail

Display: Customer/details; Lines (incl quoted cost/margin snapshot); Summary; Cin7 (Sale ID, quote number, quote status, submitted timestamp, open-in-Cin7); Activity. If only a Toolbox draft, allow editing. After successful Cin7 submission, V1 may make the local submitted quote read-only unless an edit-sync strategy is explicitly implemented. Do not accidentally create a second editable source of truth.

---

# 31. Editing after Cin7 creation

For V1: Toolbox draft editable → submitted Cin7 quote read-only in Toolbox. Do not implement two-way editing unless the API semantics and conflict behaviour are deliberately designed. Add `Open in Cin7 to edit` if appropriate.

---

# 32. Authorization

Create a dedicated Toolbox module permission `quotes` (or equivalent). At minimum: permitted member can view/create quote drafts; write must pass module + billing/write authorization; org isolation applies; direct cross-org quote access impossible. Do not automatically require admin/AAL2 merely because a quote creates a Cin7 write if existing approved member-facing Cin7 writes do not require it. Follow the product policy established during security closure.

---

# 33. Margin visibility permission

Investigate whether margin/cost visibility should use the existing module permission, a separate `view_margin`/commercial permission, or org-wide permission. Do not automatically expose Average Cost/margin to every user if current Toolbox roles intentionally hide commercial information. If no commercial visibility framework exists, document the decision required before implementing broad cost visibility. Average Cost is commercially sensitive.

---

# 34. Audit logging

Record high-value events: quote draft created; quote submitted; quote submission failed; quote submission ambiguous; quote successfully reconciled; Cin7 quote created. For final Cin7 create log: actor, org, instance, Toolbox quote ID, Cin7 Sale ID/number, customer reference/name as appropriate, value, outcome. Do not log Cin7 API key, unnecessary customer PII, or raw API response. Margin may be included if existing activity logs allow commercial amounts, but review privacy/sensitivity first.

---

# 35. Validation

Server-side validation must include: valid customer; active organization; valid Cin7 instance; location; tax rule; lines; positive/allowed quantity; price; valid discount range; product IDs/SKU; valid currency; exchange rate where required; totals independently recalculated; quote belongs to current org; not already successfully submitted. Do not trust client totals.

---

# 36. Concurrency

Protect against double click, two browser tabs, refresh during submission, repeated submit after network timeout. The UI should disable submit while locally pending, but the backend claim is the true integrity boundary.

---

# 37. Availability display

Use the existing Product Availability cache where possible. Show availability for the selected quote location (Available / On Hand / On Order). Only show quantities already defined by the existing model. Do not invent alternative stock semantics. Availability is informational; V1 should not block quoting on insufficient availability unless that is already a business rule elsewhere.

---

# 38. UX warnings

Useful, specific warnings: low margin; negative margin; missing Average Cost; manually overridden price; insufficient availability; missing tax configuration; missing customer defaults; ambiguous Cin7 submission. Avoid generic "Something went wrong." For ambiguous submission: "Cin7 may have created this quote, but Toolbox could not confirm the response. Do not submit it again while we verify whether the quote exists."

---

# 39. Performance/API efficiency

Respect the API-efficiency architecture. Do not add: full Product scans on search; full Customer scans on every page; repeated Location/Tax/Terms fetches; one Product Availability request per line; unnecessary Cin7 reads on quote-list rendering. Instrument quote-related Cin7 calls through the central gateway so telemetry can attribute `workflow = quotation`.

---

# 40. Required tests

Comprehensive tests across: margin calculations (positive, discount, negative, zero revenue, missing cost, decimal qty, weighted overall, tax inclusive/exclusive, multi-currency); customer defaults (tier, terms, tax, address, location); price override (tier, manual, tier-change-with-override); authorization (org, cross-org denied, module denied, write/billing denied); idempotency (double submit, network loss after commit, ambiguous found/absent, reconciliation failure, settlement persistence failure, eventual retry cannot duplicate); Cin7 payload (exact mapping to verified contract); audit log (success/failure/ambiguous/reconciliation); RLS (member cannot access another org's quote, quote lines isolated, service functions scoped).

---

# 41. Database security

Any new quote tables must have RLS enabled, explicit intent, participate in the existing permission-intent/security testing, and never rely solely on UI filtering for tenant isolation. Add them to the established RLS intent matrix/regression framework. Do not weaken the completed security architecture.

---

# 42. CI

All existing security and CI guardrails must remain green:

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Plus: dependency scan; secret scan; migration/bootstrap; SQL/RLS tests; Cin7 gateway boundary; POST classification; service-role allowlist; privileged action inventory. Update any allowlist intentionally where new reviewed call sites are introduced. Do not bypass a guardrail simply to make CI green.

---

# 43. Implementation phases

- **Phase 0 — Discovery.** Before coding produce a concise implementation report: current cache/data sources; verified Cin7 quote-create API contract; quote state model; reconciliation key; margin visibility permission decision; multi-currency approach; additional-charge margin treatment; exact planned files/migrations. If a product decision is required, stop and ask Anton.
- **Phase 1 — Data + calculations.** Quote tables; RLS; calculation module; unit tests; draft CRUD.
- **Phase 2 — Builder UI.** Customer section; accounting/shipping section; line editor; availability; live margin; quote summary; local draft.
- **Phase 3 — Cin7 submission.** Verified payload; safe non-idempotent create; claim; reconciliation; audit; Cin7 identifiers.
- **Phase 4 — List/detail.** Quotes page; Quote Detail; status; margin snapshot; open in Cin7.
- **Phase 5 — Adversarial verification.** Independent skeptic review against: duplicate quote creation; stale/missing cost; cross-org access; margin arithmetic; multi-currency; price override; client-total tampering; failed audit logging; API call explosion; stale availability; ambiguous submission lifecycle. Fix actual V1 defects found. Do not expand into V2.

---

# 44. Required final implementation report

Create `docs/quotation-margin-module.md` documenting: Architecture; Database schema; Permissions; Margin calculation; Cost basis; Multi-currency; Cin7 API contract; Create/reconciliation lifecycle; API usage; Tests; Security/RLS; Known limitations; Deferred V2 features; Verification results.

---

# Definition of Done

The Quotation + Margin V1 is complete only when: user can create a Toolbox draft; customer defaults populate; products searchable without wasteful full Cin7 scans; correct price tier applied; manual overrides preserved; availability displayed; average cost obtained correctly; line estimated margin correct; overall weighted margin correct; VAT does not distort margin; multi-currency margin correct where applicable; missing-cost behaviour explicit; additional-charge margin treatment explicit; draft reopenable; server recalculates financial values independently; quote safely created in Cin7; duplicate Cin7 quote creation protected; ambiguous responses reconcile safely; Cin7 Sale ID/number/status saved; quote-time margin snapshot preserved; submitted quote viewable in Toolbox; user can open the corresponding Cin7 record; RLS and org isolation tests pass; audit logging correct; no new API-efficiency regression; existing security guardrails remain green; full CI passes; adversarial verification finds no unresolved V1 blocker.

Do not mark the module complete from UI behaviour alone. The final test is:

> A salesperson can confidently construct a commercially sensible quote in Toolbox, understand its estimated profitability before submitting, create exactly one corresponding quote in Cin7 Core, and later see exactly what margin assumptions were used when that quote was made.
