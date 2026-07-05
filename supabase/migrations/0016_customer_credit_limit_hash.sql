-- CreditLimit was captured on import but never selected for push nor
-- factored into the customer content_hash — so even after the push client
-- starts sending it, a customer whose only change is CreditLimit would be
-- wrongly skipped as "unchanged". Cin7's own CSV template docs confirm
-- CreditLimit as a normal writable field (see docs/cin7-api-findings.md §10
-- update), so it's no longer held back as unconfirmed.
--
-- Builds on the hash function as it stands after migration 0015 (which
-- dropped the flat contact columns in favour of customer_contacts) — not
-- 0014's version, which no longer matches the table shape.

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
      coalesce((select string_agg(address_type||':'||coalesce(address_line_1,'')||':'||coalesce(city,'')||':'||address_default_for_type::text, ',' order by address_type, address_line_1)
                from customer_addresses where org_id = c.org_id and name = c.name), '') || '|' ||
      coalesce((select string_agg(coalesce(contact_name,'')||':'||coalesce(email,'')||':'||coalesce(phone,'')||':'||contact_default::text, ',' order by contact_name)
                from customer_contacts where org_id = c.org_id and name = c.name), '')
    ),
    updated_at = now()
  where c.org_id = p_org_id and c.name = p_name;
$$;

drop trigger if exists customers_touch on customers;
create trigger customers_touch after insert or update of
  status, currency, payment_term, tax_rule, account_receivable, sale_account, price_tier, discount, credit_limit,
  carrier, sales_representative, location, tax_number, tags, display_name, is_legal_entity, is_bill_parent,
  attribute_set, additional_attribute_1, additional_attribute_2, additional_attribute_3, additional_attribute_4,
  additional_attribute_5, additional_attribute_6, additional_attribute_7, additional_attribute_8,
  additional_attribute_9, additional_attribute_10, comments
  on customers for each row execute function trg_customer_touch();

-- Force every existing customer's hash to be recomputed now that CreditLimit
-- is part of it — otherwise a customer whose CreditLimit was already wrong
-- in Cin7 (pushed before this fix) would still show as "unchanged" and never
-- get corrected on the next push.
select recompute_customer_hash(org_id, name) from customers;
