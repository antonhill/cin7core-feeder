-- Transactional test for migration 0084 (Quotation+Margin data layer).
-- BEGIN/ROLLBACK: safe against any DB with 0084 applied; leaves no rows.
-- Creates temp organizations + cin7_instances (FKs) and rolls them back.
-- Expect it to print "ALL 0084 ... PASSED".

begin;

-- Minimal FK parents (rolled back).
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000000c1', 'Quote Test Org');
insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted)
  values ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c1', 'Quote Test Instance', 'acct', 'enc');

-- --- quote_creation_claim RPC behaviour --------------------------------------
do $$
declare
  org  uuid := '00000000-0000-0000-0000-0000000000c1';
  inst uuid := '00000000-0000-0000-0000-0000000000c2';
  r1 record; r2 record; r3 record;
begin
  -- First claim for a key → granted (claimed=true, pending).
  select * into r1 from quote_creation_claim(org, inst, 'q-key-A', 900);
  if not r1.claimed or r1.existing_status <> 'pending' then
    raise exception 'first claim should be granted+pending, got claimed=% status=%', r1.claimed, r1.existing_status;
  end if;

  -- Concurrent second claim for the SAME key while pending → blocked.
  select * into r2 from quote_creation_claim(org, inst, 'q-key-A', 900);
  if r2.claimed or r2.existing_status <> 'pending' then
    raise exception 'concurrent second claim should be blocked+pending, got claimed=% status=%', r2.claimed, r2.existing_status;
  end if;

  -- Settle the claim as the app does after creating the quote in Cin7.
  update quote_creation_claims set status = 'completed', cin7_sale_id = 'SALE-1', quote_number = 'QUO-0001'
    where org_id = org and instance_id = inst and idempotency_key = 'q-key-A';

  -- Resubmit while completed+live → blocked, returns the existing quote (idempotent success).
  select * into r3 from quote_creation_claim(org, inst, 'q-key-A', 900);
  if r3.claimed or r3.existing_status <> 'completed' or r3.cin7_sale_id <> 'SALE-1' or r3.quote_number <> 'QUO-0001' then
    raise exception 'resubmit should return the existing quote, got claimed=% status=% sid=% qn=%',
      r3.claimed, r3.existing_status, r3.cin7_sale_id, r3.quote_number;
  end if;

  -- A DIFFERENT key (different payload) → its own fresh claim.
  select * into r1 from quote_creation_claim(org, inst, 'q-key-B', 900);
  if not r1.claimed then raise exception 'a different key should get its own claim'; end if;

  -- Expiry: a completed claim past its TTL is reclaimable (deliberate re-quote later).
  -- ttl=0 makes the existing 'q-key-A' claim already expired.
  select * into r1 from quote_creation_claim(org, inst, 'q-key-A', 0);
  if not r1.claimed or r1.existing_status <> 'pending' then
    raise exception 'expired completed claim should be reclaimable, got claimed=% status=%', r1.claimed, r1.existing_status;
  end if;

  -- CRITICAL (0080 rule): an AMBIGUOUS claim must NEVER age-reclaim — even with ttl=0 it
  -- must keep returning blocked+ambiguous so the caller reconciles against Cin7 first.
  update quote_creation_claims set status = 'ambiguous', cin7_sale_id = null, quote_number = null
    where org_id = org and instance_id = inst and idempotency_key = 'q-key-B';
  select * into r2 from quote_creation_claim(org, inst, 'q-key-B', 0);
  if r2.claimed or r2.existing_status <> 'ambiguous' then
    raise exception 'ambiguous claim must never age-reclaim, got claimed=% status=%', r2.claimed, r2.existing_status;
  end if;
end $$;

-- --- RLS + grants posture ----------------------------------------------------
do $$
declare
  n integer;
begin
  -- All three tables have RLS enabled.
  select count(*) into n from pg_tables
    where schemaname = 'public' and tablename in ('quotes','quote_lines','quote_creation_claims') and rowsecurity;
  if n <> 3 then raise exception 'expected RLS enabled on all 3 quote tables, got %', n; end if;

  -- quotes + quote_lines have EXACTLY one policy each, a SELECT (read) policy; no write policy.
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'quotes';
  if n <> 1 then raise exception 'quotes should have exactly 1 policy, got %', n; end if;
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'quotes' and cmd = 'SELECT';
  if n <> 1 then raise exception 'quotes policy should be SELECT-only, got % SELECT policies', n; end if;

  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'quote_lines';
  if n <> 1 then raise exception 'quote_lines should have exactly 1 policy, got %', n; end if;
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'quote_lines' and cmd = 'SELECT';
  if n <> 1 then raise exception 'quote_lines policy should be SELECT-only, got % SELECT policies', n; end if;

  -- quote_creation_claims has NO policies at all (service-role only).
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'quote_creation_claims';
  if n <> 0 then raise exception 'quote_creation_claims must have no policies, got %', n; end if;

  -- The claim RPC must NOT be executable by anon/authenticated.
  if has_function_privilege('anon', 'quote_creation_claim(uuid,uuid,text,integer)', 'EXECUTE') then
    raise exception 'anon must not have EXECUTE on quote_creation_claim';
  end if;
  if has_function_privilege('authenticated', 'quote_creation_claim(uuid,uuid,text,integer)', 'EXECUTE') then
    raise exception 'authenticated must not have EXECUTE on quote_creation_claim';
  end if;
end $$;

-- --- header/line insert + cascade sanity --------------------------------------
do $$
declare
  org  uuid := '00000000-0000-0000-0000-0000000000c1';
  inst uuid := '00000000-0000-0000-0000-0000000000c2';
  qid  uuid;
  n integer;
begin
  insert into quotes (org_id, instance_id, customer_name, subtotal_ex_tax, overall_margin_pct)
    values (org, inst, 'Acme', 1000, 40) returning id into qid;

  -- Defaults applied (ZAR / 1 / draft / tax-exclusive).
  select count(*) into n from quotes
    where id = qid and currency = 'ZAR' and exchange_rate = 1 and status = 'draft' and tax_inclusive = false;
  if n <> 1 then raise exception 'quote defaults not applied as expected'; end if;

  insert into quote_lines (quote_id, org_id, line_number, product_sku, quantity, unit_price, average_cost, revenue_ex_tax, estimated_cost)
    values (qid, org, 1, 'SKU-1', 10, 100, 60, 1000, 600);
  -- A charge with no cost (nullable average_cost) is allowed.
  insert into quote_lines (quote_id, org_id, line_number, line_type, product_name, quantity, unit_price, revenue_ex_tax)
    values (qid, org, 2, 'charge', 'Freight', 1, 250, 250);

  select count(*) into n from quote_lines where quote_id = qid;
  if n <> 2 then raise exception 'expected 2 quote_lines, got %', n; end if;

  -- Deleting the quote cascades to its lines.
  delete from quotes where id = qid;
  select count(*) into n from quote_lines where quote_id = qid;
  if n <> 0 then raise exception 'deleting a quote must cascade-delete its lines, % remain', n; end if;
end $$;

do $$ begin raise notice 'ALL 0084 QUOTATION-DATA-LAYER ASSERTIONS PASSED'; end $$;

rollback;
