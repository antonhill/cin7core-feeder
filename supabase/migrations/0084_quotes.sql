-- Quotation + Margin module, Phase 1 (data layer).
--
-- A quote is a Toolbox-local commercial document: the user builds it here with a live
-- margin view (per-line cost/GP/margin% and a weighted footer — computed by
-- src/lib/quote-margin.ts), then Phase 3 will create it in Cin7 Core as a Sale/Quote.
-- Cin7 stays the system of record; these tables hold the DRAFT and, once submitted, a
-- faithful snapshot of what was sent (including the quote-time cost basis, so a later
-- Average-Cost change never retro-alters a historical quote's recorded margin).
--
-- Money model (see docs/quotation-margin-module.md "Decisions"): ZAR-only for V1 — the
-- currency/exchange_rate columns exist so a future multi-currency pass needs no migration,
-- but V1 always writes ZAR / 1. Margin is on revenue EX-tax; uncosted lines/charges are
-- excluded from the margin but still counted in the subtotal/total.
--
-- RLS: org members READ; there is NO client write policy — every write goes through the
-- service-role client in the quotes actions (same convention as every other write table in
-- this app). quote_lines carries a denormalized org_id purely so the same is_org_member
-- read policy applies without a per-row join.

-- ---------------------------------------------------------------------------
-- quotes — the quote header + server-computed snapshot totals.
-- ---------------------------------------------------------------------------
create table if not exists quotes (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  instance_id   uuid not null references cin7_instances (id) on delete cascade,

  -- draft → submitting → submitted (created in Cin7) ; failed = a submit attempt errored.
  status        text not null default 'draft',

  -- Cin7 customer + the write-side Sale fields the builder collects (all by Cin7's own
  -- identifiers/names — resolved against Cin7, never free-typed into the create call).
  cin7_customer_id  text,
  customer_name     text,
  price_tier        text,
  sales_rep         text,
  location          text,

  -- Money mode. V1: currency='ZAR', exchange_rate=1 (columns kept for a future FX pass).
  currency        text not null default 'ZAR',
  exchange_rate   numeric not null default 1,
  tax_inclusive   boolean not null default false,

  notes           text,

  -- Server-computed snapshot (from computeQuote) — stored so list/detail views never
  -- recompute, and so a submitted quote's recorded figures are frozen at send time.
  subtotal_ex_tax           numeric not null default 0,
  tax_total                 numeric not null default 0,
  total_inc_tax             numeric not null default 0,
  estimated_cost            numeric not null default 0,
  estimated_gp              numeric not null default 0,
  margin_revenue_ex_tax     numeric not null default 0,
  overall_margin_pct        numeric,          -- null = N/A (no costed revenue)
  costed_line_count         integer not null default 0,
  excluded_from_margin_count integer not null default 0,

  -- Populated once created in Cin7 (Phase 3).
  cin7_sale_id    text,
  cin7_quote_number text,
  -- Reconciliation key written to the Sale's ExternalID so an ambiguous create can be
  -- matched back to this quote (mirrors the PO/Stock-Transfer reconciliation approach).
  external_id     text,

  created_by_email text,
  created_at    timestamptz not null default clock_timestamp(),
  updated_at    timestamptz not null default clock_timestamp()
);

create index if not exists quotes_org_instance_status_idx
  on quotes (org_id, instance_id, status);

alter table quotes enable row level security;
create policy "org members read quotes" on quotes for select using (is_org_member(org_id));
-- No write policy — writes only via the quotes actions' service-role client.

comment on table quotes is
  'Quotation+Margin module: Toolbox-local quote header + server-computed margin snapshot. ZAR-only V1. Service-role writes only; org members read.';

-- ---------------------------------------------------------------------------
-- quote_lines — product lines and additional charges.
-- ---------------------------------------------------------------------------
create table if not exists quote_lines (
  id            uuid primary key default gen_random_uuid(),
  quote_id      uuid not null references quotes (id) on delete cascade,
  -- Denormalized from the parent quote so the is_org_member read policy needs no join;
  -- kept consistent by the service-role writer (which sets it from the parent).
  org_id        uuid not null references organizations (id) on delete cascade,

  line_number   integer not null,
  -- 'product' = a stocked/serviced line with a SKU; 'charge' = an additional charge
  -- (freight, handling, …) which may have no cost and is then excluded from margin.
  line_type     text not null default 'product',

  cin7_product_id text,
  product_sku     text,
  product_name    text,

  quantity      numeric not null default 0,
  unit_price    numeric not null default 0,
  discount_pct  numeric not null default 0,
  tax_rate_pct  numeric not null default 0,

  -- Quote-time cost snapshot (Cin7 Average Cost). NULL = cost unknown → excluded from
  -- margin, never treated as 0. cost_snapshot_at records when the basis was captured.
  average_cost      numeric,
  cost_snapshot_at  timestamptz,

  -- Per-line computed snapshot (from computeLine) — frozen historical record.
  revenue_ex_tax  numeric not null default 0,
  estimated_cost  numeric,   -- null when average_cost is null
  estimated_gp    numeric,   -- null when average_cost is null
  margin_pct      numeric,   -- null when N/A (zero revenue or unknown cost)

  created_at    timestamptz not null default clock_timestamp(),
  updated_at    timestamptz not null default clock_timestamp()
);

create index if not exists quote_lines_quote_idx on quote_lines (quote_id, line_number);

alter table quote_lines enable row level security;
create policy "org members read quote_lines" on quote_lines for select using (is_org_member(org_id));
-- No write policy — writes only via the quotes actions' service-role client.

comment on table quote_lines is
  'Quotation+Margin module: quote line items + quote-time cost snapshot + per-line computed margin. Service-role writes only; org members read.';

-- ---------------------------------------------------------------------------
-- quote_creation_claims — non-idempotent-create guard for Cin7 quote creation.
-- Mirrors po_creation_claims / stock_transfer_creation_claims EXACTLY, including the
-- 0080 "ambiguous claims never age-reclaim" rule baked in from the start: an ambiguous
-- outcome (a create attempt whose result with Cin7 is unknown) must force the caller's
-- reconciliation branch to run every time, never a blind retry. Service-role only.
-- ---------------------------------------------------------------------------
create table if not exists quote_creation_claims (
  org_id           uuid not null references organizations (id) on delete cascade,
  instance_id      uuid not null references cin7_instances (id) on delete cascade,
  -- Deterministic hash of the quote's create payload — see src/lib/quote-idempotency.ts
  -- (added with the Phase 3 submission code).
  idempotency_key  text not null,
  status           text not null default 'pending',   -- 'pending' | 'completed' | 'ambiguous'
  cin7_sale_id     text,
  quote_number     text,
  created_at       timestamptz not null default clock_timestamp(),
  updated_at       timestamptz not null default clock_timestamp(),
  primary key (org_id, instance_id, idempotency_key)
);

alter table quote_creation_claims enable row level security;
-- No policies: only the service-role client (which bypasses RLS) ever touches this.

comment on table quote_creation_claims is
  'Quotation+Margin module quote-creation idempotency guard — one short-lived claim per (org,instance,payload hash). Ambiguous claims never age-reclaim. Service-role only.';

/*
 * Atomically try to claim the right to create a Cin7 quote for (p_org, p_instance, p_key).
 * Returns a single row:
 *   claimed=true  → the caller OWNS a fresh claim; it must create the quote, then mark it
 *                   completed (or release/mark-ambiguous per the create outcome).
 *   claimed=false → a claim already blocks creation. Use existing_status:
 *                     'completed' → return the existing quote (idempotent success),
 *                     'pending'   → another request is creating it right now,
 *                     'ambiguous' → a prior attempt's outcome is unknown; the caller MUST
 *                                   reconcile against Cin7 before any retry (never aged away).
 * A non-ambiguous claim older than p_ttl_seconds is expired and reclaimable, so a deliberate
 * later re-quote of the same payload still works.
 */
create or replace function quote_creation_claim(
  p_org uuid,
  p_instance uuid,
  p_key text,
  p_ttl_seconds integer
) returns table (claimed boolean, existing_status text, cin7_sale_id text, quote_number text)
language plpgsql
as $$
declare
  v_status  text;
  v_sid     text;
  v_number  text;
  v_created timestamptz;
begin
  -- Try to take a fresh claim. If no row exists this inserts and we win.
  insert into quote_creation_claims (org_id, instance_id, idempotency_key, status, created_at, updated_at)
  values (p_org, p_instance, p_key, 'pending', clock_timestamp(), clock_timestamp())
  on conflict (org_id, instance_id, idempotency_key) do nothing;

  if found then
    return query select true, 'pending'::text, null::text, null::text;
    return;
  end if;

  -- A row already exists — lock it and decide (serializes concurrent callers). Columns are
  -- table-qualified: the RETURNS TABLE output params share the names cin7_sale_id /
  -- quote_number, so an unqualified select would be ambiguous.
  select c.status, c.cin7_sale_id, c.quote_number, c.created_at
    into v_status, v_sid, v_number, v_created
  from quote_creation_claims c
  where c.org_id = p_org and c.instance_id = p_instance and c.idempotency_key = p_key
  for update;

  -- Never age-reclaim an unresolved ambiguous claim — the caller must positively reconcile
  -- against Cin7 first, regardless of elapsed time (0080's rule, from the start here).
  if v_status = 'ambiguous' then
    return query select false, v_status, v_sid, v_number;
    return;
  end if;

  if v_created > clock_timestamp() - make_interval(secs => p_ttl_seconds) then
    -- Live claim → caller must not create.
    return query select false, v_status, v_sid, v_number;
    return;
  end if;

  -- Expired → reclaim it (we hold the row lock, so this is atomic).
  update quote_creation_claims
    set status = 'pending', cin7_sale_id = null, quote_number = null,
        created_at = clock_timestamp(), updated_at = clock_timestamp()
    where org_id = p_org and instance_id = p_instance and idempotency_key = p_key;
  return query select true, 'pending'::text, null::text, null::text;
end;
$$;

revoke all on function quote_creation_claim(uuid, uuid, text, integer) from public;
revoke all on function quote_creation_claim(uuid, uuid, text, integer) from anon, authenticated;
