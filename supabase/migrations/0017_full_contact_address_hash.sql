-- Both content_hash functions only ever factored a subset of contact/address
-- fields into their string_agg (contact_name/email/phone/contact_default;
-- address_type/address_line_1/city/address_default_for_type) — everything
-- else (job_title, mobile_phone, fax, website, contact_comment,
-- contact_include_in_email, marketing_consent, address_line_2, state,
-- postcode, country, is_parent) was invisible to change detection. A row
-- whose *only* change was one of these fields got silently skipped as
-- "unchanged" on push — reported live: a supplier's ContactDefault/
-- ContactIncludeInEmail edit didn't reach Cin7. Same class of gap as the
-- earlier CreditLimit fix (0016), just in the contact/address sub-tables
-- instead of the parent row.

create or replace function recompute_customer_hash(p_org_id uuid, p_name text)
returns void language sql set search_path = public as $$
  update customers c set
    content_hash = md5(
      coalesce(c.status,'') || '|' || coalesce(c.currency,'') || '|' || coalesce(c.payment_term,'') || '|' ||
      coalesce(c.tax_rule,'') || '|' || coalesce(c.account_receivable,'') || '|' || coalesce(c.sale_account,'') || '|' ||
      coalesce(c.price_tier,'') || '|' || coalesce(c.discount::text,'') || '|' || coalesce(c.credit_limit::text,'') || '|' ||
      coalesce(c.carrier,'') || '|' ||
      coalesce(c.sales_representative,'') || '|' || coalesce(c.location,'') || '|' || coalesce(c.tax_number,'') || '|' ||
      coalesce(c.tags,'') || '|' || coalesce(c.display_name,'') || '|' || c.is_legal_entity::text || '|' ||
      c.is_bill_parent::text || '|' || coalesce(c.attribute_set,'') || '|' ||
      coalesce(c.additional_attribute_1,'') || '|' || coalesce(c.additional_attribute_2,'') || '|' ||
      coalesce(c.additional_attribute_3,'') || '|' || coalesce(c.additional_attribute_4,'') || '|' ||
      coalesce(c.additional_attribute_5,'') || '|' || coalesce(c.additional_attribute_6,'') || '|' ||
      coalesce(c.additional_attribute_7,'') || '|' || coalesce(c.additional_attribute_8,'') || '|' ||
      coalesce(c.additional_attribute_9,'') || '|' || coalesce(c.additional_attribute_10,'') || '|' ||
      coalesce(c.comments,'') || '|' ||
      coalesce((select string_agg(
                  address_type||':'||coalesce(address_line_1,'')||':'||coalesce(address_line_2,'')||':'||
                  coalesce(city,'')||':'||coalesce(state,'')||':'||coalesce(postcode,'')||':'||coalesce(country,'')||':'||
                  address_default_for_type::text||':'||is_parent::text,
                  ',' order by address_type, address_line_1)
                from customer_addresses where org_id = c.org_id and name = c.name), '') || '|' ||
      coalesce((select string_agg(
                  coalesce(contact_name,'')||':'||coalesce(job_title,'')||':'||coalesce(phone,'')||':'||
                  coalesce(mobile_phone,'')||':'||coalesce(fax,'')||':'||coalesce(email,'')||':'||coalesce(website,'')||':'||
                  coalesce(contact_comment,'')||':'||contact_default::text||':'||contact_include_in_email::text||':'||
                  coalesce(marketing_consent,''),
                  ',' order by contact_name)
                from customer_contacts where org_id = c.org_id and name = c.name), '')
    ),
    updated_at = now()
  where c.org_id = p_org_id and c.name = p_name;
$$;

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
      coalesce((select string_agg(
                  address_type||':'||coalesce(address_line_1,'')||':'||coalesce(address_line_2,'')||':'||
                  coalesce(city,'')||':'||coalesce(state,'')||':'||coalesce(postcode,'')||':'||coalesce(country,'')||':'||
                  address_default_for_type::text,
                  ',' order by address_type, address_line_1)
                from supplier_addresses where org_id = s.org_id and name = s.name), '') || '|' ||
      coalesce((select string_agg(
                  coalesce(contact_name,'')||':'||coalesce(job_title,'')||':'||coalesce(phone,'')||':'||
                  coalesce(mobile_phone,'')||':'||coalesce(fax,'')||':'||coalesce(email,'')||':'||coalesce(website,'')||':'||
                  coalesce(contact_comment,'')||':'||contact_default::text||':'||contact_include_in_email::text,
                  ',' order by contact_name)
                from supplier_contacts where org_id = s.org_id and name = s.name), '')
    ),
    updated_at = now()
  where s.org_id = p_org_id and s.name = p_name;
$$;

-- Force every existing customer/supplier's hash to be recomputed now that
-- the full contact/address field set is part of it — otherwise a row whose
-- only real difference was one of these previously-invisible fields would
-- still show as "unchanged" and never get corrected on the next push.
select recompute_customer_hash(org_id, name) from customers;
select recompute_supplier_hash(org_id, name) from suppliers;
