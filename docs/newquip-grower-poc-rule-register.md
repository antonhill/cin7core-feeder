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
| GROWER-ROOMS-001 | Project qty (derived) | rooms | ×12 | per-room × rooms | workbook P101; **Sean R2 #1: a room is an actual room within a building (6 buildings × 2 rooms = 12)** | high | **VERIFIED** | automatic | n/a | n/a | n/a | **confirmed (R2)** |
| GROWER-TANK-001 | 13.39t bulk feed tank | pigs/building | 1 | none ("based on 650 kg/m³") | D83 typed | none | REQUIRES NEWQUIP VALIDATION | manual | yes | unmapped | UNMAPPED | **yes** |
| GROWER-AUGER-001 | M75 Flex auger system | length, rooms | 1 ("2 x lines") | none | D84 typed. **Sean R2 #6: formulas in worksheet W / W1 (hidden K–O) are still current — NOT yet ported (workbook not in repo)** | none | REQUIRES NEWQUIP VALIDATION | manual | yes | package | Master SKUs (R2) | **needs the workbook** |
| GROWER-FEEDER-001 | CCM feeder | pigs/room, pens | 18 | **R2 #2: depends on pigs per pen and feeder capacity; CCM = 45 pigs (PNQ082).** Rounding / split-pen rule OPEN | E85 typed `=18` | medium | REQUIRES NEWQUIP VALIDATION | manual (estimator enters quantity) | yes | PNQ082 | source-backed | **Round 3 (HIGH)** |
| GROWER-MAT-001 | Feed saver mat | (feeder) | 18 | = feeder qty | E86 formula `=E85` | high | PROVISIONAL | automatic | yes | unmapped | UNMAPPED | confirm (depends on feeders) |
| GROWER-DRINKER-001 | Grower cup drinker | pigs/room | 54 | **R2 #3: 15 pigs per drinker.** Rounding / minimum / hospital pens OPEN. Suggested (unrounded) 600 ÷ 15 = 40 ≠ Topigs 54 | E87 typed | medium | REQUIRES NEWQUIP VALIDATION | manual (suggested) | yes | package (+ Master NB3542-03 recorded, not chosen) | package | **Round 3 (HIGH)** |
| GROWER-SLAT-001 | Concrete slat 1.2×0.45 | **slatted floor area (estimator input)** | 1320 | **R2 #4: driven by the actual slatted floor area; layouts/walkways vary — NO footprint-derived assumption.** Area → units / wastage OPEN | E88 typed `=110*12` | medium | REQUIRES NEWQUIP VALIDATION | manual | yes | NQ1161 | source-backed | **Round 3 (HIGH)** |
| GROWER-PEN-001 | PP penning | **pig size + running metres (estimator inputs)** | 244.87 m of panel (sold as 1 package) | **R2 #7: priced per RUNNING METRE by pig size (small/medium/large); NOT m².** Rates/SKUs not supplied | G Posts (2) rows 41–47 | medium | MANUAL | manual | yes | KNQPP005–008 family (historic) | estimator-priced | **Round 3 (HIGH)** |
| GROWER-LIGHT-001 | FORTIS 1.2 5000K LED | length, width | 38 | **R2 #5: minimum 1 light per 25 m²** (rounded up → 29 for 714.285 m²; Sean: "about 29"); customer may ask for more — Topigs' 38 was a customer-specific override. The area ÷ 14 guide is NOT the rule | D97 vs E97 | high | PROVISIONAL (rounding up is our reading) | default (overridable, reason required) | yes | **FORTIS 1.2: SKU REQUIRED** (HNQ7046 = historic FERAX surrogate) | unmapped | confirm round-up |
| GROWER-DOOR-001 | PVC SST door | — | 4 | **R2 #11: selection is ALWAYS manual; size is in the Cin7 description.** No sizing formula | row 98 | high | REQUIRES NEWQUIP VALIDATION | manual | yes | candidates NQ2114/2113/2112/2161/2281 | manual selection | no (by design) |
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

---

## Product / package decomposition (discovery, 2026-10-13)

**Commercial mapping discovery only. No engineering-rule classification above changed.** Sources: the Topigs workbook's
costing sheets (`AS.23.4015.07` summary → `W1`, `CCM`, `cup`, `G Posts (2)`, `FX`), the legacy ERP **Inventory Master**
(15 Sep 2026, Evolution item export with real average/latest/highest unit costs), and the synced Cin7 catalogue.

### What the workbook actually is
Each Grower summary line is priced by a **costing sheet that lists real part codes and quantities**:
`sell (ZAR ex-VAT) = (Σ EUR/USD part cost × ROE [EUR 19.08, USD 16.58] × freight/duty) [+ local ZAR parts] × markup`
(markup 1.15 on most lines, 1.075 on penning). Per-house sell total on the Topigs quote = **R977,143.40** (×12 = R11,725,720.80;
reconciles with `P99`/`P101`). So the earlier assumption "one quoted output = one SKU" is wrong for several lines.

### Master table
| Output | Likely type | Likely SKU / components | Source evidence | Cin7 evidence | Price/cost trust | NewQuip question | Confidence |
|---|---|---|---|---|---|---|---|
| 1 13.39t bulk tank | **A single SKU** | `SYSH-2750-3` | ERP "13.39 TONS SILO (NEWQUIP BRANDED)", Shandong Yuyun (USD). Sell R30,799 = ROUNDUP(36,234 × 85%) (typed list price less 15%) | Cin7 "1339 TONS SILO (NEWQUIP BRANDED)" (decimal lost). `SYSH-2750-4` = 16.58t "DON'T QUOTE" — not it | Cin7 cost 50 = SUSPECT; ERP avg R19,541 | Tank-size selection rule (engineering) only | **High** |
| 2 M75 Flex system | **B multi-SKU package** (not a Cin7 assembly) | `NQ1163` auger/m ×134, `T2750300` tube ×40, `T2750015` clamps ×48, `T2750301` elbow ×8, `NQ1984` drop kit ×18, `NQ.TUBE.63` drop tube ×5 (=ROUNDUP(drops/4)), `T3750001` control unit ×2, `TSA3750505` double unloader ×1, `T3000365` level switch ×2, `TRA1.1KW3PH` 1.5HP drive ×2, support post ×52 @R760 (SKU cell truncated "KNQ"; candidate `NQ2601`), `KNQ160` wall plate ×4 | `W1` sheet: coded lines with quantity formulas driven by system length (50), gable-to-silo (10), #augers (2), #drops (18). Sell R96,442 = ((€1,158.38 × 19.08 × 1.18) + R57,781.60) × 1.15. Description: "2 × lines of ±49.5m, incl. 18 × drop kits & support posts" | All components present in Cin7 **except `NQ.TUBE.63` and `TRA1.1KW3PH`** (present in ERP). Cin7 BOM holds only `CP001`, `NQ3173` | Cin7 costs mostly 50 = SUSPECT; ERP costs agree with workbook (e.g. T3750001 R1,711 vs €77.27 × 19.08 × 1.18 ≈ R1,739) | Are `W1` quantity formulas current? Support-post SKU; create/rename the 2 missing SKUs (data task) | High (composition) / Medium (quantities) |
| 3 CCM feeder | **A single SKU** (nipples bundled in the SKU) | `PNQ082` | `CCM` sheet: `PNQ082` "…WITH MONOFLO NIPPLE FOR GROWERS" Activate = 1 (€310, 300/container); `PNQ002` Activate = 0 (€203). Sell R8,163 each | Cin7 `PNQ082` ✓ (`PNQ082-WINDOW` = window variant) | Cin7 cost 50 SUSPECT; ERP avg R3,045 (hi R7,248, mixed history) | Confirm `PNQ082` is current | **High** |
| 4 Feed saver mat 1×1 m | **A single SKU** (likely) | `ERT053` | Price R919 = ROUNDUP(33 × 19.08 × 1.2 × 1.15) + R50; **no code in workbook**; description "1m × 1m under CCM feeder" | Cin7 `ERT053` "…ANTI-SLID (1000X1000MM)" — the only 1000×1000 mat. Not in ERP master (zero stock) | cost 50 SUSPECT | Confirm `ERT053` | Medium-high |
| 5 Grower cup drinker | **B multi-SKU package** | per drinker: `QCA00003` cup ×1, `NQ1380` 800mm SST pipe ×1, `NQ2784` backing plate ×1, `NQ2886` bracket ×1, `NQ1386` bolt ×5, `NYNUT` nut ×5, `NQ1017` washer ×5 | `cup` sheet "GROWER CUP" block; subtotal R475.99 × 1.15 = **R548** | All 7 in Cin7. **Current matcher candidates `NB3542-03`/`NB3543-30` (Ningbo cups) are NOT the sourced cup** — `QCA00003` (Qingdao) is | `NQ1380` ERP R168.40 = workbook R169.30 ✓; others 50 SUSPECT | None for composition; per-pen quantity is engineering | **High** |
| 6 Concrete slat 1.2 × 0.45 | **A single SKU + separate delivery** | `NQ1161`; delivery R51.22/slat | R254.22 = **203 + 51.22**: 203 ≈ ERP latest cost R193.60 × 1.05; 51.22 = crane-truck delivery bundled into the line | Cin7 `NQ1161` "(12x045M)" ✓ real stock 9,638 and a non-placeholder cost (R170.29); `NQ2341` (458 wide) is an alternative, not in the source. Delivery services exist: `DEL001`, `NQ1148` | `NQ1161` cost = UNKNOWN-plausible (ERP avg R184.22) | How is the R51.22 delivery derived (per slat? per truck)? | **High** (SKU) |
| 7 PP Green 50 × 0.9 m vented penning | **B multi-SKU package, layout-driven** | PP 50mm venti 0.9m panels (244.87 m total, 7 length groups) + SST posts/brackets/caps + `KNQ074` plastic door kit ×20, `KNQ085` cap ×20, hardware `NQ1175`×165, `NQ1089`×165, `NQ1386`×598, `NYNUT`×598, `NQ1017`×1196/165, `NQ2072`×104, `NQ1086`×329, `NQ1126`×329, `NQ1199`×121 | `G Posts (2)`: panels R135,257 + hardware R152,529 → **R287,786 for 20 pens (R14,390/pen)**; quantities are typed layout figures. Colour cell reads **"green?"** (the source itself is unsure) | No 0.9m green 50mm panel found; `BPP007` (1m black venti) / `BPP013` (35mm green) are near misses. The "25 candidates" are panels/posts/hardware, **not alternatives for one package** | 50 SUSPECT; `KNQ074` ERP R697 vs workbook R695.60 ✓ | PP panel SKU/colour; layout (drawing) → quantities | Medium |
| 8 FORTIS 1.2 5000K LED | **B multi-SKU package (3 SKUs)** | `HNQ7046` ×1 + clip ×3 + cable ×1 | `FX` sheet: €25.50 + 3 × €0.74 + €1.37 = €29.09 → ×1.2 × 19.08 × 1.15 × 1.15 = **R881 each** | Cin7/ERP name `HNQ7046` = **"FERAX 24W ON/OFF"** (Hato). ERP avg R484.29 ≈ €25.5 × 19.08 = R486.5 ⇒ same item under the FERAX name. **Workbook labels `HNQ7088` clip / `HNQ7093` cable; ERP/Cin7 have them the other way round** (by price magnitude the workbook codes are swapped) | 50 SUSPECT | Confirm FORTIS = FERAX 24W (HNQ7046); which of HNQ7088/7093 is clip vs cable | Medium-high |
| 9 PVC SST door (new type) | **E unknown** | candidates only: `NQ3444` "PVC SINGLE DOORS" (ERP avg R9,390), `NQ3537/3538` PVC single door SST & HDG 800×2m, `NQ3118/9/20` polyprop | No code, no price (cell "excluded"), qty 4 typed. Nothing narrows it | 14 plausible, all cost 50 | SUSPECT | Which door SKU and size | Low — **leave NEWQUIP CONFIRMATION REQUIRED** |

Cin7 name caveat: Cin7 names have lost decimal points relative to the ERP ("13.39" → "1339", "1.2x0.45M" → "12x045M"). Toolbox's
pull path does not strip characters (`str()` is a pass-through), so this most likely came with NewQuip's own Cin7 load — unconfirmed.

### Commercial-field trust (every candidate)
* **Average Cost = 50** (86% of the catalogue) → **SUSPECT**. Any other value → **UNKNOWN** (plausible where it matches the ERP: `NQ1163` R51 vs R52, `NQ1380` R122 vs R168 does *not*). Nothing is **TRUSTWORTHY** until NewQuip confirms.
* **Availability = 1000** → **SUSPECT**; others **UNKNOWN**.
* The **ERP Inventory Master is the better historic cost source** (real receipts, supplier names), but is a different system and date.

### Answer: A–E
**A. Likely single-SKU:** tank `SYSH-2750-3`, feeder `PNQ082`, mat `ERT053` (likely), slat `NQ1161`.
**B. Likely multi-SKU packages:** Flex (≈12 components), cup drinker (7), penning (≈20 lines), FORTIS lighting (3).
**C. Manual commercial lines:** slat **delivery** (R51.22/slat) and any freight/installation lines.
**D. Missing / historic:** none truly missing — FORTIS is `HNQ7046` under the FERAX name; `NQ.TUBE.63` and `TRA1.1KW3PH` are missing from Cin7 (present in ERP); the door is unidentified; `SYSH-2750-4` is "don't quote".

### Historic Topigs pricing — suitable as a labelled fallback? **PARTIAL**
Clean per-unit historic sell (ZAR, ex-VAT, 15% VAT added at foot) exists for 8 of 9 lines: tank R30,799; Flex R96,442 (package); feeder R8,163; mat R919;
drinker R548; slat R254.22 (203 + 51.22 delivery); penning R287,786 (package, 20 pens); lighting R881. **Door: none.** Currency: costs are EUR/USD
converted at ROE 19.08/16.58 (`C68`/`C69`) with freight and a 1.15 (1.075 penning) markup; the sheet also holds an older ROE (18.83). It is **historic**
(dated, FX-dependent) and must be a separate price source — `CURRENT CIN7` / `HISTORIC TOPIGS` / `MANUAL ESTIMATOR` / `NO PRICE` — never shown as Cin7 pricing.

### Does the POC need multi-SKU package support? **YES**
The POC assumes **commercial output → one Cin7 SKU** (`resolveMapping` returns one `sku`; `BridgeLine` carries one SKU). That fits tank, feeder, mat, slat but not Flex, drinker,
penning or lighting. **Smallest change:** a typed mapping on the commercial output —
`{ kind: "single", sku } | { kind: "package", components: [{ sku, qtyPerUnit | qtyRule, uom, note }] } | { kind: "manual" }` — kept in code (reviewed constants), not the
database. The bridge prices each component through the existing quote engine and the package line is their sum; component quantities that the workbook fixes (drinker 1/1/1/1/5/5/5,
lighting 1/3/1) are data, while layout-driven ones (Flex, penning) stay manual until NewQuip confirms. Candidate search then applies only to single-SKU outputs; package
definitions come from the workbook, not keyword matching. **Not built in this pass.** (The current matcher also misses two sourced SKUs: `QCA00003` and `HNQ7046`.)

### Revised questions for Sean
*Provable without him (now proven or evidenced):* tank, feeder and slat SKUs; drinker/lighting/Flex/penning **composition and part codes**; historic sell prices and pricing chain.
*NewQuip only needs to confirm:* `ERT053` for the mat; FORTIS = FERAX 24W `HNQ7046` and the clip/cable code swap; Flex support-post SKU; create/rename `NQ.TUBE.63` and
`TRA1.1KW3PH` in Cin7; the door SKU/size; PP panel SKU and colour ("green?"); slat delivery as a separate charge; whether the `W1`/`FX`/`cup`/`G Posts` figures are current; whether Cin7 costs (50) and stock (1000) are placeholders.
*Genuinely engineering (Sean):* feeder, drinker, slat, light and door **quantity rules**; tank sizing; Flex system layout (#augers, #drops=18, run length); penning layout → quantities; the meaning of "rooms"; override authority; pricing policy (Cin7 tier vs cost × markup × FX).

---

## Implemented commercial mapping structure (Phase 2 — package foundation)

Code: `src/newquip/grower/commercial.ts` (model + reviewed constants), `mapping.ts` (candidate precedence / status),
`quote-bridge.ts` (pricing). **Engineering rule classifications are unchanged**; nothing here computes how many units are needed.

Three concerns are kept apart:
| Concern | Lives in | Question it answers |
|---|---|---|
| Engineering rule | `rules.ts` | How many commercial units are needed? (all still awaiting NewQuip) |
| Package definition | `commercial.ts` | What makes up ONE commercial unit? |
| Cin7 commercial data | looked up at run time | What does each component cost/sell for today? (never stored in code) |

`CommercialMapping = single | package | manual | unresolved`. A **single** mapping carries a *source-backed recommendation* — documentary
evidence, **not** NewQuip's approval; it stays AMBIGUOUS ("Source-backed — confirm") and `sku = null` until a person confirms it in the session.
Precedence: (1) source-backed SKU, listed first and flagged; (2) explicit human confirmation → MAPPED; (3) plausible catalogue candidates; (4) UNMAPPED.
Package outputs skip fuzzy search entirely (its hits were components, not alternatives).

> **Partly superseded by the Round 2 section at the end of this file** (LED light, M75 SKUs/drive unit, penning, drinker, PVC door).

| Output | Mapping | Detail |
|---|---|---|
| Bulk tank | single → `SYSH-2750-3` | recommendation; `SYSH-2750-4` excluded |
| CCM feeder | single → `PNQ082` | recommendation |
| Feed saver mat | single → `ERT053` | recommendation (medium-high) |
| Concrete slat | single → `NQ1161` | recommendation; **delivery is a separate manual line** (`concrete_slat_delivery`, historic R51.22/unit, documentation only) |
| Cup drinker | **package, 7 components** | `QCA00003` ×1, `NQ1380` ×1, `NQ2784` ×1, `NQ2886` ×1, `NQ1386` ×5, `NYNUT` ×5, `NQ1017` ×5 — *source_fixed* composition (not an engineering quantity) |
| LED light | **package, 3 components** | `HNQ7046` ×1 source-backed; clip ×3 and cable ×1 **identity unresolved** (`HNQ7088`/`HNQ7093` contenders, no SKU assigned) |
| M75 Flex | **package, 12 components** | codes + Topigs quantities kept as *historic reference* (`requires_validation`, `qtyPerUnit = null`); `NQ.TUBE.63`, `TRA1.1KW3PH` flagged not in Cin7; support post unresolved (`NQ2601` candidate) |
| Penning | **package, layout-driven** | families + sourced codes; all quantities *requires_validation*; panel SKU/colour not invented |
| PVC SST door | **unresolved** | NEWQUIP CONFIRMATION REQUIRED |

Pricing behaviour: a package is priced component-by-component through the existing quote engine and contributes to totals **only when every
component is priced** (all-or-nothing); otherwise it is *package incomplete* and adds nothing. Historic Topigs quantities and prices are never used.
Average Cost = 50 and availability = 1000 are flagged *suspect* (data warning, not blocker). The package must also be explicitly confirmed ("Use this package").


---

## Round 2 (2026-10-16) — what Sean confirmed, what the build does, what stays OPEN

Sources: `NewQuip_Grower_POC_Sean_Validation_v3_Round2 feedback.xlsx` (Sean / Shirnel / Rene, 14/10/2026) and the owner's Round 2
brief (which also cites `NewQuip Master 05 Oct 2026 NEW.xlsx`). **Neither the Master nor the Topigs workbook is in this repository or
on the build machine**, so Master-derived facts below are recorded *as stated in the owner's brief* and are NOT independently verified here.

| # | Topic | Confirmed | Build behaviour | Still OPEN |
|---|---|---|---|---|
| 1 | Rooms | An actual room within a building; Topigs = 6 buildings × 2 rooms = 12 | Labels/help say *rooms*; dims, pens, pigs are per room; `pigsPerBuilding` renamed `pigsPerRoom` (assumes Sean's "±600 / building" is per room — 20 pens × 30) | — |
| 2 | Feeders | Depends on pigs/pen and capacity; CCM = 45 pigs; PNQ082 | Capacity shown; quantity = estimator entry ("ESTIMATOR INPUT REQUIRED"); no ceil() | Rounding, split/hospital pens (R3 #3) |
| 3 | Drinkers | 15 pigs per drinker; NB3542-03 per the Master | Unrounded suggestion (40 for Topigs, ≠ historic 54); estimator confirms. The existing 7-part package is kept; **NB3542-03 recorded as an alternative identity, never priced** (Sean R1 confirmed the 7 parts; the two sources conflict) | Rounding / minimum / hospital (R3 #4); which representation prices the drinker |
| 4 | Slats | Driven by actual slatted floor area; layouts vary | `slattedFloorAreaM2` estimator input; the footprint-derived hypothesis is **removed**; final quantity estimator-entered | Area → units, wastage (R3 #5) |
| 5 | Lighting | Minimum 1 per 25 m²; customer may exceed; Topigs 38 = customer override | DEFAULT = ceil(area/25) (29/room); override is visible, keeps the default, needs a reason | Whole-light rounding (our reading, matches Sean's "about 29") |
| 6 | FORTIS | FORTIS 1.2 is current; HNQ7046 (FERAX 24W) was a historic surrogate; no FORTIS SKU | "FORTIS 1.2 — SKU REQUIRED / UNMAPPED"; HNQ7046 shown as surrogate only; package stays incomplete | FORTIS SKU (R3 #8) |
| 7 | M75 | Hidden W/W1 formulas (K–O) still current; Master SKUs NQ1223, NQ1227, NQ1764, NQ1942, NQ.TUBE.75 | SKUs updated; main auger tube, clear drop tube and NQ.TUBE.63 kept distinct; **formulas NOT ported — the workbook is not available** | The workbook itself |
| 8 | Drive unit | TRA1.1KW3PH → NQ3132 (1.5HP, 1.1kW, 380V); Master Retail shows 0 | NQ3132 mapped; **PRICING EXCEPTION — never priced, never zero** | Price treatment (R3 #7) |
| 9 | Penning | Running metres, not m²; by pig size; SKU per size (KNQPP005–008, new sizes new SKUs) | Pig size + running-metre inputs; **no rate invented**; ESTIMATOR PRICING REQUIRED; old 17-part layout BOM removed from code (it is in git history / this register's earlier sections) | Rates / SKUs (R3 #6) |
| 10 | PVC doors | Manual selection; size in the Cin7 description | Manual select among NQ2114/2113/2112/2161/2281; no sizing formula | — |
| 11 | Delivery / installation | Service reports, courier invoices, distance | Estimator-entered ex-VAT amounts (delivery, installation, slat delivery); required before a budget is "complete" | — |
| 12 | Day-to-day pricing | Retail price (an output of the controlled model) | Cin7 price tier; cost/ROE/freight/MU not exposed; **Average Cost is withheld server-side from non-admins** | Tier behaviour (R3 #10) |
| 13 | Project pricing | "Cost + 20%" (unresolved meaning) | **No formula.** Project quotes show ESTIMATOR PRICING REQUIRED; an estimator-entered selling price is the only total | R3 #1 (BLOCKER) |
| 14 | Price source | Excel Master today | `pricing-source.ts` descriptor; interim = Cin7 synced price tiers; swappable | R3 #2 (BLOCKER) |
| 15 | Ventilation | Fans were in an earlier quote not yet ingested | Marked **PENDING REFERENCE QUOTE VALIDATION**; no fan/cooling/controller rule | R3 #9 |

Round 3 open items (all **OPEN**; `src/newquip/grower/round3.ts`, shown in the UI): BLOCKERS 1 project pricing meaning, 2 price source of truth ·
HIGH 3 feeder rounding, 4 drinker rounding/minimum, 5 slat area→units, 6 penning rates/products, 7 NQ3132 pricing ·
MEDIUM 8 FORTIS SKU, 9 fan/cooling/controller scope, 10 customer/agent price-tier behaviour.

Conflict flagged: Sean's Round 1 sheet marked the feeder "Change needed → PNQ082-WINDOW", but the owner's Round 2 brief (Master) confirms PNQ082.
The code follows the newer brief and does not auto-confirm either.

Beta UX: every quantity carries one of AUTO-CALCULATED (none yet — no item rule is verified), DEFAULT / SUGGESTED (lighting minimum), or
ESTIMATOR INPUT REQUIRED / ESTIMATOR INPUT. Overrides capture a reason (Sean R1: "they must give a reason"); a missing reason blocks the budget.
