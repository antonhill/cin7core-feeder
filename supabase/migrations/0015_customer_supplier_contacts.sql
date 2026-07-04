-- Contacts move from flat columns on customers/suppliers to their own
-- one-to-many tables. Real bug found live: Cin7's own Customers/Suppliers
-- CSV export can have several rows sharing the same Name, one per contact
-- (confirmed with a live customer that had ~11 contact rows) — modeling
-- contact as flat columns meant a single import batch with two same-named
-- rows crashed Postgres ("ON CONFLICT DO UPDATE command cannot affect row a
-- second time"), and any earlier import that *didn't* crash had silently
-- kept only the last contact per name. This mirrors how addresses already
-- work (their own table, full-replace-per-name on import) and matches
-- Cin7's own live API shape confirmed in docs/cin7-api-findings.md §10 —
-- both Customer and Supplier really do carry a Contacts[] array.

create table if not exists customer_contacts (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations (id) on delete cascade,
  name              text not null,
  contact_name      text,
  job_title         text,
  phone             text,
  mobile_phone      text,
  fax               text,
  email             text,
  website           text,
  contact_comment   text,
  contact_default   boolean not null default false,
  contact_include_in_email boolean not null default false,
  marketing_consent text
);

create index if not exists customer_contacts_name_idx on customer_contacts (org_id, name);

create table if not exists supplier_contacts (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations (id) on delete cascade,
  name              text not null,
  contact_name      text,
  job_title         text,
  phone             text,
  mobile_phone      text,
  fax               text,
  email             text,
  website           text,
  contact_comment   text,
  contact_default   boolean not null default false,
  contact_include_in_email boolean not null default false
);

create index if not exists supplier_contacts_name_idx on supplier_contacts (org_id, name);

-- Backfill whatever contact data survived the earlier upsert-overwrite bug —
-- better than losing it outright, even though duplicate-named rows already
-- lost every contact but the last one before this migration existed.
insert into customer_contacts (org_id, name, contact_name, job_title, phone, mobile_phone, fax, email, website, contact_comment, contact_default, contact_include_in_email, marketing_consent)
select org_id, name, contact_name, job_title, phone, mobile_phone, fax, email, website, contact_comment, contact_default, contact_include_in_email, marketing_consent
from customers where contact_name is not null;

insert into supplier_contacts (org_id, name, contact_name, job_title, phone, mobile_phone, fax, email, website, contact_comment, contact_default, contact_include_in_email)
select org_id, name, contact_name, job_title, phone, mobile_phone, fax, email, website, contact_comment, contact_default, contact_include_in_email
from suppliers where contact_name is not null;

-- The existing triggers' column lists (migration 0014) reference the
-- contact columns being dropped below — must go before the ALTER, not after.
drop trigger if exists customers_touch on customers;
drop trigger if exists suppliers_touch on suppliers;

alter table customers
  drop column if exists contact_name,
  drop column if exists job_title,
  drop column if exists phone,
  drop column if exists mobile_phone,
  drop column if exists fax,
  drop column if exists email,
  drop column if exists website,
  drop column if exists contact_comment,
  drop column if exists contact_default,
  drop column if exists contact_include_in_email,
  drop column if exists marketing_consent;

alter table suppliers
  drop column if exists contact_name,
  drop column if exists job_title,
  drop column if exists phone,
  drop column if exists mobile_phone,
  drop column if exists fax,
  drop column if exists email,
  drop column if exists website,
  drop column if exists contact_comment,
  drop column if exists contact_default,
  drop column if exists contact_include_in_email;

alter table customer_contacts enable row level security;
alter table supplier_contacts enable row level security;

create policy "org members read customer_contacts" on customer_contacts for select using (is_org_member(org_id));
create policy "org members read supplier_contacts" on supplier_contacts for select using (is_org_member(org_id));

-- content_hash functions must drop every reference to the columns just
-- removed and instead fold in every contact row for that name.
create or replace function recompute_customer_hash(p_org_id uuid, p_name text)
returns void language sql set search_path = public as $$
  update customers c set
    content_hash = md5(
      coalesce(c.status,'') || '|' || coalesce(c.currency,'') || '|' || coalesce(c.payment_term,'') || '|' ||
      coalesce(c.tax_rule,'') || '|' || coalesce(c.account_receivable,'') || '|' || coalesce(c.sale_account,'') || '|' ||
      coalesce(c.price_tier,'') || '|' || coalesce(c.discount::text,'') || '|' || coalesce(c.carrier,'') || '|' ||
      coalesce(c.sales_representative,'') || '|' || coalesce(c.location,'') || '|' || coalesce(c.tax_number,'') || '|' ||
      coalesce(c.tags,'') || '|' || coalesce(c.display_name,'') || '|' || c.is_legal_entity::text || '|' ||
      c.is_bill_parent::text || '|' || coalesce(c.attribute_set,'') || '|' ||
      coalesce(c.additional_attribute_1,'') || '|' || coalesce(c.additional_attribute_2,'') || '|' ||
      coalesce(c.additional_attribute_3,'') || '|' || coalesce(c.additional_attribute_4,'') || '|' ||
      coalesce(c.additional_attribute_5,'') || '|' || coalesce(c.additional_attribute_6,'') || '|' ||
      coalesce(c.additional_attribute_7,'') || '|' || coalesce(c.additional_attribute_8,'') || '|' ||
      coalesce(c.additional_attribute_9,'') || '|' || coalesce(c.additional_attribute_10,'') || '|' ||
      coalesce(c.comments,'') || '|' ||
      coalesce((select string_agg(address_type||':'||coalesce(address_line_1,'')||':'||coalesce(city,'')||':'||address_default_for_type::text, ',' order by address_type, address_line_1)
                from customer_addresses where org_id = c.org_id and name = c.name), '') || '|' ||
      coalesce((select string_agg(coalesce(contact_name,'')||':'||coalesce(email,'')||':'||coalesce(phone,'')||':'||contact_default::text, ',' order by contact_name)
                from customer_contacts where org_id = c.org_id and name = c.name), '')
    ),
    updated_at = now()
  where c.org_id = p_org_id and c.name = p_name;
$$;

create or replace function trg_customer_contact_touch() returns trigger language plpgsql as $$
begin
  perform recompute_customer_hash(coalesce(new.org_id, old.org_id), coalesce(new.name, old.name));
  return null;
end $$;

drop trigger if exists customer_contacts_touch on customer_contacts;
create trigger customer_contacts_touch after insert or update or delete
  on customer_contacts for each row execute function trg_customer_contact_touch();

create or replace function recompute_supplier_hash(p_org_id uuid, p_name text)
returns void language sql set search_path = public as $$
  update suppliers s set
    content_hash = md5(
      coalesce(s.status,'') || '|' || coalesce(s.currency,'') || '|' || coalesce(s.payment_term,'') || '|' ||
      coalesce(s.tax_rule,'') || '|' || coalesce(s.account_payable,'') || '|' || coalesce(s.discount::text,'') || '|' ||
      coalesce(s.tax_number,'') || '|' || coalesce(s.attribute_set,'') || '|' ||
      coalesce(s.additional_attribute_1,'') || '|' || coalesce(s.additional_attribute_2,'') || '|' ||
      coalesce(s.additional_attribute_3,'') || '|' || coalesce(s.additional_attribute_4,'') || '|' ||
      coalesce(s.additional_attribute_5,'') || '|' || coalesce(s.additional_attribute_6,'') || '|' ||
      coalesce(s.additional_attribute_7,'') || '|' || coalesce(s.additional_attribute_8,'') || '|' ||
      coalesce(s.additional_attribute_9,'') || '|' || coalesce(s.additional_attribute_10,'') || '|' ||
      coalesce(s.comments,'') || '|' ||
      coalesce((select string_agg(address_type||':'||coalesce(address_line_1,'')||':'||coalesce(city,'')||':'||address_default_for_type::text, ',' order by address_type, address_line_1)
                from supplier_addresses where org_id = s.org_id and name = s.name), '') || '|' ||
      coalesce((select string_agg(coalesce(contact_name,'')||':'||coalesce(email,'')||':'||coalesce(phone,'')||':'||contact_default::text, ',' order by contact_name)
                from supplier_contacts where org_id = s.org_id and name = s.name), '')
    ),
    updated_at = now()
  where s.org_id = p_org_id and s.name = p_name;
$$;

create or replace function trg_supplier_contact_touch() returns trigger language plpgsql as $$
begin
  perform recompute_supplier_hash(coalesce(new.org_id, old.org_id), coalesce(new.name, old.name));
  return null;
end $$;

drop trigger if exists supplier_contacts_touch on supplier_contacts;
create trigger supplier_contacts_touch after insert or update or delete
  on supplier_contacts for each row execute function trg_supplier_contact_touch();

-- customers_touch/suppliers_touch triggers (migration 0014) still reference
-- the dropped contact columns in their column list — recreate without them.
drop trigger if exists customers_touch on customers;
create trigger customers_touch after insert or update of
  status, currency, payment_term, tax_rule, account_receivable, sale_account, price_tier, discount,
  carrier, sales_representative, location, tax_number, tags, display_name, is_legal_entity, is_bill_parent,
  attribute_set, additional_attribute_1, additional_attribute_2, additional_attribute_3, additional_attribute_4,
  additional_attribute_5, additional_attribute_6, additional_attribute_7, additional_attribute_8,
  additional_attribute_9, additional_attribute_10, comments
  on customers for each row execute function trg_customer_touch();

drop trigger if exists suppliers_touch on suppliers;
create trigger suppliers_touch after insert or update of
  status, currency, payment_term, tax_rule, account_payable, discount, tax_number, attribute_set,
  additional_attribute_1, additional_attribute_2, additional_attribute_3, additional_attribute_4,
  additional_attribute_5, additional_attribute_6, additional_attribute_7, additional_attribute_8,
  additional_attribute_9, additional_attribute_10, comments
  on suppliers for each row execute function trg_supplier_touch();

select recompute_customer_hash(org_id, name) from customers;
select recompute_supplier_hash(org_id, name) from suppliers;
