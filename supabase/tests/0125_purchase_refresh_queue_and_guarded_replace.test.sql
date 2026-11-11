-- Tests for migration 0125: purchase_refresh_queue + replace_purchase_detail_guarded.
-- BEGIN/ROLLBACK, leaves no rows. Prints "ALL 0125 ... PASSED".

begin;

insert into organizations (id, name) values
  ('00000000-0000-0000-0000-0000000125a1', 'Refresh Org A'),
  ('00000000-0000-0000-0000-0000000125a2', 'Refresh Org B');
insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted) values
  ('00000000-0000-0000-0000-0000000125b1', '00000000-0000-0000-0000-0000000125a1', 'Inst A', 'acct', 'enc'),
  ('00000000-0000-0000-0000-0000000125b2', '00000000-0000-0000-0000-0000000125a2', 'Inst B', 'acct', 'enc');

-- Org A / Inst A fixtures. updated_at and detail_synced_at are set explicitly.
insert into purchases (org_id, instance_id, cin7_purchase_id, order_number, status, combined_receiving_status, order_date, source, detail_synced_at, updated_at) values
  -- tier 0
  ('00000000-0000-0000-0000-0000000125a1','00000000-0000-0000-0000-0000000125b1','p-unsynced','PO-U','ORDERED','NOT RECEIVED','2026-11-01','purchase', null, now()),
  -- tier 1 (open): relisted partial, relisted not-received, ttl-expired not-received, ttl-expired partial
  ('00000000-0000-0000-0000-0000000125a1','00000000-0000-0000-0000-0000000125b1','p-open-partial-relisted','PO-OPR','RECEIVING','PARTIALLY RECEIVED','2026-10-01','advanced-purchase', now() - interval '10 days', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000125a1','00000000-0000-0000-0000-0000000125b1','p-open-none-relisted','PO-ONR','ORDERED','NOT RECEIVED','2026-10-15','purchase', now() - interval '5 days', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000125a1','00000000-0000-0000-0000-0000000125b1','p-open-partial-ttl','PO-OPT','RECEIVING','PARTIALLY RECEIVED','2026-09-01','purchase', now() - interval '40 hours', now() - interval '40 hours'),
  ('00000000-0000-0000-0000-0000000125a1','00000000-0000-0000-0000-0000000125b1','p-open-none-ttl','PO-ONT','ORDERED','NOT RECEIVED','2026-09-02','purchase', now() - interval '30 hours', now() - interval '30 hours'),
  -- tier 2 (closed, relisted): newer order date must come first
  ('00000000-0000-0000-0000-0000000125a1','00000000-0000-0000-0000-0000000125b1','p-closed-new','PO-CN','COMPLETED','FULLY RECEIVED','2026-08-01','purchase', now() - interval '60 days', now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000125a1','00000000-0000-0000-0000-0000000125b1','p-closed-old','PO-CO','COMPLETED','FULLY RECEIVED','2025-01-01','purchase', now() - interval '60 days', now() - interval '2 days'),
  -- excluded: fresh open (verified 1h ago), fresh closed, voided relisted, closed old but not relisted
  ('00000000-0000-0000-0000-0000000125a1','00000000-0000-0000-0000-0000000125b1','p-fresh-open','PO-FO','ORDERED','NOT RECEIVED','2026-11-02','purchase', now() - interval '1 hour', now() - interval '1 hour'),
  ('00000000-0000-0000-0000-0000000125a1','00000000-0000-0000-0000-0000000125b1','p-fresh-closed','PO-FC','COMPLETED','FULLY RECEIVED','2026-07-01','purchase', now() - interval '90 days', now() - interval '90 days'),
  ('00000000-0000-0000-0000-0000000125a1','00000000-0000-0000-0000-0000000125b1','p-voided','PO-V','VOIDED','NOT RECEIVED','2026-07-02','purchase', now() - interval '20 days', now() - interval '1 day');
-- Org B / Inst B: same cin7 ids as some of A's rows, must never leak across tenants.
insert into purchases (org_id, instance_id, cin7_purchase_id, order_number, status, combined_receiving_status, order_date, source, detail_synced_at, updated_at) values
  ('00000000-0000-0000-0000-0000000125a2','00000000-0000-0000-0000-0000000125b2','p-unsynced','PO-U-B','ORDERED','NOT RECEIVED','2026-11-01','purchase', null, now()),
  ('00000000-0000-0000-0000-0000000125a2','00000000-0000-0000-0000-0000000125b2','p-closed-new','PO-CN-B','COMPLETED','FULLY RECEIVED','2026-08-01','purchase', now() - interval '60 days', now() - interval '2 days');

do $$
declare
  orgA uuid := '00000000-0000-0000-0000-0000000125a1';
  instA uuid := '00000000-0000-0000-0000-0000000125b1';
  orgB uuid := '00000000-0000-0000-0000-0000000125a2';
  instB uuid := '00000000-0000-0000-0000-0000000125b2';
  ids text; reasons text; n integer; ok boolean; raised boolean;
  synced_before timestamptz; synced_after timestamptz; qty numeric;
  line jsonb := '[{"card_id":"00000000-0000-0000-0000-000000000000","product_sku":"S","product_name":"S","quantity":5,"received_date":"2026-11-01","location":"Main","location_id":"l"}]';
  orders jsonb := '[{"line_number":0,"product_sku":"S","product_name":"S","quantity":5}]';
begin
  -- 1. Queue contents and priority order (ttl 24h).
  select string_agg(cin7_purchase_id, ',' order by ord), string_agg(reason, ',' order by ord)
    into ids, reasons
  from (select q.*, row_number() over () ord from purchase_refresh_queue(orgA, instA, 24, 60) q) x;
  if ids <> 'p-unsynced,p-open-partial-relisted,p-open-partial-ttl,p-open-none-relisted,p-open-none-ttl,p-closed-new,p-closed-old' then
    raise exception 'unexpected queue order: %', ids;
  end if;
  if reasons <> 'unsynced,relisted,open_ttl,relisted,open_ttl,relisted,relisted' then
    raise exception 'unexpected queue reasons: %', reasons;
  end if;

  -- 2. A larger TTL drops the 30h/40h open rows; the limit is honoured; stable across calls.
  select count(*) into n from purchase_refresh_queue(orgA, instA, 48, 60) where reason = 'open_ttl';
  if n <> 0 then raise exception 'ttl 48h should exclude the 30h/40h open rows, got %', n; end if;
  select count(*) into n from purchase_refresh_queue(orgA, instA, 24, 3);
  if n <> 3 then raise exception 'limit 3 should return 3 rows, got %', n; end if;
  select count(*) into n from purchase_refresh_queue(orgA, instA, 24, 0);
  if n <> 0 then raise exception 'limit 0 should return nothing, got %', n; end if;

  -- 3. Excluded: fresh open, fresh closed, voided.
  select count(*) into n from purchase_refresh_queue(orgA, instA, 24, 60) where cin7_purchase_id in ('p-fresh-open','p-fresh-closed','p-voided');
  if n <> 0 then raise exception 'fresh/voided purchases must not be queued, got %', n; end if;

  -- 4. Tenant isolation: org B sees only its own rows, and org A's instance id under org B's org id yields nothing.
  select string_agg(order_number, ',' order by order_number) into ids from purchase_refresh_queue(orgB, instB, 24, 60);
  if ids <> 'PO-CN-B,PO-U-B' then raise exception 'org B queue should contain only its own rows, got %', ids; end if;
  select count(*) into n from purchase_refresh_queue(orgB, instA, 24, 60);
  if n <> 0 then raise exception 'cross-tenant (org B + instance A) must return nothing, got %', n; end if;

  -- 5. Guarded replace: applies when nothing newer is stored, then the purchase leaves the queue (no re-fetch loop).
  select detail_synced_at into synced_before from purchases where org_id = orgA and cin7_purchase_id = 'p-closed-new';
  ok := replace_purchase_detail_guarded(orgA, instA, 'p-closed-new', line, orders, 'purchase', false, now() - interval '1 minute');
  if not ok then raise exception 'guarded replace should apply when the stored detail is older than the fetch'; end if;
  select detail_synced_at into synced_after from purchases where org_id = orgA and cin7_purchase_id = 'p-closed-new';
  if synced_after <= synced_before then raise exception 'detail_synced_at should advance after an applied replace'; end if;
  select count(*) into n from purchase_refresh_queue(orgA, instA, 24, 60) where cin7_purchase_id = 'p-closed-new';
  if n <> 0 then raise exception 'a refreshed purchase must leave the queue'; end if;

  -- 6. Newer-wins: a fetch that STARTED before the stored detail was applied must not overwrite it.
  ok := replace_purchase_detail_guarded(orgA, instA, 'p-closed-new',
    '[{"card_id":"c-old","product_sku":"S","product_name":"S","quantity":999,"received_date":"2026-01-01","location":"Main","location_id":"l"}]'::jsonb,
    '[]'::jsonb, 'purchase', false, now() - interval '1 hour');
  if ok then raise exception 'an older fetch must not overwrite newer stored detail'; end if;
  select coalesce(sum(quantity),0) into qty from purchase_receipt_lines where org_id = orgA and cin7_purchase_id = 'p-closed-new';
  if qty <> 5 then raise exception 'newer detail must be untouched by the rejected older fetch (qty %)', qty; end if;
  select detail_synced_at into synced_before from purchases where org_id = orgA and cin7_purchase_id = 'p-closed-new';
  if synced_before is distinct from synced_after then raise exception 'detail_synced_at must not change on a rejected replace'; end if;

  -- 7. Missing purchase and wrong tenant both return false and write nothing.
  ok := replace_purchase_detail_guarded(orgA, instA, 'no-such-po', line, orders, 'purchase', false, now());
  if ok then raise exception 'missing purchase should return false'; end if;
  ok := replace_purchase_detail_guarded(orgB, instB, 'p-open-none-ttl', line, orders, 'purchase', false, now());
  if ok then raise exception 'a purchase id that belongs to another tenant must not be replaceable'; end if;
  select count(*) into n from purchase_receipt_lines where org_id = orgB;
  if n <> 0 then raise exception 'cross-tenant attempt must write nothing, got % rows', n; end if;

  -- 8. Repeated refresh is idempotent (no duplicated quantity) and nil-CardID lines of two POs coexist.
  perform pg_sleep(0.01);
  ok := replace_purchase_detail_guarded(orgA, instA, 'p-closed-old', line, orders, 'purchase', false, clock_timestamp());
  if not ok then raise exception 'second purchase should apply'; end if;
  ok := replace_purchase_detail_guarded(orgA, instA, 'p-closed-old', line, orders, 'purchase', false, clock_timestamp());
  select count(*), coalesce(sum(quantity),0) into n, qty from purchase_receipt_lines where org_id = orgA and cin7_purchase_id = 'p-closed-old';
  if n <> 1 or qty <> 5 then raise exception 'repeat refresh must not duplicate quantity (rows %, qty %)', n, qty; end if;
  select count(*) into n from purchase_receipt_lines where org_id = orgA and card_id = '00000000-0000-0000-0000-000000000000';
  if n <> 2 then raise exception 'nil-CardID lines of two POs should coexist, got %', n; end if;

  -- 9. Atomic failure: a payload that violates the within-PO key raises, and the previous rows + timestamp survive.
  select detail_synced_at into synced_before from purchases where org_id = orgA and cin7_purchase_id = 'p-closed-old';
  raised := false;
  begin
    perform replace_purchase_detail_guarded(orgA, instA, 'p-closed-old',
      '[{"card_id":"x","product_sku":"S","quantity":1},{"card_id":"x","product_sku":"S","quantity":2}]'::jsonb, '[]'::jsonb, 'purchase', false, clock_timestamp());
  exception when unique_violation then
    raised := true;
  end;
  if not raised then raise exception 'duplicate (card, sku) within one PO should still raise unique_violation'; end if;
  select coalesce(sum(quantity),0) into qty from purchase_receipt_lines where org_id = orgA and cin7_purchase_id = 'p-closed-old';
  select detail_synced_at into synced_after from purchases where org_id = orgA and cin7_purchase_id = 'p-closed-old';
  if qty <> 5 or synced_after is distinct from synced_before then raise exception 'atomicity: previous rows/timestamp must survive the failed replace'; end if;

  -- 10. Privileges: the functions are service-role only.
  if has_function_privilege('anon', 'purchase_refresh_queue(uuid,uuid,integer,integer)', 'execute')
     or has_function_privilege('authenticated', 'purchase_refresh_queue(uuid,uuid,integer,integer)', 'execute')
     or has_function_privilege('anon', 'replace_purchase_detail_guarded(uuid,uuid,text,jsonb,jsonb,text,boolean,timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'replace_purchase_detail_guarded(uuid,uuid,text,jsonb,jsonb,text,boolean,timestamptz)', 'execute') then
    raise exception 'anon/authenticated must not be able to execute the refresh functions';
  end if;
end $$;

do $$ begin raise notice 'ALL 0125 PURCHASE_REFRESH_QUEUE / GUARDED_REPLACE ASSERTIONS PASSED'; end $$;

rollback;
