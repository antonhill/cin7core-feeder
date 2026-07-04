-- Customer/Supplier push tracking — same shape as products' content_hash +
-- sync_state (skip-if-unchanged, cin7_id map per instance), keyed by name
-- instead of sku since customers/suppliers have no SKU-like natural key.

alter table customers add column if not exists content_hash text;
alter table suppliers add column if not exists content_hash text;

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
      coalesce(c.comments,'') || '|' || coalesce(c.contact_name,'') || '|' || coalesce(c.job_title,'') || '|' ||
      coalesce(c.phone,'') || '|' || coalesce(c.mobile_phone,'') || '|' || coalesce(c.fax,'') || '|' ||
      coalesce(c.email,'') || '|' || coalesce(c.website,'') || '|' || coalesce(c.contact_comment,'') || '|' ||
      c.contact_default::text || '|' || c.contact_include_in_email::text || '|' ||
      coalesce((select string_agg(address_type||':'||coalesce(address_line_1,'')||':'||coalesce(city,'')||':'||address_default_for_type::text, ',' order by address_type, address_line_1)
                from customer_addresses where org_id = c.org_id and name = c.name), '')
    ),
    updated_at = now()
  where c.org_id = p_org_id and c.name = p_name;
$$;

create or replace function trg_customer_touch() returns trigger language plpgsql as $$
begin
  perform recompute_customer_hash(coalesce(new.org_id, old.org_id), coalesce(new.name, old.name));
  return null;
end $$;

create or replace function trg_customer_address_touch() returns trigger language plpgsql as $$
begin
  perform recompute_customer_hash(coalesce(new.org_id, old.org_id), coalesce(new.name, old.name));
  return null;
end $$;

drop trigger if exists customers_touch on customers;
create trigger customers_touch after insert or update of
  status, currency, payment_term, tax_rule, account_receivable, sale_account, price_tier, discount,
  carrier, sales_representative, location, tax_number, tags, display_name, is_legal_entity, is_bill_parent,
  attribute_set, additional_attribute_1, additional_attribute_2, additional_attribute_3, additional_attribute_4,
  additional_attribute_5, additional_attribute_6, additional_attribute_7, additional_attribute_8,
  additional_attribute_9, additional_attribute_10, comments, contact_name, job_title, phone, mobile_phone,
  fax, email, website, contact_comment, contact_default, contact_include_in_email
  on customers for each row execute function trg_customer_touch();

drop trigger if exists customer_addresses_touch on customer_addresses;
create trigger customer_addresses_touch after insert or update or delete
  on customer_addresses for each row execute function trg_customer_address_touch();

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
      coalesce(s.comments,'') || '|' || coalesce(s.contact_name,'') || '|' || coalesce(s.phone,'') || '|' ||
      coalesce(s.mobile_phone,'') || '|' || coalesce(s.fax,'') || '|' || coalesce(s.email,'') || '|' ||
      coalesce(s.website,'') || '|' || coalesce(s.contact_comment,'') || '|' || s.contact_default::text || '|' ||
      s.contact_include_in_email::text || '|' ||
      coalesce((select string_agg(address_type||':'||coalesce(address_line_1,'')||':'||coalesce(city,'')||':'||address_default_for_type::text, ',' order by address_type, address_line_1)
                from supplier_addresses where org_id = s.org_id and name = s.name), '')
    ),
    updated_at = now()
  where s.org_id = p_org_id and s.name = p_name;
$$;

create or replace function trg_supplier_touch() returns trigger language plpgsql as $$
begin
  perform recompute_supplier_hash(coalesce(new.org_id, old.org_id), coalesce(new.name, old.name));
  return null;
end $$;

create or replace function trg_supplier_address_touch() returns trigger language plpgsql as $$
begin
  perform recompute_supplier_hash(coalesce(new.org_id, old.org_id), coalesce(new.name, old.name));
  return null;
end $$;

drop trigger if exists suppliers_touch on suppliers;
create trigger suppliers_touch after insert or update of
  status, currency, payment_term, tax_rule, account_payable, discount, tax_number, attribute_set,
  additional_attribute_1, additional_attribute_2, additional_attribute_3, additional_attribute_4,
  additional_attribute_5, additional_attribute_6, additional_attribute_7, additional_attribute_8,
  additional_attribute_9, additional_attribute_10, comments, contact_name, phone, mobile_phone, fax, email,
  website, contact_comment, contact_default, contact_include_in_email
  on suppliers for each row execute function trg_supplier_touch();

drop trigger if exists supplier_addresses_touch on supplier_addresses;
create trigger supplier_addresses_touch after insert or update or delete
  on supplier_addresses for each row execute function trg_supplier_address_touch();

select recompute_customer_hash(org_id, name) from customers;
select recompute_supplier_hash(org_id, name) from suppliers;

create table if not exists customer_sync_state (
  org_id         uuid not null references organizations (id) on delete cascade,
  instance_id    uuid not null references cin7_instances (id) on delete cascade,
  name           text not null,
  cin7_id        text,
  synced_hash    text,
  last_synced_at timestamptz,
  last_status    text,
  last_error     text,
  primary key (org_id, instance_id, name),
  foreign key (org_id, name) references customers (org_id, name) on delete cascade
);

create table if not exists supplier_sync_state (
  org_id         uuid not null references organizations (id) on delete cascade,
  instance_id    uuid not null references cin7_instances (id) on delete cascade,
  name           text not null,
  cin7_id        text,
  synced_hash    text,
  last_synced_at timestamptz,
  last_status    text,
  last_error     text,
  primary key (org_id, instance_id, name),
  foreign key (org_id, name) references suppliers (org_id, name) on delete cascade
);

alter table customer_sync_state enable row level security;
alter table supplier_sync_state enable row level security;

create policy "org members read customer_sync_state" on customer_sync_state for select using (is_org_member(org_id));
create policy "org members read supplier_sync_state" on supplier_sync_state for select using (is_org_member(org_id));
