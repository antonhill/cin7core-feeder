-- Seeds the "Lights by Linea — Warehouse Performance" scorecard_definition:
-- six weighted headline sections and all 33 KPI definitions, reconciled
-- exactly against the source Excel workbook
-- ("LBL_Warehouse_Review_Scorecard (version 2).xlsb").
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO:
--   - It does not assign this scorecard to any organisation
--     (organization_scorecards) — see 0092's own comment: no LBL org id is
--     hardcoded anywhere in this feature; assignment is a post-deploy
--     super-admin configuration step via /admin/warehouse-scorecards.
--   - It does not enable the module for any org beyond the off-by-default
--     seed in 0094.
--   - It does NOT create a scorecard_reviews row or any
--     scorecard_metric_results, even though the source workbook carries a
--     real score for 32 of the 33 KPIs. scorecard_reviews.review_period is
--     NOT NULL, and no reliable review-period date exists anywhere in the
--     workbook data reconciled against this seed — inventing one would
--     violate the explicit instruction not to guess a month. The workbook's
--     32 scores + 1 Not Scored + every reviewer comment are instead
--     preserved verbatim in each KPI's source_note below, clearly labelled
--     as an unscored historical reference — SOURCE-HISTORY LIMITATION,
--     recorded here rather than worked around: once a real review period is
--     confirmed, a human can create the actual scorecard_reviews /
--     scorecard_metric_results rows (e.g. via a one-off backfill informed
--     by these source_note values), which this migration deliberately does
--     not do on its own guess.
--   - scoring_method is 'REVIEWER' for every single KPI, with no
--     scoring_config anywhere in this seed — measuring an actual/evidence
--     automatically is a separate question from having an approved
--     percentage-to-score mapping, and no such mapping has been approved
--     for any of these 33 KPIs yet, not even Ship By compliance. Converting
--     any of these to scoring_method = 'RULE' is a future, explicit,
--     human-approved change.
--
-- Every target_text below is the workbook's own exact value — no
-- placeholders or flagged ambiguity remain; the prior seed's uncertain
-- Picking/Packing/Stock Accuracy/Cin7 Compliance targets, and one
-- misattributed source note (the "Anton - reporting" / "number of
-- authorised orders per day" comments, previously guessed onto Cin7
-- Compliance, actually belong to Order Flow KPIs 1 and 3), are corrected
-- here against the real workbook rather than left as they were.

do $$
declare
  v_def_id uuid;
  v_order_flow_id uuid;
  v_picking_packing_id uuid;
  v_stock_accuracy_id uuid;
  v_dispatch_id uuid;
  v_cin7_compliance_id uuid;
  v_org_people_id uuid;
begin
  insert into scorecard_definitions (name, description, review_frequency, active)
  values (
    'Lights by Linea — Warehouse Performance',
    'Monthly operational review focused on order flow, picking/packing accuracy, stock control, dispatch, Cin7 compliance and warehouse discipline — replacing the client''s Excel Warehouse Review Scorecard.',
    'monthly',
    true
  )
  returning id into v_def_id;

  -- All six sections in ONE statement — required by the weight-sum trigger
  -- (0092), which validates per statement, not deferred.
  insert into scorecard_sections (scorecard_definition_id, name, weight, display_order)
  values
    (v_def_id, 'Order Flow', 0.20, 1),
    (v_def_id, 'Picking & Packing Accuracy', 0.20, 2),
    (v_def_id, 'Stock Accuracy', 0.20, 3),
    (v_def_id, 'Dispatch Performance', 0.15, 4),
    (v_def_id, 'Cin7 Process Compliance', 0.15, 5),
    (v_def_id, 'Warehouse Organisation & People', 0.10, 6);

  select id into v_order_flow_id from scorecard_sections where scorecard_definition_id = v_def_id and name = 'Order Flow';
  select id into v_picking_packing_id from scorecard_sections where scorecard_definition_id = v_def_id and name = 'Picking & Packing Accuracy';
  select id into v_stock_accuracy_id from scorecard_sections where scorecard_definition_id = v_def_id and name = 'Stock Accuracy';
  select id into v_dispatch_id from scorecard_sections where scorecard_definition_id = v_def_id and name = 'Dispatch Performance';
  select id into v_cin7_compliance_id from scorecard_sections where scorecard_definition_id = v_def_id and name = 'Cin7 Process Compliance';
  select id into v_org_people_id from scorecard_sections where scorecard_definition_id = v_def_id and name = 'Warehouse Organisation & People';

  -- ── Order Flow section: Order Flow (3) + Backorders (3) + Receiving (3) ──

  insert into scorecard_metric_definitions
    (scorecard_section_id, category, name, target_text, evidence_source, scoring_method, metric_direction, display_order, source_note)
  values
    (v_order_flow_id, 'Order Flow', 'Authorised orders moving into picking without unnecessary delay',
      'Same day / agreed SLA',
      'AUTOMATED', 'REVIEWER', 'LOWER_IS_BETTER', 1,
      'Evidence available from the Ready to Pick bottleneck queue (same underlying qualification). Workbook note: "Report - indicating number of Auth per day." Workbook reference (unscored — no reliable review period recorded): score 7, status Acceptable.'),
    (v_order_flow_id, 'Order Flow', 'Packed orders waiting for invoicing',
      '< 1 working day',
      'AUTOMATED', 'REVIEWER', 'LOWER_IS_BETTER', 2,
      'Evidence available from the Packed but Not Invoiced bottleneck queue. Workbook reference (unscored — no reliable review period recorded): score 7, status Acceptable.'),
    (v_order_flow_id, 'Order Flow', 'Invoiced orders waiting for dispatch',
      '< 1 working day',
      'AUTOMATED', 'REVIEWER', 'LOWER_IS_BETTER', 3,
      'Evidence available from the Invoiced but Not Shipped bottleneck queue. Workbook comment: "Ship by Dates need to be added - an alternative process is needed for implementation so no DN get ''lost''." Workbook note: "Anton - reporting." Workbook reference (unscored — no reliable review period recorded): score 6, status Needs Attention.'),

    (v_order_flow_id, 'Backorders', 'Backorders identified correctly',
      '100%',
      'AUTOMATED', 'REVIEWER', 'REVIEW_ONLY', 4,
      'Evidence = current backorder count/list from the Backorders Awaiting Stock queue; whether they are "identified correctly" is a reviewer judgment the count alone cannot answer. Workbook comment: "unsure how to answer this." Workbook reference: genuinely Not Scored in the source workbook (not a guessed gap) — this is the one KPI the workbook itself never scored.'),
    (v_order_flow_id, 'Backorders', 'Procurement notified through Cin7/system process',
      '100%',
      'MANUAL', 'REVIEWER', 'REVIEW_ONLY', 5,
      'Workbook comment: "No notification but bulk orders done." Workbook reference (unscored — no reliable review period recorded): score 0 (a genuine scored zero, distinct from the Not Scored KPI above), status Critical.'),
    (v_order_flow_id, 'Backorders', 'Old backorders reviewed regularly',
      'Weekly',
      'AUTOMATED', 'REVIEWER', 'REVIEW_ONLY', 6,
      'Evidence = oldest backorder age from the Backorders Awaiting Stock queue. Workbook comment: "Kaylin checking open PO and updating ETA." Workbook reference (unscored — no reliable review period recorded): score 7, status Acceptable.'),

    (v_order_flow_id, 'Receiving', 'Supplier deliveries received into Cin7 promptly',
      'Same day',
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 7,
      'Phase 2 automation candidate (purchase receipt timestamps exist in synced data but receipt-promptness qualification is not built/tested). Workbook comment, preserved verbatim rather than converted into a rule: "This is not current standard SOP - If goods received in afternoon have until next morning to receive" — a review/configuration question, not a new SLA. Workbook reference (unscored — no reliable review period recorded): score 8, status Acceptable.'),
    (v_order_flow_id, 'Receiving', 'Quantity and product checked before receipt',
      '100%',
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 8,
      'Workbook reference (unscored — no reliable review period recorded): score 8.5, status Acceptable.'),
    (v_order_flow_id, 'Receiving', 'Backordered sales orders returned into fulfilment correctly',
      '100%',
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 9,
      'Backorder-to-PO linkage data exists (backorder_po_number/backorder_eta) as adjacent evidence a reviewer can consult, but does not itself establish correctness of the return-to-fulfilment step. Workbook comment: "unsure what this means - Does it relate to Pat authorising?" Workbook reference (unscored — no reliable review period recorded): score 8, status Acceptable.');

  -- ── Picking & Packing Accuracy section: Picking (3) + Packing (3) ────────

  insert into scorecard_metric_definitions
    (scorecard_section_id, category, name, target_text, evidence_source, scoring_method, metric_direction, display_order, source_note)
  values
    (v_picking_packing_id, 'Picking', 'Picking accuracy',
      '≥ 99%',
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 1,
      'Workbook reference (unscored — no reliable review period recorded): score 6, status Needs Attention.'),
    (v_picking_packing_id, 'Picking', 'Correct SKU, colour, quantity and project picked',
      '≥ 99%',
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 2,
      'Workbook reference (unscored — no reliable review period recorded): score 6, status Needs Attention.'),
    (v_picking_packing_id, 'Picking', 'Pickers working from Cin7 rather than emails/manual lists',
      '100%',
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 3,
      'Workbook comment: "Using CIN7 as base, in conjunction with checking any relative email correspondence." Workbook reference (unscored — no reliable review period recorded): score 7, status Acceptable.'),

    (v_picking_packing_id, 'Packing', 'Packing accuracy',
      '≥ 99%',
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 4,
      'Workbook reference (unscored — no reliable review period recorded): score 6.5, status Needs Attention.'),
    (v_picking_packing_id, 'Packing', 'Boxes clearly labelled with SO, customer and contents',
      '100%',
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 5,
      'box_label_print_state records WHETHER a box label was printed, not whether the label was correct/complete — adjacent evidence, not a substitute for this KPI. Workbook reference (unscored — no reliable review period recorded): score 7, status Acceptable.'),
    (v_picking_packing_id, 'Packing', 'Large/project orders correctly split and identified',
      '100%',
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 6,
      'Workbook reference (unscored — no reliable review period recorded): score 7, status Acceptable.');

  -- ── Dispatch Performance section: Dispatch (3) ───────────────────────────

  insert into scorecard_metric_definitions
    (scorecard_section_id, category, name, target_text, evidence_source, scoring_method, metric_direction, display_order, source_note)
  values
    (v_dispatch_id, 'Dispatch', 'Orders dispatched on agreed Ship By date',
      '≥ 95%',
      'AUTOMATED', 'REVIEWER', 'HIGHER_IS_BETTER', 1,
      'Evidence (eligible/on-time/late orders, compliance %) is computed automatically; the score stays reviewer-entered in Phase 1 until an explicit % -> score mapping is approved. Workbook reference (unscored — no reliable review period recorded): score 6, status Needs Attention.'),
    (v_dispatch_id, 'Dispatch', 'Incorrect deliveries / missing boxes',
      '< 1%',
      'MANUAL', 'REVIEWER', 'LOWER_IS_BETTER', 2,
      'No delivery-incident data source found in synced Cin7/Toolbox data. Workbook reference (unscored — no reliable review period recorded): score 6.5, status Needs Attention.'),
    (v_dispatch_id, 'Dispatch', 'Proof of delivery captured correctly',
      '100%',
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 3,
      'No proof-of-delivery field found in mirrored data. Workbook reference (unscored — no reliable review period recorded): score 7, status Acceptable.');

  -- ── Stock Accuracy section: Stock Accuracy (4) ───────────────────────────

  insert into scorecard_metric_definitions
    (scorecard_section_id, category, name, target_text, evidence_source, scoring_method, metric_direction, display_order, source_note)
  values
    (v_stock_accuracy_id, 'Stock Accuracy', 'System stock matches physical stock',
      '≥ 98%',
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 1,
      'Stocktake Assistant''s variance history was not confirmed reliable enough to automate in Phase 1 — a Phase 2 investigation candidate. Workbook comment: "CYCLE COUNTS." Workbook reference (unscored — no reliable review period recorded): score 7, status Acceptable.'),
    (v_stock_accuracy_id, 'Stock Accuracy', 'Products stored in correct bin locations',
      '≥ 98%',
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 2,
      'Workbook reference (unscored — no reliable review period recorded): score 6.5, status Needs Attention.'),
    (v_stock_accuracy_id, 'Stock Accuracy', 'Bin labels clear and consistent',
      '100%',
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 3,
      'Workbook reference (unscored — no reliable review period recorded): score 6.5, status Needs Attention.'),
    (v_stock_accuracy_id, 'Stock Accuracy', 'Stock adjustments properly investigated',
      '100%',
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 4,
      'Workbook reference (unscored — no reliable review period recorded): score 7, status Acceptable.');

  -- ── Cin7 Process Compliance section: Cin7 Compliance (3) ─────────────────

  insert into scorecard_metric_definitions
    (scorecard_section_id, category, name, target_text, evidence_source, scoring_method, metric_direction, display_order, source_note)
  values
    (v_cin7_compliance_id, 'Cin7 Compliance', 'Pick, Pack and Ship stages used correctly',
      '≥ 95%',
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 1,
      'Phase 2 automation candidate: raw stage data (sale_pick_pack_lines.stage/.status) exists but "correct use" qualification rules are not yet built/tested. Workbook reference (unscored — no reliable review period recorded): score 5, status Needs Attention.'),
    (v_cin7_compliance_id, 'Cin7 Compliance', 'Manual emails/workarounds required',
      'As close to 0 as possible',
      'MANUAL', 'REVIEWER', 'LOWER_IS_BETTER', 2,
      'Inverse metric — lower is better, explicitly. No data trail of email/workaround usage exists to automate this. Workbook comment: "is ''0'' good or bad? Target column indicates lower = better?" — the workbook''s own question about this exact KPI, resolved as LOWER_IS_BETTER for this schema (zero is the desirable outcome) rather than silently dropped. Workbook reference (unscored — no reliable review period recorded): score 3, status Serious Weakness.'),
    (v_cin7_compliance_id, 'Cin7 Compliance', 'Ship By dates and order information reliable',
      '≥ 98%',
      'AUTOMATED', 'REVIEWER', 'HIGHER_IS_BETTER', 3,
      'Evidence = % of orders with a Ship By date populated (Ship By completeness), a Phase 1 automation priority. Workbook reference (unscored — no reliable review period recorded): score 7, status Acceptable.');

  -- ── Warehouse Organisation & People: Organisation (3) + People (3) + Safety (2) ──

  insert into scorecard_metric_definitions
    (scorecard_section_id, category, name, target_text, evidence_source, scoring_method, metric_direction, display_order, source_note)
  values
    (v_org_people_id, 'Organisation', 'Warehouse clean and products easy to locate',
      '≥ 90%',
      'MANUAL', 'REVIEWER', 'REVIEW_ONLY', 1,
      'Workbook reference (unscored — no reliable review period recorded): score 5, status Needs Attention.'),
    (v_org_people_id, 'Organisation', 'Aisle-Bay-Shelf system followed',
      '100%',
      'MANUAL', 'REVIEWER', 'REVIEW_ONLY', 2,
      'Workbook comment: "Bin aisles are labelled." Workbook reference (unscored — no reliable review period recorded): score 6, status Needs Attention.'),
    (v_org_people_id, 'Organisation', 'Damaged / returns / quarantine stock separated',
      '100%',
      'MANUAL', 'REVIEWER', 'REVIEW_ONLY', 3,
      'Workbook reference (unscored — no reliable review period recorded): score 6, status Needs Attention.'),

    (v_org_people_id, 'People', 'Staff understand the full warehouse workflow',
      '100%',
      'MANUAL', 'REVIEWER', 'REVIEW_ONLY', 4,
      'Workbook reference (unscored — no reliable review period recorded): score 7, status Acceptable.'),
    (v_org_people_id, 'People', 'Staff trained on Cin7',
      '100%',
      'MANUAL', 'REVIEWER', 'REVIEW_ONLY', 5,
      'Workbook comment: "on going - each function has working understanding of CIN7." Workbook reference (unscored — no reliable review period recorded): score 5, status Needs Attention.'),
    (v_org_people_id, 'People', 'Clear responsibility for picking, packing, receiving and dispatch',
      '100%',
      'MANUAL', 'REVIEWER', 'REVIEW_ONLY', 6,
      'Workbook reference (unscored — no reliable review period recorded): score 6, status Needs Attention.'),

    (v_org_people_id, 'Safety', 'Safety incidents',
      '0',
      'MANUAL', 'REVIEWER', 'LOWER_IS_BETTER', 7,
      'Inverse metric — lower is better. Confirmed directly by the workbook''s own scored example: target 0, score 9, status Strong — zero incidents is unambiguously the desirable outcome for THIS KPI (the workbook''s "is 0 good or bad" question belongs to Manual emails/workarounds above, not here). Workbook reference (unscored — no reliable review period recorded): score 9, status Strong.'),
    (v_org_people_id, 'Safety', 'Walkways and emergency areas clear',
      '100%',
      'MANUAL', 'REVIEWER', 'REVIEW_ONLY', 8,
      'Workbook reference (unscored — no reliable review period recorded): score 5, status Needs Attention.');
end $$;
