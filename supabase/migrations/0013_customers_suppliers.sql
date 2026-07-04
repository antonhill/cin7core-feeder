-- Customers, Suppliers, and their Addresses — matches Cin7 Core's own
-- "Customers"/"Suppliers"/"CustomerAddresses"/"SupplierAddresses" CSV export
-- templates column-for-column (full fidelity, same approach as the
-- InventoryList expansion in migration 0008). Import-only for now — no
-- content_hash/sync_state wiring, since pushing these to Cin7 is a
-- follow-up once its Customer/Supplier API shape is confirmed.

alter type import_kind add value if not exists 'suppliers';
alter type import_kind add value if not exists 'supplier_addresses';
alter type import_kind add value if not exists 'customers';
alter type import_kind add value if not exists 'customer_addresses';

create table if not exists suppliers (
  org_id                          uuid not null references organizations (id) on delete cascade,
  name                            text not null,
  status                          text,
  currency                        text,
  payment_term                    text,
  tax_rule                        text,
  account_payable                 text,
  carrier                         text,
  discount                        numeric(14,4),
  tax_number                      text,
  attribute_set                   text,
  additional_attribute_1          text,
  additional_attribute_2          text,
  additional_attribute_3          text,
  additional_attribute_4          text,
  additional_attribute_5          text,
  additional_attribute_6          text,
  additional_attribute_7          text,
  additional_attribute_8          text,
  additional_attribute_9          text,
  additional_attribute_10         text,
  comments                        text,
  contact_name                    text,
  job_title                       text,
  phone                           text,
  mobile_phone                    text,
  fax                             text,
  email                           text,
  website                         text,
  contact_comment                 text,
  contact_default                 boolean not null default false,
  contact_include_in_email        boolean not null default false,
  is_accounting_dimension_enabled boolean not null default false,
  dimension_attribute_1           text,
  dimension_attribute_2           text,
  dimension_attribute_3           text,
  dimension_attribute_4           text,
  dimension_attribute_5           text,
  dimension_attribute_6           text,
  dimension_attribute_7           text,
  dimension_attribute_8           text,
  dimension_attribute_9           text,
  dimension_attribute_10          text,
  updated_at                      timestamptz not null default now(),
  primary key (org_id, name)
);

create table if not exists customers (
  org_id                          uuid not null references organizations (id) on delete cascade,
  name                            text not null,
  status                          text,
  currency                        text,
  payment_term                    text,
  tax_rule                        text,
  account_receivable              text,
  sale_account                    text,
  price_tier                      text,
  discount                        numeric(14,4),
  credit_limit                    numeric(14,4),
  carrier                         text,
  sales_representative            text,
  location                        text,
  tax_number                      text,
  tags                            text,
  display_name                    text,
  is_legal_entity                 boolean not null default false,
  parent_customer                 text,
  is_bill_parent                  boolean not null default false,
  attribute_set                   text,
  additional_attribute_1          text,
  additional_attribute_2          text,
  additional_attribute_3          text,
  additional_attribute_4          text,
  additional_attribute_5          text,
  additional_attribute_6          text,
  additional_attribute_7          text,
  additional_attribute_8          text,
  additional_attribute_9          text,
  additional_attribute_10         text,
  comments                        text,
  contact_name                    text,
  job_title                       text,
  phone                           text,
  mobile_phone                    text,
  fax                             text,
  email                           text,
  website                         text,
  contact_comment                 text,
  contact_default                 boolean not null default false,
  contact_include_in_email        boolean not null default false,
  marketing_consent               text,
  is_accounting_dimension_enabled boolean not null default false,
  dimension_attribute_1           text,
  dimension_attribute_2           text,
  dimension_attribute_3           text,
  dimension_attribute_4           text,
  dimension_attribute_5           text,
  dimension_attribute_6           text,
  dimension_attribute_7           text,
  dimension_attribute_8           text,
  dimension_attribute_9           text,
  dimension_attribute_10          text,
  updated_at                      timestamptz not null default now(),
  primary key (org_id, name)
);

-- Addresses aren't FK-constrained to suppliers/customers: Cin7's own export
-- ships these as separate files, and a customer/supplier can have several
-- address rows of the same AddressType (only one flagged
-- AddressDefaultForType) — there's no stable natural key across those
-- duplicates, so each row gets its own surrogate id rather than an
-- upsertable composite key. Import replaces (delete + reinsert) every
-- address row for a given Name on each run, same idea as a full resync.
create table if not exists supplier_addresses (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references organizations (id) on delete cascade,
  name                   text not null,
  address_type           text not null,
  address_default_for_type boolean not null default false,
  address_line_1         text,
  address_line_2         text,
  city                   text,
  state                  text,
  postcode               text,
  country                text
);

create index if not exists supplier_addresses_name_idx on supplier_addresses (org_id, name);

create table if not exists customer_addresses (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references organizations (id) on delete cascade,
  name                   text not null,
  address_type           text not null,
  address_default_for_type boolean not null default false,
  address_line_1         text,
  address_line_2         text,
  city                   text,
  state                  text,
  postcode               text,
  country                text,
  is_parent              boolean not null default false
);

create index if not exists customer_addresses_name_idx on customer_addresses (org_id, name);

alter table suppliers           enable row level security;
alter table customers           enable row level security;
alter table supplier_addresses  enable row level security;
alter table customer_addresses  enable row level security;

create policy "org members read suppliers" on suppliers for select using (is_org_member(org_id));
create policy "org members read customers" on customers for select using (is_org_member(org_id));
create policy "org members read supplier_addresses" on supplier_addresses for select using (is_org_member(org_id));
create policy "org members read customer_addresses" on customer_addresses for select using (is_org_member(org_id));
