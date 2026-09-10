-- Parity regression suite for migration 0091 (Order Fulfillment server-side
-- queues, paging, filtering, sorting and search).
--
-- The whole point of 0091 is that a NEW, bounded query path returns exactly
-- what the OLD unbounded one did. That is not something to take on trust: the
-- first version of the queue gate silently dropped 5 of 69 box-label rows,
-- and the second matched 4,560 of 8,556 orders instead of 35. Both were found
-- by comparing against report_order_fulfillment rather than by reading the
-- SQL. So every assertion below compares NEW against OLD on the same data in
-- the same transaction, instead of restating what the new code does.
--
-- Self-contained and NON-DESTRUCTIVE: one transaction that ROLLS BACK.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0091_order_fulfillment_server_paging.test.sql
-- Expect: "ALL 0091 PARITY ASSERTIONS PASSED" and a ROLLBACK.

begin;

create or replace function pg_temp.assert(cond boolean, label text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception '0091 PARITY FAILED: %', label; end if;
end $$;

create or replace function pg_temp.assert_eq(a anyelement, b anyelement, label text) returns void language plpgsql as $$
begin
  if a is distinct from b then raise exception '0091 PARITY FAILED: % (% <> %)', label, a, b; end if;
end $$;

-- ---------------------------------------------------------------- fixture
-- Two orgs so isolation is provable; two instances so instance filtering is;
-- one instance floored so hidden-by-floor is exercised.
insert into organizations (id, name) values
  ('00000000-0000-0000-0000-000000000911', 'OF Paging Test Org'),
  ('00000000-0000-0000-0000-000000000919', 'OF Paging Other Org');

insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted, fulfilment_view_start_date) values
  ('00000000-0000-0000-0000-000000000912', '00000000-0000-0000-0000-000000000911', 'Main', 'acct-p1', 'enc-p1', null),
  ('00000000-0000-0000-0000-000000000913', '00000000-0000-0000-0000-000000000911', 'Floored', 'acct-p2', 'enc-p2', current_date - 10),
  ('00000000-0000-0000-0000-000000000918', '00000000-0000-0000-0000-000000000919', 'Other', 'acct-p9', 'enc-p9', null);

insert into sales (org_id, instance_id, cin7_sale_id, order_number, customer_name, ship_by, order_date,
                   combined_picking_status, combined_shipping_status, combined_payment_status, paid_amount, invoice_amount)
values
  -- pick queue: not picked, has pickable qty
  ('00000000-0000-0000-0000-000000000911','00000000-0000-0000-0000-000000000912','p-1','SO-1','Acme',      current_date + 1, current_date - 1, 'NOT PICKED','NOT SHIPPED','UNPAID',   0, 100),
  ('00000000-0000-0000-0000-000000000911','00000000-0000-0000-0000-000000000912','p-2','SO-2','Beta Ltd',  current_date + 2, current_date - 1, 'PARTIALLY PICKED','NOT SHIPPED','PAID', 50, 50),
  -- ship-only: fully picked, still shippable
  ('00000000-0000-0000-0000-000000000911','00000000-0000-0000-0000-000000000912','p-3','SO-3','Gamma',     current_date + 3, current_date - 1, 'PICKED','NOT SHIPPED','UNPAID',    0, 200),
  -- ready to invoice: authorised pack > invoiced
  ('00000000-0000-0000-0000-000000000911','00000000-0000-0000-0000-000000000912','p-4','SO-4','Delta',    current_date + 4, current_date - 1, 'PICKED','NOT SHIPPED','PAID',     10, 10),
  -- box label: authorised pack fully invoiced, still not shipped
  ('00000000-0000-0000-0000-000000000911','00000000-0000-0000-0000-000000000912','p-5','SO-5','Epsilon',  current_date + 5, current_date - 1, 'PICKED','NOT SHIPPED','PAID',     20, 20),
  -- excluded from every queue: shipped and fully picked
  ('00000000-0000-0000-0000-000000000911','00000000-0000-0000-0000-000000000912','p-6','SO-6','Zeta',     current_date + 6, current_date - 1, 'PICKED','SHIPPED','PAID',        30, 30),
  -- no ship_by at all: must appear in All Orders, never on a dated grid
  ('00000000-0000-0000-0000-000000000911','00000000-0000-0000-0000-000000000912','p-7','SO-7','Eta',      null,             current_date - 1, 'NOT PICKED','NOT SHIPPED','UNPAID', 0, 70),
  -- floored instance, old date: qualifies but hidden by floor
  ('00000000-0000-0000-0000-000000000911','00000000-0000-0000-0000-000000000913','p-8','SO-8','Theta',    current_date - 40, current_date - 41,'NOT PICKED','NOT SHIPPED','UNPAID', 0, 80),
  -- other org, would otherwise match everything
  ('00000000-0000-0000-0000-000000000919','00000000-0000-0000-0000-000000000918','x-1','XO-1','Acme',     current_date + 1, current_date - 1, 'NOT PICKED','NOT SHIPPED','UNPAID', 0, 999);

insert into sale_order_lines (org_id, instance_id, cin7_sale_id, line_number, product_sku, product_name, quantity, backorder_quantity)
values
  ('00000000-0000-0000-0000-000000000911','00000000-0000-0000-0000-000000000912','p-1',0,'SKU-ALPHA','Alpha Widget',10,0),
  ('00000000-0000-0000-0000-000000000911','00000000-0000-0000-0000-000000000912','p-2',0,'SKU-BETA', 'Beta Widget',  8,3),
  ('00000000-0000-0000-0000-000000000911','00000000-0000-0000-0000-000000000912','p-3',0,'SKU-GAMMA','Gamma Widget',  5,0),
  ('00000000-0000-0000-0000-000000000911','00000000-0000-0000-0000-000000000912','p-4',0,'SKU-DELTA','Delta Widget', 10,0),
  ('00000000-0000-0000-0000-000000000911','00000000-0000-0000-0000-000000000912','p-5',0,'SKU-EPS',  'Epsilon Widget',6,0),
  ('00000000-0000-0000-0000-000000000911','00000000-0000-0000-0000-000000000912','p-6',0,'SKU-ZETA', 'Zeta Widget',   4,0),
  ('00000000-0000-0000-0000-000000000911','00000000-0000-0000-0000-000000000912','p-7',0,'SKU-ETA',  'Eta Widget',    7,0),
  ('00000000-0000-0000-0000-000000000911','00000000-0000-0000-0000-000000000913','p-8',0,'SKU-THETA','Theta Widget',  9,0),
  ('00000000-0000-0000-0000-000000000919','00000000-0000-0000-0000-000000000918','x-1',0,'SKU-ALPHA','Alpha Widget', 99,0);

insert into sale_pick_pack_lines (org_id, instance_id, cin7_sale_id, stage, line_number, product_sku, quantity, status)
values
  ('00000000-0000-0000-0000-000000000911','00000000-0000-0000-0000-000000000912','p-3','pick',0,'SKU-GAMMA',5,'AUTHORISED'),
  ('00000000-0000-0000-0000-000000000911','00000000-0000-0000-0000-000000000912','p-4','pack',0,'SKU-DELTA',10,'AUTHORISED'),
  ('00000000-0000-0000-0000-000000000911','00000000-0000-0000-0000-000000000912','p-5','pack',0,'SKU-EPS',   6,'AUTHORISED'),
  ('00000000-0000-0000-0000-000000000911','00000000-0000-0000-0000-000000000912','p-6','pack',0,'SKU-ZETA',  4,'AUTHORISED');

insert into sale_lines (org_id, instance_id, cin7_sale_id, invoice_number, line_number, invoice_status, product_sku, quantity)
values
  -- p-4: 10 packed, 4 invoiced -> 6 awaiting invoice (ready to invoice)
  ('00000000-0000-0000-0000-000000000911','00000000-0000-0000-0000-000000000912','p-4','INV-4',0,'AUTHORISED','SKU-DELTA',4),
  -- p-5: 6 packed, 6 invoiced -> nothing awaiting, but ready FOR BOX LABEL
  ('00000000-0000-0000-0000-000000000911','00000000-0000-0000-0000-000000000912','p-5','INV-5',0,'AUTHORISED','SKU-EPS',6),
  ('00000000-0000-0000-0000-000000000911','00000000-0000-0000-0000-000000000912','p-6','INV-6',0,'AUTHORISED','SKU-ZETA',4);

-- ---------------------------------------------------------------- helpers
create or replace function pg_temp.org() returns uuid language sql immutable as
  $$ select '00000000-0000-0000-0000-000000000911'::uuid $$;

-- NEW: every row of a tab, page size deliberately huge so this is "the whole tab"
create or replace function pg_temp.new_tab(q text) returns setof jsonb language sql as $$
  select jsonb_array_elements(
    case when q = 'all'
      then (report_order_fulfillment_all_page_json(pg_temp.org(), null, null, null,
              null,null,null,null,null,null,null,null,null, 10000, 0) -> 'rows')::jsonb
      else (report_order_fulfillment_queue_page_json(pg_temp.org(), null, null, q,
              null,null,null,null,null,null,null,null,null, 10000, 0) -> 'rows')::jsonb
    end);
$$;

-- OLD: the unbounded function, filtered by the same tab predicate in SQL
create or replace function pg_temp.old_tab(q text) returns setof jsonb language sql as $$
  select to_jsonb(r) from report_order_fulfillment(pg_temp.org(), null, null) r
  where (q = 'all')
     or (q = 'pick' and r.is_pick_today)
     or (q = 'ship' and r.is_ship_today)
     or (q = 'invoice' and r.is_ready_to_invoice)
     or (q = 'box_label' and r.is_ready_for_box_label);
$$;

create or replace function pg_temp.hash_of(rows jsonb[]) returns text language sql immutable as $$
  select md5(coalesce(string_agg(md5(x::text), '' order by md5(x::text)), ''))
  from unnest(rows) x;
$$;

-- ------------------------------------------------- 1. row parity per tab
do $$
declare q text; old_h text; new_h text; old_n int; new_n int;
begin
  foreach q in array array['pick','ship','invoice','box_label','all'] loop
    select count(*), pg_temp.hash_of(array_agg(j)) into old_n, old_h from pg_temp.old_tab(q) j;
    select count(*), pg_temp.hash_of(array_agg(j)) into new_n, new_h from pg_temp.new_tab(q) j;
    perform pg_temp.assert_eq(new_n, old_n, format('tab %s row count', q));
    perform pg_temp.assert_eq(new_h, old_h, format('tab %s row content', q));
    perform pg_temp.assert(old_n > 0, format('fixture exercises tab %s', q));
  end loop;
end $$;

-- --------------------------------------------- 2. the nine counts, exact
do $$
declare c record; o record;
begin
  select * into c from report_order_fulfillment_tab_counts(pg_temp.org(), null, null);
  select count(*) all_c,
         count(*) filter (where is_pick_today) pick_c,
         count(*) filter (where is_ship_today) ship_c,
         count(*) filter (where is_ready_to_invoice) rti_c,
         count(*) filter (where is_ready_for_box_label) box_c,
         count(*) filter (where pick_today_hidden_by_floor) pf,
         count(*) filter (where ship_today_hidden_by_floor) sf,
         count(*) filter (where ready_to_invoice_hidden_by_floor) rf,
         count(*) filter (where box_label_hidden_by_floor) bf
    into o from report_order_fulfillment(pg_temp.org(), null, null);
  perform pg_temp.assert_eq(c.all_count, o.all_c, 'all_count');
  perform pg_temp.assert_eq(c.pick_count, o.pick_c, 'pick_count');
  perform pg_temp.assert_eq(c.ship_count, o.ship_c, 'ship_count');
  perform pg_temp.assert_eq(c.ready_to_invoice_count, o.rti_c, 'ready_to_invoice_count');
  perform pg_temp.assert_eq(c.box_label_count, o.box_c, 'box_label_count');
  perform pg_temp.assert_eq(c.pick_floor_count, o.pf, 'pick_floor_count');
  perform pg_temp.assert_eq(c.ship_floor_count, o.sf, 'ship_floor_count');
  perform pg_temp.assert_eq(c.ready_to_invoice_floor_count, o.rf, 'ready_to_invoice_floor_count');
  perform pg_temp.assert_eq(c.box_label_floor_count, o.bf, 'box_label_floor_count');
  -- the floored fixture row must actually be exercising this
  perform pg_temp.assert(o.pf > 0, 'fixture exercises hidden-by-floor');
end $$;

-- ------------------------------------------------------- 3. count is NOT
--    derived from the page: a page of 1 must not change any count
do $$
declare c1 record; c2 record; page_total int;
begin
  select * into c1 from report_order_fulfillment_tab_counts(pg_temp.org(), null, null);
  select (report_order_fulfillment_queue_page_json(pg_temp.org(), null, null, 'pick',
            null,null,null,null,null,null,null,null,null, 1, 0) ->> 'total_count')::int into page_total;
  select * into c2 from report_order_fulfillment_tab_counts(pg_temp.org(), null, null);
  perform pg_temp.assert_eq(c1.pick_count, c2.pick_count, 'counts stable across a page-of-1 fetch');
  perform pg_temp.assert_eq(page_total, c1.pick_count::int, 'total_count equals the tab count when unfiltered');
end $$;

-- ------------------------------------------- 4. paging boundary stability
do $$
declare total int; seen jsonb[]; pg_rows jsonb[]; off int := 0; distinct_ids int;
begin
  select (report_order_fulfillment_all_page_json(pg_temp.org(), null, null, null,
            null,null,null,null,null,null,null,null,null, 2, 0) ->> 'total_count')::int into total;
  perform pg_temp.assert(total >= 5, 'fixture large enough to page');
  seen := array[]::jsonb[];
  while off < total loop
    select array_agg(x) into pg_rows from jsonb_array_elements(
      (report_order_fulfillment_all_page_json(pg_temp.org(), null, null, null,
         null,null,null,null,null,null,null,null,null, 2, off) -> 'rows')::jsonb) x;
    seen := seen || coalesce(pg_rows, array[]::jsonb[]);
    off := off + 2;
  end loop;
  perform pg_temp.assert_eq(cardinality(seen), total, 'pages together return every row exactly once');
  select count(distinct x->>'cin7_sale_id') into distinct_ids from unnest(seen) x;
  perform pg_temp.assert_eq(distinct_ids, total, 'no row repeats or is skipped across page boundaries');
  -- and the union of pages equals the single-page whole
  perform pg_temp.assert_eq(
    pg_temp.hash_of(seen),
    (select pg_temp.hash_of(array_agg(j)) from pg_temp.new_tab('all') j),
    'paged union identical to the unpaged tab');
end $$;

-- ---------------------------------------------------- 5. page size honoured
do $$
declare n int;
begin
  select json_array_length(report_order_fulfillment_all_page_json(pg_temp.org(), null, null, null,
    null,null,null,null,null,null,null,null,null, 3, 0) -> 'rows') into n;
  perform pg_temp.assert_eq(n, 3, 'limit honoured');
  select json_array_length(report_order_fulfillment_all_page_json(pg_temp.org(), null, null, null,
    null,null,null,null,null,null,null,null,null, 3, 9999) -> 'rows') into n;
  perform pg_temp.assert_eq(n, 0, 'offset past the end returns an empty page, not an error');
end $$;

-- ------------------------------------------------------------ 6. search
-- Substring, case-insensitive, across order number / customer / SKU /
-- product name — matchesSearch's contract. The SKU and product-name halves
-- prove the EXISTS against sale_order_lines works, which is the half the
-- browser used to do from its own copy of every line.
do $$
declare got_ids text[];
begin
  create temp table s_res(label text, ids text[]) on commit drop;

  insert into s_res select 'order number', array_agg(j->>'cin7_sale_id' order by j->>'cin7_sale_id')
    from jsonb_array_elements((report_order_fulfillment_all_page_json(pg_temp.org(), null, null, null,
      'SO-3',null,null,null,null,null,null,null,null,1000,0) -> 'rows')::jsonb) j;
  insert into s_res select 'customer (case-insensitive)', array_agg(j->>'cin7_sale_id' order by j->>'cin7_sale_id')
    from jsonb_array_elements((report_order_fulfillment_all_page_json(pg_temp.org(), null, null, null,
      'beta ltd',null,null,null,null,null,null,null,null,1000,0) -> 'rows')::jsonb) j;
  insert into s_res select 'sku', array_agg(j->>'cin7_sale_id' order by j->>'cin7_sale_id')
    from jsonb_array_elements((report_order_fulfillment_all_page_json(pg_temp.org(), null, null, null,
      'SKU-DELTA',null,null,null,null,null,null,null,null,1000,0) -> 'rows')::jsonb) j;
  insert into s_res select 'product name substring', array_agg(j->>'cin7_sale_id' order by j->>'cin7_sale_id')
    from jsonb_array_elements((report_order_fulfillment_all_page_json(pg_temp.org(), null, null, null,
      'psilon',null,null,null,null,null,null,null,null,1000,0) -> 'rows')::jsonb) j;
  insert into s_res select 'whitespace only = no filter', array_agg(j->>'cin7_sale_id' order by j->>'cin7_sale_id')
    from jsonb_array_elements((report_order_fulfillment_all_page_json(pg_temp.org(), null, null, null,
      '   ',null,null,null,null,null,null,null,null,1000,0) -> 'rows')::jsonb) j;
  insert into s_res select 'percent is literal, not a wildcard', coalesce(array_agg(j->>'cin7_sale_id'), array[]::text[])
    from jsonb_array_elements((report_order_fulfillment_all_page_json(pg_temp.org(), null, null, null,
      '%',null,null,null,null,null,null,null,null,1000,0) -> 'rows')::jsonb) j;

  select r.ids into got_ids from s_res r where r.label='order number';
  perform pg_temp.assert_eq(got_ids, array['p-3'], 'search by order number');
  select r.ids into got_ids from s_res r where r.label='customer (case-insensitive)';
  perform pg_temp.assert_eq(got_ids, array['p-2'], 'search by customer, case-insensitively');
  select r.ids into got_ids from s_res r where r.label='sku';
  perform pg_temp.assert_eq(got_ids, array['p-4'], 'search by line SKU');
  select r.ids into got_ids from s_res r where r.label='product name substring';
  perform pg_temp.assert_eq(got_ids, array['p-5'], 'search by line product name, mid-word');
  select r.ids into got_ids from s_res r where r.label='whitespace only = no filter';
  perform pg_temp.assert_eq(cardinality(got_ids), (select count(*)::int from pg_temp.old_tab('all')), 'blank search matches everything');
  select r.ids into got_ids from s_res r where r.label='percent is literal, not a wildcard';
  perform pg_temp.assert_eq(cardinality(got_ids), 0, 'a bare % matches nothing (not ILIKE)');
end $$;

-- ------------------------------------------------------------ 7. filters
-- Each filter is compared against the SAME predicate applied to the old
-- unbounded rows, so a filter that drifts is caught rather than merely run.
do $$
declare new_ids text[]; old_ids text[];
begin
  -- payment
  select array_agg(j->>'cin7_sale_id' order by j->>'cin7_sale_id') into new_ids
    from jsonb_array_elements((report_order_fulfillment_all_page_json(pg_temp.org(), null, null, null,
      null,'PAID',null,null,null,null,null,null,null,1000,0) -> 'rows')::jsonb) j;
  select array_agg(r.cin7_sale_id order by r.cin7_sale_id) into old_ids
    from report_order_fulfillment(pg_temp.org(), null, null) r where r.combined_payment_status = 'PAID';
  perform pg_temp.assert_eq(new_ids, old_ids, 'payment filter parity');

  -- ship_by window (excludes null ship_by, as the client did)
  select array_agg(j->>'cin7_sale_id' order by j->>'cin7_sale_id') into new_ids
    from jsonb_array_elements((report_order_fulfillment_all_page_json(pg_temp.org(), null, null, null,
      null,null,current_date + 2,current_date + 4,null,null,null,null,null,1000,0) -> 'rows')::jsonb) j;
  select array_agg(r.cin7_sale_id order by r.cin7_sale_id) into old_ids
    from report_order_fulfillment(pg_temp.org(), null, null) r
    where r.ship_by is not null and r.ship_by >= current_date + 2 and r.ship_by <= current_date + 4;
  perform pg_temp.assert_eq(new_ids, old_ids, 'ship_by from/to filter parity (nulls excluded)');

  -- backorder
  select array_agg(j->>'cin7_sale_id' order by j->>'cin7_sale_id') into new_ids
    from jsonb_array_elements((report_order_fulfillment_all_page_json(pg_temp.org(), null, null, null,
      null,null,null,null,'backorder',null,null,null,null,1000,0) -> 'rows')::jsonb) j;
  select array_agg(r.cin7_sale_id order by r.cin7_sale_id) into old_ids
    from report_order_fulfillment(pg_temp.org(), null, null) r where r.total_backorder_qty > 0;
  perform pg_temp.assert_eq(new_ids, old_ids, 'backorder filter parity');

  select array_agg(j->>'cin7_sale_id' order by j->>'cin7_sale_id') into new_ids
    from jsonb_array_elements((report_order_fulfillment_all_page_json(pg_temp.org(), null, null, null,
      null,null,null,null,'fulfillable',null,null,null,null,1000,0) -> 'rows')::jsonb) j;
  select array_agg(r.cin7_sale_id order by r.cin7_sale_id) into old_ids
    from report_order_fulfillment(pg_temp.org(), null, null) r where r.total_backorder_qty = 0;
  perform pg_temp.assert_eq(new_ids, old_ids, 'fulfillable filter parity');

  -- backorder PO linkage
  select array_agg(j->>'cin7_sale_id' order by j->>'cin7_sale_id') into new_ids
    from jsonb_array_elements((report_order_fulfillment_all_page_json(pg_temp.org(), null, null, null,
      null,null,null,null,null,'no_po',null,null,null,1000,0) -> 'rows')::jsonb) j;
  select array_agg(r.cin7_sale_id order by r.cin7_sale_id) into old_ids
    from report_order_fulfillment(pg_temp.org(), null, null) r where r.has_backorder_no_po;
  perform pg_temp.assert_eq(new_ids, old_ids, 'backorder-PO filter parity');

  -- invoice coverage
  select array_agg(j->>'cin7_sale_id' order by j->>'cin7_sale_id') into new_ids
    from jsonb_array_elements((report_order_fulfillment_all_page_json(pg_temp.org(), null, null, null,
      null,null,null,null,null,null,'partially_invoiced',null,null,1000,0) -> 'rows')::jsonb) j;
  select array_agg(r.cin7_sale_id order by r.cin7_sale_id) into old_ids
    from report_order_fulfillment(pg_temp.org(), null, null) r where r.invoice_coverage_status = 'partially_invoiced';
  perform pg_temp.assert_eq(new_ids, old_ids, 'invoice coverage filter parity');

  -- filters compose, and they apply BEFORE the page slice
  select array_agg(j->>'cin7_sale_id' order by j->>'cin7_sale_id') into new_ids
    from jsonb_array_elements((report_order_fulfillment_all_page_json(pg_temp.org(), null, null, null,
      null,'PAID',null,null,'fulfillable',null,null,null,null,1000,0) -> 'rows')::jsonb) j;
  select array_agg(r.cin7_sale_id order by r.cin7_sale_id) into old_ids
    from report_order_fulfillment(pg_temp.org(), null, null) r
    where r.combined_payment_status = 'PAID' and r.total_backorder_qty = 0;
  perform pg_temp.assert_eq(new_ids, old_ids, 'composed filters parity');
end $$;

-- ------------------------------------------------------------- 8. sorting
-- NULLS LAST in BOTH directions (compareNullable's contract, which is NOT
-- Postgres's default for desc), and the priority-queue tiebreak.
do $$
declare got text[]; want text[];
begin
  select array_agg(j->>'cin7_sale_id') into got
    from jsonb_array_elements((report_order_fulfillment_all_page_json(pg_temp.org(), null, null, null,
      null,null,null,null,null,null,null,'shipBy','asc',1000,0) -> 'rows')::jsonb) j;
  select array_agg(r.cin7_sale_id order by (r.ship_by is null), r.ship_by asc, r.cin7_sale_id) into want
    from report_order_fulfillment(pg_temp.org(), null, null) r;
  perform pg_temp.assert_eq(got, want, 'sort shipBy asc, nulls last');

  select array_agg(j->>'cin7_sale_id') into got
    from jsonb_array_elements((report_order_fulfillment_all_page_json(pg_temp.org(), null, null, null,
      null,null,null,null,null,null,null,'shipBy','desc',1000,0) -> 'rows')::jsonb) j;
  -- Nulls FIRST on desc: the page negated compareNullable's result wholesale,
  -- so this is the behaviour the table had, not what compareNullable's own
  -- docstring describes. See 0091's SORT PARITY note.
  perform pg_temp.assert((got)[1] = 'p-7', 'sort shipBy DESC puts the undated row FIRST (negated comparator)');

  select array_agg(j->>'cin7_sale_id') into got
    from jsonb_array_elements((report_order_fulfillment_all_page_json(pg_temp.org(), null, null, null,
      null,null,null,null,null,null,null,'paidInvoice','desc',1000,0) -> 'rows')::jsonb) j;
  select array_agg(r.cin7_sale_id order by r.paid_amount desc nulls first, (r.ship_by is null), r.ship_by, r.cin7_sale_id) into want
    from report_order_fulfillment(pg_temp.org(), null, null) r;
  perform pg_temp.assert_eq(got, want, 'numeric sort desc, nulls last, priority-queue tiebreak');

  -- a sort must not change WHICH rows come back, only their order
  select array_agg(j->>'cin7_sale_id' order by j->>'cin7_sale_id') into got
    from jsonb_array_elements((report_order_fulfillment_all_page_json(pg_temp.org(), null, null, null,
      null,null,null,null,null,null,null,'payment','desc',1000,0) -> 'rows')::jsonb) j;
  select array_agg(r.cin7_sale_id order by r.cin7_sale_id) into want
    from report_order_fulfillment(pg_temp.org(), null, null) r;
  perform pg_temp.assert_eq(got, want, 'sorting does not add or drop rows');
end $$;

-- ------------------------------- 9. lines: expanded row / pick list / label
do $$
declare one int; many int; full_scan int;
begin
  select count(*) into one from report_order_fulfillment_lines_fs(pg_temp.org(), null, array['p-4']);
  select count(*) into full_scan from report_order_fulfillment_lines(pg_temp.org(), null, null) l
    where l.cin7_sale_id = 'p-4';
  perform pg_temp.assert_eq(one, full_scan, 'single-sale line fetch matches the full scan filtered (markBoxLabelPrinted path)');
  perform pg_temp.assert(one > 0, 'fixture has lines for p-4');

  -- and the VALUES match, not just the count
  perform pg_temp.assert_eq(
    (select md5(string_agg(md5(to_jsonb(l)::text), '' order by md5(to_jsonb(l)::text)))
       from report_order_fulfillment_lines_fs(pg_temp.org(), null, array['p-4']) l),
    (select md5(string_agg(md5(to_jsonb(l)::text), '' order by md5(to_jsonb(l)::text)))
       from report_order_fulfillment_lines(pg_temp.org(), null, null) l where l.cin7_sale_id = 'p-4'),
    'single-sale line CONTENT matches the full scan filtered');

  -- batch pick list: several explicit ids, nothing else
  select count(*) into many from report_order_fulfillment_lines_fs(pg_temp.org(), null, array['p-1','p-2','p-3']);
  perform pg_temp.assert_eq(many,
    (select count(*)::int from report_order_fulfillment_lines(pg_temp.org(), null, null) l
      where l.cin7_sale_id in ('p-1','p-2','p-3')),
    'multi-sale line fetch matches (batch pick list path)');

  -- an empty id list returns nothing rather than everything
  perform pg_temp.assert_eq(
    (select count(*)::int from report_order_fulfillment_lines_fs(pg_temp.org(), null, array[]::text[])),
    0, 'empty id list returns no lines (never the whole org)');
end $$;

-- ------------------------------------------------------ 10. org isolation
do $$
declare leaked int;
begin
  select count(*) into leaked from jsonb_array_elements(
    (report_order_fulfillment_all_page_json(pg_temp.org(), null, null, null,
      null,null,null,null,null,null,null,null,null,1000,0) -> 'rows')::jsonb) j
   where j->>'cin7_sale_id' like 'x-%';
  perform pg_temp.assert_eq(leaked, 0, 'All Orders leaks no other org rows');

  select count(*) into leaked from jsonb_array_elements(
    (report_order_fulfillment_queue_page_json(pg_temp.org(), null, null, 'pick',
      null,null,null,null,null,null,null,null,null,1000,0) -> 'rows')::jsonb) j
   where j->>'cin7_sale_id' like 'x-%';
  perform pg_temp.assert_eq(leaked, 0, 'queue tab leaks no other org rows');

  perform pg_temp.assert_eq(
    (select count(*)::int from report_order_fulfillment_lines_fs(pg_temp.org(), null, array['x-1'])),
    0, 'another org''s sale id returns no lines even when named explicitly');

  perform pg_temp.assert_eq(
    (select count(*)::int from unnest(report_order_fulfillment_queue_candidates(pg_temp.org(), null, null)) c
      where c like 'x-%'),
    0, 'candidate list contains no other org rows');
end $$;

-- ------------------------------------------------ 11. instance filtering
do $$
declare only_main int; floored_seen int;
begin
  select count(*) into only_main from jsonb_array_elements(
    (report_order_fulfillment_all_page_json(pg_temp.org(),
      array['00000000-0000-0000-0000-000000000912'::uuid], null, null,
      null,null,null,null,null,null,null,null,null,1000,0) -> 'rows')::jsonb) j;
  perform pg_temp.assert_eq(only_main,
    (select count(*)::int from report_order_fulfillment(pg_temp.org(),
       array['00000000-0000-0000-0000-000000000912'::uuid], null)),
    'instance filter parity on All Orders');

  select count(*) into floored_seen from jsonb_array_elements(
    (report_order_fulfillment_all_page_json(pg_temp.org(),
      array['00000000-0000-0000-0000-000000000912'::uuid], null, null,
      null,null,null,null,null,null,null,null,null,1000,0) -> 'rows')::jsonb) j
   where j->>'cin7_sale_id' = 'p-8';
  perform pg_temp.assert_eq(floored_seen, 0, 'instance filter excludes the other instance''s orders');
end $$;

-- ------------------------------- 12. the default queue fetch stays bounded
-- The regression this whole migration exists to prevent: the default tab
-- must never hydrate the whole set. The candidate list is what bounds it.
do $$
declare cand int; total int;
begin
  select cardinality(report_order_fulfillment_queue_candidates(pg_temp.org(), null, null)) into cand;
  select count(*) into total from report_order_fulfillment(pg_temp.org(), null, null);
  perform pg_temp.assert(cand < total, 'queue candidates are a strict subset of all orders');
  -- and it is a SUPERSET of every queue: nothing a tab shows may be missing
  perform pg_temp.assert_eq(
    (select count(*)::int from report_order_fulfillment(pg_temp.org(), null, null) r
      where (r.is_pick_today or r.is_ship_today or r.is_ready_to_invoice or r.is_ready_for_box_label
             or r.pick_today_hidden_by_floor or r.ship_today_hidden_by_floor
             or r.ready_to_invoice_hidden_by_floor or r.box_label_hidden_by_floor)
        and not (r.cin7_sale_id = any (report_order_fulfillment_queue_candidates(pg_temp.org(), null, null)))),
    0, 'no queue or floor row falls outside the candidate list');
end $$;

select '0091: ALL 0091 PARITY ASSERTIONS PASSED' as result;

rollback;
