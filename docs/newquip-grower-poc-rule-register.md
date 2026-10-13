# NewQuip Grower House POC — rule register & validation checkpoint

Status: **INTERIM** (built before NewQuip's business-rule questionnaire). Source: Topigs Warden quotation
`AS.23.4015.07` (xlsm + pdf), `Growers.xlsx` (input form only — no formulas), Inventory Master (not yet mined).
Engine: `src/newquip/grower/rules.ts` (the code is the table; this file must list every rule id — enforced by
`access-and-register.test.ts`).

## Key finding about the source

In the Topigs workbook the Grower quantities are **typed constants, not formulas**: `E85 = 18`, `E87 = 54`,
`E97 = 38`, `E88 = 110*12`. The only real formulas are `E86 = E85` (mat = feeder), `B77 = A76*B76` (area),
`D97 = B77/14` (a lighting *guide* the estimator then overrode: 51.0 vs 38 typed) and `P101 = P99*G79`
(per-room total × rooms). So the historic outputs prove *what was quoted*, almost never *why*.

Quantities in the quote are **per room**, multiplied by "Number of rooms" (12) at the foot. Whether "room" means a
house section or a whole repeated building is itself a question for NewQuip (Q0).

## Classification legend

VERIFIED = proven by source + safe to compute · PROVISIONAL = relationship evidenced in source, unconfirmed ·
MANUAL = estimator decision, not a formula · REQUIRES NEWQUIP VALIDATION = inferred only.
**No BOM item rule is VERIFIED.** Only the two derived-geometry rules below are.

## Register

| Rule ID | Output | Source inputs | Topigs observed (per room) | Provisional relationship | Evidence | Confidence | Class | Mode | Override | Cin7 SKU | Mapping | Sean? |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| GROWER-GEO-001 | Floor area (derived) | length, width | 714.285 m² | length × width | workbook B77 | high | **VERIFIED** | automatic | n/a | n/a | n/a | no |
| GROWER-ROOMS-001 | Project qty (derived) | rooms | ×12 | per-room × rooms | workbook P101 | high | **VERIFIED** | automatic | n/a | n/a | n/a | confirm meaning of "room" (Q0) |
| GROWER-TANK-001 | 13.39t bulk feed tank | pigs/building | 1 | none ("based on 650 kg/m³") | D83 typed | none | REQUIRES NEWQUIP VALIDATION | manual | yes | unmapped | UNMAPPED | **yes** |
| GROWER-AUGER-001 | M75 Flex auger system | length, rooms | 1 ("2 x lines") | none | D84 typed | none | REQUIRES NEWQUIP VALIDATION | manual | yes | unmapped | UNMAPPED | **yes** |
| GROWER-FEEDER-001 | CCM feeder | total pens, hospital pens | 18 | total − hospital = 18 | E85 typed `=18` | medium | REQUIRES NEWQUIP VALIDATION | automatic | yes | unmapped | UNMAPPED | **yes** |
| GROWER-MAT-001 | Feed saver mat | (feeder) | 18 | = feeder qty | E86 formula `=E85` | high | PROVISIONAL | automatic | yes | unmapped | UNMAPPED | confirm (depends on feeders) |
| GROWER-DRINKER-001 | Grower cup drinker | pens | 54 | 3 × feeders (54 = 3×18, one data point) | E87 typed | low | REQUIRES NEWQUIP VALIDATION | automatic | yes | unmapped | UNMAPPED | **yes** |
| GROWER-SLAT-001 | Concrete slat 1.2×0.45 | length, width | 1320 | floor(L/0.45) × floor(W/1.2) = 110 × 12 | E88 typed `=110*12`; area ÷ 0.54 m² ≈ 1323 | medium | REQUIRES NEWQUIP VALIDATION | automatic | yes | unmapped | UNMAPPED | **yes** |
| GROWER-PEN-001 | PP Green 50×0.9 vented penning pkg | pens | 1 ("20 pens") | none | row 95 | none | REQUIRES NEWQUIP VALIDATION | manual | yes | unmapped | UNMAPPED | **yes** |
| GROWER-LIGHT-001 | FORTIS 1.2 5000K LED | length, width | 38 | area ÷ 14 = 51.0 (workbook guide) — **contradicted** by 38 | D97 formula vs E97 typed | low | REQUIRES NEWQUIP VALIDATION | automatic | yes | unmapped | UNMAPPED | **yes** |
| GROWER-DOOR-001 | PVC SST door (not in brief's list) | — | 4 | none | row 98 | none | REQUIRES NEWQUIP VALIDATION | manual | yes | unmapped | UNMAPPED | yes |
| GROWER-OPT-001 | Thomas-CL1 controller | option flag | 0 (excluded) | — | row 89 | none | MANUAL | manual | yes | unmapped | UNMAPPED | yes |
| GROWER-OPT-002 | Silo weighing | option flag | 0 | — | row 90 | none | MANUAL | manual | yes | unmapped | UNMAPPED | yes |
| GROWER-OPT-003 | Control panel CL1 & BF | option flag | 0 (`=E89`) | follows controller | row 91 | low | MANUAL | manual | yes | unmapped | UNMAPPED | yes |
| GROWER-OPT-004 | Emergency windows | option flag | 0 (guide 6) | — | row 92 | none | MANUAL | manual | yes | unmapped | UNMAPPED | yes |
| GROWER-OPT-005 | Pad cooling | option flag | 0 (guide 18×1.5×0.15) | — | row 93 | none | MANUAL | manual | yes | unmapped | UNMAPPED | yes |
| GROWER-OPT-006 | 57" cone fans | option flag | 0 (guide 6) | — | row 94 | none | MANUAL | manual | yes | unmapped | UNMAPPED | yes |
| GROWER-OPT-007 | 250mm manure plug | option flag | 0 | — | row 96 | none | MANUAL | manual | yes | unmapped | UNMAPPED | yes |

Summary: **verified 2 (geometry only)** · **provisional 1** · **manual 7** · **awaiting Sean 9** (tank, auger, feeder,
drinker, slat, penning, lighting, door + mat's dependency).

## Cin7 verification (read-only, 2026-10-13)

* Two organisations are named "NewQuip POC". Only `e1aea782-…` has a connected Cin7 instance (also "NewQuip POC",
  active). `1a1a7fd8-…` has none. **Anton to confirm which is intended** — only `e1aea782-…` is allowed through the gate.
* *(Superseded by the catalogue section below — written before the Migrate pull.)* **Both had 0 synced products.** The Toolbox catalogue for NewQuip has not been imported/synced, so no SKU, price
  tier, Average Cost or active flag could be read for any of the eight products. Every mapping is therefore
  **UNMAPPED** (not "ambiguous": there are no candidates). *Action: run the product sync/Migrate for the NewQuip
  instance, then reload the POC — discovery (`discoverGrowerProductsAction`) will propose candidates by keyword
  and a person confirms the SKU.* No live Cin7 call was made. Stock availability is not exposed by the existing
  quote module, so it is not shown.
* The Topigs workbook prices from **EUR/USD cost × markup** (cells B68:B70), not Cin7 price tiers. The POC prices from a
  Cin7 price tier; this is a commercial-model question for NewQuip (Q-PRICE below).

## Visibility

Org-id gate (`src/newquip/access.ts`, precedent: `casa-das-natas.ts`), enforced in `layout.tsx` and in every
action, **plus** the org's normal Quotes module access (for the reused customer/reference actions). There is no nav
entry; the route is `/newquip-grower`. Today only org `e1aea782-d095-47ad-90fb-4fa65c9bf855` — and super-admins only
while impersonating it — can open it. A module-toggle gate was rejected: it is ON by default and hiding it needs a
`disabled_modules` migration.

## Save / reopen — not implemented (migration proposed, NOT applied)

The existing `quotes` / `quote_lines` tables hold priced lines and a free-text `notes` only; they cannot hold the
configuration or rule snapshot without stuffing JSON into `notes` (a contortion, and it would surface in the Cin7
sale note on submit). Proposed (needs a stream owner's go-ahead per CLAUDE.md principle 11):

```sql
-- 0101_newquip_grower_configurations.sql  (PROPOSED — not applied; number is the next free one at base 866b4e8)
create table newquip_grower_configurations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  quote_id uuid references quotes(id) on delete set null,   -- optional link to a priced draft
  project_name text, customer_name text,
  input jsonb not null,            -- GrowerConfigurationInput
  rule_snapshot jsonb not null,    -- GrowerCalculationResult at save time (+ rule register version)
  sku_mapping jsonb not null default '{}',
  created_by_email text, created_at timestamptz default now(), updated_at timestamptz default now()
);
alter table newquip_grower_configurations enable row level security;  -- service-role writes, same convention as quotes
```
Rollback: `drop table newquip_grower_configurations;` — additive, no existing table touched.

## Sean validation checkpoint

| Rule | Current evidence | Current hypothesis | What Sean must confirm | Effect if unanswered |
|---|---|---|---|---|
| Q0 rooms | Quote multiplies per-room totals by 12 (P101) | "room" = repeated unit | Is a room a house section or a whole repeated building? Are all quantities per room? | Every project total could be off by the rooms factor |
| CCM feeders (FEEDER-001) | `=18` typed; 20 − 2 = 18 | total pens − hospital pens | One per standard pen? Hospital pens? | Feeder, mat and drinker lines stay unquantified |
| Feed saver (MAT-001) | `=E85` formula | = feeders | One mat per feeder always? | Mat stays awaiting |
| Drinkers (DRINKER-001) | 54 typed; = 3×18 | 3 per feeder | Per pen or per feeder? Hospital drinker? | Drinker line unquantified |
| Concrete slats (SLAT-001) | `=110*12`; matches floor(L/0.45)×floor(W/1.2) exactly | grid count | Rule, slatted fraction, walkways, allowances | Slat line (the largest value) unquantified |
| Penning (PEN-001) | 1 package "(20 pens)" | none | Package definition and how it scales | Penning unquantified |
| Lighting (LIGHT-001) | 38 typed vs guide 51 | none usable | Real rule; why 38 | Lighting unquantified |
| Silo/tank (TANK-001) | 13.39t, "650 kg/m³" | none | Sizing method and size list | Tank unquantified; selection stays manual |
| Flex auger (AUGER-001) | "M75, 2 lines" | none | Size choice and BOM (length, elbows, drops, control) | Auger unquantified |
| Doors (DOOR-001) | 4 typed; not in brief | none | Fixed or derived? | Door unquantified |
| Optional equipment (OPT-001..007) | all 0 in Topigs | none | Triggers and quantity rules | Stays a manual entry |
| Estimator-only items | not visible in workbook | — | Which lines are always estimator-added | Cannot be flagged |
| Override behaviour | — | per-room integer, estimator may override any line | Who may override; must overrides be flagged on the quote? | POC allows any override, shown as MANUAL |
| Pricing model (Q-PRICE) | workbook: EUR/USD × markup | Cin7 tier price | Price from Cin7 tier or from cost × markup/FX? | Budget uses the chosen tier only |
| SKU mapping | NewQuip catalogue not yet synced | — | Confirm SKU for each of the 8+1 items | Lines stay UNMAPPED and unpriced |

## Catalogue mapping evidence (read-only, after Migrate → Pull, 2026-10-13)

Org `e1aea782-…`, instance `30eac8f2-…`. This section records **product identification only**. It changes no rule
classification above; product matching and engineering calculation are separate concerns.

### Verified catalogue (local tables)
products 12,595 (all active; 5 Service, rest Stock) · customers 1,124 · suppliers 1,204 · assembly BOM lines 5 (assemblies
`CP001`, `NQ3173` — neither is a Grower item) · product availability 13,464 rows covering 12,590 SKUs, all linked to a
product by SKU · **price_tiers: 0 rows**.

### Price-tier representation
Tier prices are not columns on `products`; they live in `price_tiers (org_id, product_sku, tier_code "Tier1".."Tier10",
amount)`. The Migrate pull maps Cin7's `PriceTier1..10` from `GET /Product` and **stores only amounts > 0**
(`toCanonicalPriceTiers`). Zero rows therefore means every pulled product had all ten tiers 0/absent in that response. It
does not prove Cin7 holds no prices: the Quotes builder deliberately re-reads tiers live per SKU
(`fetchProductTierPrices`) because the synced table can be incomplete. **Not yet resolved** whether NewQuip's trial has
selling prices at all.

### Average Cost coverage — populated but mostly a placeholder
12,595/12,595 non-null; 12,590 > 0 (5 are 0). But **10,795 products (86%) have Average Cost exactly 50** and 11,026
availability rows have on-hand exactly 1,000 — the signature of seeded/demo data, not real costing. Only 1,795 products
carry a distinct cost. Treat any cost of exactly 50 as **not trustworthy** until NewQuip confirms.

### Grower mapping table (nothing auto-confirmed)
| # | Grower output | Status | Candidate SKU(s) — exact Cin7 name | Cost / avail | Candidates | Confidence | Reasoning |
|---|---|---|---|---|---|---|---|
| 1 | 13.39t bulk feed tank | **UNMAPPED** | none for 13.39t. Near: `SYSH-2750-4` "1658 TONS SILO (NEWQUIP BRANDED) - DONT QUOTE"; `KNQ112` "8TON SILO (SQUARE)"; `NQ2176` "SILO 109MT INCL LADDER" | 50 / 1000 | 0 usable | — | No product states 13.39t; the one NewQuip-branded silo is flagged DONT QUOTE. |
| 2 | M75 Flex auger system | **UNMAPPED** | no "system" product. Components only, e.g. `T1750005` "AUGER M75", `T024` control unit, `T020` drop kit | 50 / 1000 | 0 as a package | — | The Topigs line is a package of parts; no assembly/BOM exists for it (BOM has only `CP001`, `NQ3173`). Needs Sean's BOM. |
| 3 | CCM feeder for growers | **AMBIGUOUS** | `PNQ082` "CCM FEEDER FOR GROWERS WITH MONOFLO NIPPLE"; `PNQ002` "CCM FEEDER FOR GROWERS"; `PNQ082-WINDOW` "CCM FEEDER INCL MONOFLO NIPPLE & WINDOW (GROWERS)" | 50 / 1000 each | 3 | medium-high for `PNQ082` | Topigs line says "Incl. monoflo drinking nipples" → `PNQ082` is the textual match; not confirmed. |
| 4 | Feed saver mat 1m × 1m | **AMBIGUOUS** (one strong candidate) | `ERT053` "FEED SAVER MAT 8/10MM ANTI-SLID (1000X1000MM)" | 50 / 1000 | 1 strong (+3 other sizes) | high | Only 1000×1000 mat. Kept AMBIGUOUS: the POC never auto-maps a single unconfirmed candidate. |
| 5 | Grower cup drinker (incl. 800mm SST pipe & bracket) | **AMBIGUOUS** | `NB3542-03` "CUP DRINKERS (NEW TYPE) GROWER & FINISHER"; `NB3543-30` "CUP DRINKERS (OLD TYPE) 30WP/ GROWER & FINISHER" (`QCA00005` is for SOW — excluded) | 102.25 / 1337; 84.46 / 1197 | 2 | medium for `NB3542-03` | Matches the POC's CUP_NEW selection and has real (non-50) cost; but the Topigs line also bundles pipe + bracket (separate SKUs `NQ2886`/`NQSP0016`). |
| 6 | Concrete slat 1.2m × 0.45m | **AMBIGUOUS** | `NQ1161` "CONCRETE SLAT (12x045M)"; `NQ2341` "CONCRETE SLAT (1200x458x70)" (`NQ2773` is 1.15 m — excluded) | 170.29 / 9638; 50 / 1000 | 2 | medium-high for `NQ1161` | `12x045M` = 1.2 × 0.45 m and carries genuine cost and stock; workbook size is 1200×450×70 so `NQ2341` (458 wide) is the alternative. |
| 7 | PP Green 50mm × 0.9m vented penning | **UNMAPPED** | no 50mm green vented product. Near: `BPP007` "PP 50MM VENTI 1M HIGH (BLACK) (PER METER)"; `BPP013` "PP 35MM VENTI 800MM HIGH(RECYCLED GREEN-PER METER)" | 50 / 1000 | 0 exact | — | Topigs line is a priced package incl. posts & fastening; catalogue holds per-metre panels and parts. |
| 8 | FORTIS 1.2 5000K LED | **UNMAPPED** | none. Only unrelated lighting, e.g. `ONC1000000265` "TULEX-HO-120-BASIC-3000K (LED TUBE LIGHT)" (3000K, different brand) | 50 / 1000 | 0 | — | No "FORTIS" anywhere in the 12,595 products. |
| 9 | PVC SST door (incl. frame, new type) | **AMBIGUOUS** | `NQ3118` / `NQ3119` / `NQ3120` "POLYPROP SINGLE DOOR INCL SST (…)"; `ERT013`/`ERT015` "PVC DOOR WITH ALU FRME & RUB JNT 2000x1000MM"; `NQ2837`/`NQ2900` "PVC DOOR 2MX800MM INCLUDING FRAME" | all 50 / 1000 | 4 | low | Names an SST/aluminium frame (`NQ2837` etc. name neither — excluded). Many sizes; no size in the Topigs line. |

Product IDs: the `products` table is keyed by `(org_id, sku)`; Cin7's product GUID is not stored locally (not read this pass).

### Commercial readiness
* **Mapped:** none. **Ambiguous:** 3, 4, 5, 6, 9. **Unmapped:** 1, 2, 7, 8.
* **Selling price: blocked for every item** — `price_tiers` is empty, so a mapped product would still be "no price"
  (the POC reports it; it is never priced at 0).
* **Cost / margin:** a cost exists for every candidate, but 86% of the catalogue sits at exactly 50, which looks seeded;
  only `NQ1161` (170.29), `NB3542-03` (102.25) and `NB3543-30` (84.46) look real. GP/margin would compute but not mean much.
* **Availability:** present for every candidate, and also mostly the 1,000 placeholder (real: slat 9,638; drinkers 1,337/1,197).
* **To unblock:** (a) check in Cin7 whether any Grower product has a PriceTier set; (b) Sean/NewQuip confirm the SKUs in the
  AMBIGUOUS rows and supply or create tank, Flex, penning and lighting products or package definitions.

### Status semantics — single definition (`src/newquip/grower/mapping.ts`)
`isPlausibleCandidate(item, name)` (every `include` pattern, no `exclude` pattern) is the only definition of a candidate;
`resolveMapping` is the only status derivation. **MAPPED** = one explicitly confirmed product; **AMBIGUOUS** = ≥1 plausible
candidate, none confirmed (a single candidate is never auto-confirmed); **UNMAPPED** = no plausible candidate. The earlier
UI showed UNMAPPED items as AMBIGUOUS because runtime discovery used loose single-keyword hits (any part containing
"silo", "M75", "penning"), whereas the audit applied judgement; both now use the shared matcher. Confirmations are
client-session state only (persistence needs the unapplied migration).

### VAT
The budget uses the **customer's Cin7 tax rule**, matched by exact name against `/ref/tax` — the same authority the Quotes
module uses — and the existing engine for the arithmetic. The previous POC picked the first tax rule whose name contained
"standard", which is order-dependent and can pick the wrong rule. The rate shown beside the customer is read from Cin7 at run
time; if it is not 15% for the Topigs reference, that is NewQuip's Cin7 tax configuration to correct in Cin7 (the POC does not
write to Cin7 and will not hard-code a rate).
