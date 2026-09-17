-- Seeds the "Lights by Linea — Warehouse Performance" scorecard_definition:
-- six weighted headline sections and all 33 KPI definitions from the
-- Warehouse Review Scorecard brief.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO:
--   - It does not assign this scorecard to any organisation
--     (organization_scorecards) — see 0092's own comment: no LBL org id is
--     known to this repository, and none is guessed here.
--   - It does not enable the module for any org beyond the off-by-default
--     seed in 0094.
--   - It does not create a scorecard_reviews row or any
--     scorecard_metric_results — no "current" score is seeded for any KPI.
--     The source Excel workbook was not available to the session that wrote
--     this migration (its attachment reached a different tool, not this
--     one) — targets and scores that were explicitly supplied in the build
--     brief are seeded below; nothing else is invented. Every KPI whose
--     exact numeric target could not be reliably tied to that specific KPI
--     (as opposed to a target given only for a whole category, e.g.
--     Picking's "≥99% / 100%" without saying which of its 3 KPIs each
--     belongs to) is seeded with target_text = null and a source_note
--     flagging the ambiguity for reconciliation against the real workbook.
--   - scoring_method is 'REVIEWER' for every single KPI, with no
--     scoring_config anywhere in this seed. Per the brief's own governing
--     rule: measuring an actual/evidence automatically is a SEPARATE
--     question from having an approved percentage-to-score mapping, and no
--     such mapping has been approved for any of these 33 KPIs yet — not
--     even Ship By compliance, the brief's own worked example. Converting
--     any of these to scoring_method = 'RULE' is a future, explicit,
--     human-approved change, not something to infer here.

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
    'Monthly warehouse operations review: order flow, picking/packing accuracy, stock accuracy, dispatch performance, Cin7 process compliance, and warehouse organisation & people — replacing the client''s Excel Warehouse Review Scorecard.',
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
      'Less than 1 working day',
      'AUTOMATED', 'REVIEWER', 'LOWER_IS_BETTER', 1,
      'Target taken from the Ready to Pick bottleneck queue''s own stated target (same underlying qualification). The workbook''s "Same day / agreed SLA" phrasing may apply specifically to this KPI rather than "1 working day" — not resolved without the physical workbook; flagged for reconciliation.'),
    (v_order_flow_id, 'Order Flow', 'Packed orders waiting for invoicing',
      'Less than 1 working day',
      'AUTOMATED', 'REVIEWER', 'LOWER_IS_BETTER', 2,
      'Target taken from the Packed but Not Invoiced bottleneck queue''s own stated target.'),
    (v_order_flow_id, 'Order Flow', 'Invoiced orders waiting for dispatch',
      'Less than 1 working day',
      'AUTOMATED', 'REVIEWER', 'LOWER_IS_BETTER', 3,
      'Target taken from the Invoiced but Not Shipped bottleneck queue''s own stated target.'),

    (v_order_flow_id, 'Backorders', 'Backorders identified correctly',
      null,
      'AUTOMATED', 'REVIEWER', 'REVIEW_ONLY', 4,
      'Evidence = current backorder count/list from the Backorders Awaiting Stock queue. Whether they are "identified correctly" is a reviewer judgment the queue count alone cannot answer.'),
    (v_order_flow_id, 'Backorders', 'Procurement notified through Cin7/system process',
      null,
      'MANUAL', 'REVIEWER', 'REVIEW_ONLY', 5,
      'Source workbook note: "No notification but bulk orders done."'),
    (v_order_flow_id, 'Backorders', 'Old backorders reviewed regularly',
      'Weekly review',
      'AUTOMATED', 'REVIEWER', 'REVIEW_ONLY', 6,
      'Evidence = oldest backorder age from the Backorders Awaiting Stock queue. Source workbook note: "Kaylin checks open POs and updates ETA."'),

    (v_order_flow_id, 'Receiving', 'Supplier deliveries received into Cin7 promptly',
      'Same day',
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 7,
      'Phase 2 automation candidate (purchase receipt timestamps exist in synced data but receipt-promptness qualification is not built/tested — see brief Phase 2 priority list). Source workbook note, preserved verbatim rather than converted into a rule: "current operating practice may allow an afternoon receipt to be completed the following morning" — a review/configuration question, not a new SLA.'),
    (v_order_flow_id, 'Receiving', 'Quantity and product checked before receipt',
      null,
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 8,
      null),
    (v_order_flow_id, 'Receiving', 'Backordered sales orders returned into fulfilment correctly',
      null,
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 9,
      'Backorder-to-PO linkage data exists (backorder_po_number/backorder_eta) as adjacent evidence a reviewer can consult, but does not itself establish correctness of the return-to-fulfilment step.');

  -- ── Picking & Packing Accuracy section: Picking (3) + Packing (3) ────────

  insert into scorecard_metric_definitions
    (scorecard_section_id, category, name, target_text, evidence_source, scoring_method, metric_direction, display_order, source_note)
  values
    (v_picking_packing_id, 'Picking', 'Picking accuracy',
      null,
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 1,
      'Workbook gives ≥99% and 100% as targets somewhere across Picking''s 3 KPIs; exact per-KPI assignment not established without the physical workbook.'),
    (v_picking_packing_id, 'Picking', 'Correct SKU, colour, quantity and project picked',
      null,
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 2,
      'Workbook gives ≥99% and 100% as targets somewhere across Picking''s 3 KPIs; exact per-KPI assignment not established without the physical workbook.'),
    (v_picking_packing_id, 'Picking', 'Pickers working from Cin7 rather than emails/manual lists',
      null,
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 3,
      'Workbook gives ≥99% and 100% as targets somewhere across Picking''s 3 KPIs; exact per-KPI assignment not established without the physical workbook.'),

    (v_picking_packing_id, 'Packing', 'Packing accuracy',
      null,
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 4,
      null),
    (v_picking_packing_id, 'Packing', 'Boxes clearly labelled with SO, customer and contents',
      null,
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 5,
      'box_label_print_state records WHETHER a box label was printed, not whether the label was correct/complete — adjacent evidence, not a substitute for this KPI.'),
    (v_picking_packing_id, 'Packing', 'Large/project orders correctly split and identified',
      null,
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 6,
      null);

  -- ── Dispatch Performance section: Dispatch (3) ───────────────────────────

  insert into scorecard_metric_definitions
    (scorecard_section_id, category, name, target_text, evidence_source, scoring_method, metric_direction, display_order, source_note)
  values
    (v_dispatch_id, 'Dispatch', 'Orders dispatched on agreed Ship By date',
      '≥95%',
      'AUTOMATED', 'REVIEWER', 'HIGHER_IS_BETTER', 1,
      'The brief''s own worked example: evidence (eligible/on-time/late orders, compliance %) is computed automatically; the score stays reviewer-entered in Phase 1 until an explicit % -> score mapping is approved.'),
    (v_dispatch_id, 'Dispatch', 'Incorrect deliveries / missing boxes',
      '<1%',
      'MANUAL', 'REVIEWER', 'LOWER_IS_BETTER', 2,
      'No delivery-incident data source found in synced Cin7/Toolbox data.'),
    (v_dispatch_id, 'Dispatch', 'Proof of delivery captured correctly',
      null,
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 3,
      'No proof-of-delivery field found in mirrored data.');

  -- ── Stock Accuracy section: Stock Accuracy (4) ───────────────────────────

  insert into scorecard_metric_definitions
    (scorecard_section_id, category, name, target_text, evidence_source, scoring_method, metric_direction, display_order, source_note)
  values
    (v_stock_accuracy_id, 'Stock Accuracy', 'System stock matches physical stock',
      '≥98%',
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 1,
      'Stocktake Assistant''s variance history was not confirmed reliable enough to automate in Phase 1 — a Phase 2 investigation candidate, not built here.'),
    (v_stock_accuracy_id, 'Stock Accuracy', 'Products stored in correct bin locations',
      null,
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 2,
      null),
    (v_stock_accuracy_id, 'Stock Accuracy', 'Bin labels clear and consistent',
      null,
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 3,
      'Source workbook note: "Bin aisles are labelled" — association with this specific KPI is plausible, not certain.'),
    (v_stock_accuracy_id, 'Stock Accuracy', 'Stock adjustments properly investigated',
      null,
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 4,
      'Source workbook note: "Cycle counts" — association with this specific KPI is plausible, not certain.');

  -- ── Cin7 Process Compliance section: Cin7 Compliance (3) ─────────────────

  insert into scorecard_metric_definitions
    (scorecard_section_id, category, name, target_text, evidence_source, scoring_method, metric_direction, display_order, source_note)
  values
    (v_cin7_compliance_id, 'Cin7 Compliance', 'Pick, Pack and Ship stages used correctly',
      null,
      'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 1,
      'Phase 2 automation candidate: raw stage data (sale_pick_pack_lines.stage/.status) exists but "correct use" qualification rules are not yet built/tested — claiming a compliance metric before that is explicitly against the brief''s own instruction. Source workbook notes: "there is a requirement for reporting the number of authorised orders per day"; "Anton - reporting".'),
    (v_cin7_compliance_id, 'Cin7 Compliance', 'Manual emails/workarounds required',
      'As close to 0 as possible',
      'MANUAL', 'REVIEWER', 'LOWER_IS_BETTER', 2,
      'Inverse metric — lower is better, explicitly. No data trail of email/workaround usage exists to automate this. Source workbook note: "Cin7 is used as the base together with checking relevant email correspondence."'),
    (v_cin7_compliance_id, 'Cin7 Compliance', 'Ship By dates and order information reliable',
      null,
      'AUTOMATED', 'REVIEWER', 'HIGHER_IS_BETTER', 3,
      'Evidence = % of orders with a Ship By date populated (Ship By completeness), a Phase 1 automation priority. Source workbook notes: "Ship By dates need to be added and an alternative process is needed so no DN gets ''lost''"; a question about whether this "relates to Pat authorising" (association uncertain).');

  -- ── Warehouse Organisation & People: Organisation (3) + People (3) + Safety (2) ──

  insert into scorecard_metric_definitions
    (scorecard_section_id, category, name, target_text, evidence_source, scoring_method, metric_direction, display_order, source_note)
  values
    (v_org_people_id, 'Organisation', 'Warehouse clean and products easy to locate',
      null,
      'MANUAL', 'REVIEWER', 'REVIEW_ONLY', 1,
      null),
    (v_org_people_id, 'Organisation', 'Aisle-Bay-Shelf system followed',
      null,
      'MANUAL', 'REVIEWER', 'REVIEW_ONLY', 2,
      null),
    (v_org_people_id, 'Organisation', 'Damaged / returns / quarantine stock separated',
      null,
      'MANUAL', 'REVIEWER', 'REVIEW_ONLY', 3,
      null),

    (v_org_people_id, 'People', 'Staff understand the full warehouse workflow',
      null,
      'MANUAL', 'REVIEWER', 'REVIEW_ONLY', 4,
      null),
    (v_org_people_id, 'People', 'Staff trained on Cin7',
      null,
      'MANUAL', 'REVIEWER', 'REVIEW_ONLY', 5,
      'Source workbook note: "Staff understanding of Cin7 is ongoing across functions."'),
    (v_org_people_id, 'People', 'Clear responsibility for picking, packing, receiving and dispatch',
      null,
      'MANUAL', 'REVIEWER', 'REVIEW_ONLY', 6,
      null),

    (v_org_people_id, 'Safety', 'Safety incidents',
      null,
      'MANUAL', 'REVIEWER', 'LOWER_IS_BETTER', 7,
      'Inverse metric — lower is better, explicitly (zero incidents is good). The source workbook itself asks whether zero is good or bad for a lower-is-better target; preserved here as the workbook''s own question, resolved as LOWER_IS_BETTER for this schema rather than silently dropped.'),
    (v_org_people_id, 'Safety', 'Walkways and emergency areas clear',
      null,
      'MANUAL', 'REVIEWER', 'REVIEW_ONLY', 8,
      null);
end $$;
