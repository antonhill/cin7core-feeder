-- Inventory Movement report, Phase 3 — the actual report, combining every
-- "in" and "out" source built in Phases 1-2 (plus Sales, already synced
-- before this feature started) into one per-product view over an
-- adjustable period, with a fast/medium/slow mover classification.
--
-- Sources (see each table's own migration for how it's synced):
--   in:  purchase_receipt_lines (received_date)  — goods received from suppliers
--   in:  assembly_builds (completion_date)       — finished goods produced
--   out: sale_lines (invoice_date)               — goods sold
--   out: assembly_consumption_lines              — components consumed building
--        (joined to assembly_builds for its completion_date, since the
--        consumption line itself carries no date of its own)
--
-- Movement classification is velocity-based (how fast a product sells/is
-- consumed), not stock-level-based (this app has no live on-hand-quantity
-- sync) — "how fast does this move" is what the outbound side answers.
-- Only products with real outbound movement in the period are ranked
-- against each other (ntile(3) over total_out desc, in the `ranked` CTE);
-- a product with zero outbound movement is labelled "No movement" outright
-- rather than being forced into the "Slow" bucket, which would otherwise
-- silently blend "sells occasionally" with "hasn't sold at all" — two very
-- different signals for a business deciding what to reorder or discontinue.
create or replace function report_inventory_movement(
  p_org_id uuid,
  p_instance_ids uuid[] default null,
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  product_sku text,
  product_name text,
  qty_in_purchases numeric,
  qty_in_assemblies numeric,
  qty_out_sales numeric,
  qty_out_consumption numeric,
  total_in numeric,
  total_out numeric,
  net_change numeric,
  mover_category text
) language sql stable set search_path = public as $$
  with movement as (
    select product_sku, product_name, quantity, 'purchases' as source
    from purchase_receipt_lines
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
      and (p_date_from is null or received_date >= p_date_from)
      and (p_date_to is null or received_date <= p_date_to)

    union all

    select product_sku, product_name, quantity, 'assembly_in' as source
    from assembly_builds
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
      and (p_date_from is null or completion_date >= p_date_from)
      and (p_date_to is null or completion_date <= p_date_to)

    union all

    select product_sku, product_name, quantity, 'sales' as source
    from sale_lines
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
      and (p_date_from is null or invoice_date >= p_date_from)
      and (p_date_to is null or invoice_date <= p_date_to)

    union all

    select acl.product_sku, acl.product_name, acl.quantity, 'assembly_consumption' as source
    from assembly_consumption_lines acl
    join assembly_builds ab
      on ab.org_id = acl.org_id and ab.instance_id = acl.instance_id and ab.cin7_task_id = acl.cin7_task_id
    where acl.org_id = p_org_id
      and (p_instance_ids is null or acl.instance_id = any (p_instance_ids))
      and (p_date_from is null or ab.completion_date >= p_date_from)
      and (p_date_to is null or ab.completion_date <= p_date_to)
  ),
  agg as (
    select
      product_sku,
      max(product_name) as product_name,
      sum(case when source = 'purchases' then quantity else 0 end) as qty_in_purchases,
      sum(case when source = 'assembly_in' then quantity else 0 end) as qty_in_assemblies,
      sum(case when source = 'sales' then quantity else 0 end) as qty_out_sales,
      sum(case when source = 'assembly_consumption' then quantity else 0 end) as qty_out_consumption
    from movement
    where product_sku is not null
    group by product_sku
  ),
  ranked as (
    select product_sku, ntile(3) over (order by (qty_out_sales + qty_out_consumption) desc) as bucket
    from agg
    where (qty_out_sales + qty_out_consumption) > 0
  )
  select
    a.product_sku,
    coalesce(p.name, a.product_name) as product_name,
    a.qty_in_purchases,
    a.qty_in_assemblies,
    a.qty_out_sales,
    a.qty_out_consumption,
    a.qty_in_purchases + a.qty_in_assemblies as total_in,
    a.qty_out_sales + a.qty_out_consumption as total_out,
    (a.qty_in_purchases + a.qty_in_assemblies) - (a.qty_out_sales + a.qty_out_consumption) as net_change,
    case
      when (a.qty_out_sales + a.qty_out_consumption) <= 0 then 'No movement'
      when r.bucket = 1 then 'Fast'
      when r.bucket = 2 then 'Medium'
      else 'Slow'
    end as mover_category
  from agg a
  left join ranked r using (product_sku)
  left join products p on p.org_id = p_org_id and p.sku = a.product_sku
  order by total_out desc nulls last;
$$;
