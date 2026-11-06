-- Schema contract for the NewQuip Cin7 customer lookup (src/lib/newquip-customers/cin7-customer-read.ts). Runs against the fully migrated database.
-- The two marker lines below are the columns the lookup SELECTs; a unit test (customer-lookup-schema.test.ts) pins the TypeScript list to them, so the code, this
-- test and the real schema cannot drift apart again (the original lookup asked `customers` for contact columns that migration 0015 had moved to `customer_contacts`).
-- lookup-columns customers: name, display_name, currency
-- lookup-columns customer_contacts: name, contact_name, email, phone, mobile_phone, contact_default
begin;

do $$
declare c text;
begin
  foreach c in array array['name','display_name','currency','org_id'] loop
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'customers' and column_name = c) then raise exception 'customers.% does not exist', c; end if;
  end loop;
  foreach c in array array['name','contact_name','email','phone','mobile_phone','contact_default','org_id'] loop
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'customer_contacts' and column_name = c) then raise exception 'customer_contacts.% does not exist', c; end if;
  end loop;
  -- the model the lookup relies on: customers carries NO contact / email columns (they live in customer_contacts)
  foreach c in array array['contact_name','email','phone','mobile_phone','contact_default'] loop
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'customers' and column_name = c) then raise exception 'customers.% unexpectedly exists: the customer data contract changed', c; end if;
  end loop;
end $$;

-- the exact selections the lookup issues must parse and run (name / trading-name search, contact search, contact fetch), organisation-scoped
insert into organizations (id, name) values ('00000000-0000-0000-0000-00000000c1a1', 'CL Org A'), ('00000000-0000-0000-0000-00000000c1b1', 'CL Org B');
insert into customers (org_id, name, display_name, currency) values
  ('00000000-0000-0000-0000-00000000c1a1', 'Boerdery A', 'Boerdery', 'ZAR'),
  ('00000000-0000-0000-0000-00000000c1a1', 'No Contact Farm', null, null),
  ('00000000-0000-0000-0000-00000000c1b1', 'Boerdery B', null, 'ZAR');
insert into customer_contacts (org_id, name, contact_name, email, phone, contact_default) values
  ('00000000-0000-0000-0000-00000000c1a1', 'Boerdery A', 'Piet Pienaar', 'piet@boerdery.example', '021 555', true),
  ('00000000-0000-0000-0000-00000000c1b1', 'Boerdery B', 'Piet Other', 'piet@other.example', null, true);
do $$ begin
  if (select count(*) from customers where org_id = '00000000-0000-0000-0000-00000000c1a1' and (name ilike '%boerdery%' or display_name ilike '%boerdery%')) <> 1 then raise exception 'name search must find exactly org A''s customer'; end if;
  if (select count(distinct name) from customer_contacts where org_id = '00000000-0000-0000-0000-00000000c1a1' and (contact_name ilike '%piet%' or email ilike '%piet@%')) <> 1 then raise exception 'contact search must stay inside org A'; end if;
  if (select count(*) from customers c where org_id = '00000000-0000-0000-0000-00000000c1a1' and not exists (select 1 from customer_contacts k where k.org_id = c.org_id and k.name = c.name)) <> 1 then raise exception 'a customer without contacts must remain selectable (left join semantics)'; end if;
end $$;

select 'OK: customer lookup schema contract' as result;
rollback;
