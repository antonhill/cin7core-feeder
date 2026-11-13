-- ROLLBACK for 0127_toolbox_cost_confidentiality.sql. Run only with owner approval. Restores the pre-0127 CLIENT READ access (member read policy + SELECT) on the nine tables and
-- EXECUTE on the five functions for the roles that had it. It deliberately does NOT restore the accidental INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER grants (nothing ever needed them).
-- anon held SELECT only on quotes and quote_lines (row-hidden by RLS). It reverses ONLY 0127. Re-running is safe.

do $$
declare
  t text;
begin
  foreach t in array array['products','quotes','quote_lines','sale_lines','assembly_bom_lines','assembly_consumption_lines','production_bom_items','production_operations','production_orders'] loop
    if to_regclass(format('public.%I', t)) is null then continue; end if;
    execute format('drop policy if exists %I on public.%I', 'org members read ' || t, t);
    execute format('create policy %I on public.%I for select using (is_org_member(org_id))', 'org members read ' || t, t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
  foreach t in array array['quotes','quote_lines'] loop
    if to_regclass(format('public.%I', t)) is null then continue; end if;
    execute format('grant select on table public.%I to anon', t);
  end loop;
end $$;

do $$
declare
  f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
             and p.proname in ('report_sales_by_product','report_sales_pivot','report_sales_facts','report_reorder','recompute_product_hash') loop
    execute format('grant execute on function %s to public, anon, authenticated, service_role', f);
  end loop;
end $$;
