-- Projects -> Cin7 Core: one linked Advanced Sale per Project, one Cin7 invoice per APPROVED claim.
--
--   project_cin7_sale_links         exactly ONE per project (unique project_id); immutable apart from last_reconciled_at.
--   project_claim_cin7_postings     exactly ONE per claim (unique claim_id) — a retry reuses the SAME row, idempotency key and
--                                   memo, so a claim can structurally never hold two invoices. Intent is persisted as PENDING
--                                   BEFORE the external call; an uncertain outcome is FAILED_UNCERTAIN and can never go back to
--                                   PENDING without reconciliation proving otherwise.
--
-- Nothing here calls Cin7: these tables only RECORD what server-side code did. RLS: org members read, NO write policies (all writes
-- are service-role Server Actions behind the feature flag / manager checks). The existing project_cin7_links (0101, per claim,
-- record-only) is left untouched. NOT applied to hosted Supabase until reviewed.

-- ── project_cin7_sale_links ─────────────────────────────────────────────────
create table if not exists project_cin7_sale_links (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  project_id  uuid not null,
  instance_id uuid not null references cin7_instances (id) on delete restrict,
  cin7_sale_id    text not null check (length(btrim(cin7_sale_id)) > 0),
  cin7_sale_number text,
  link_status text not null default 'LINKED' check (link_status in ('LINKED')),
  -- Verified from the Sale at link time / supplied explicitly by the manager — never guessed at posting time.
  tax_rule        text not null check (length(btrim(tax_rule)) > 0),
  revenue_account text not null check (length(btrim(revenue_account)) > 0),
  sale_snapshot   jsonb not null default '{}'::jsonb,
  linked_by_email text not null,
  created_at      timestamptz not null default clock_timestamp(),
  last_reconciled_at timestamptz,
  foreign key (project_id, org_id) references projects (id, org_id) on delete cascade,
  unique (project_id),                -- one Sale link per Project
  unique (org_id, cin7_sale_id),      -- a Cin7 Sale belongs to one Project
  unique (id, project_id, org_id)
);

-- ── project_claim_cin7_postings ─────────────────────────────────────────────
create table if not exists project_claim_cin7_postings (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  project_id  uuid not null,
  claim_id    uuid not null,
  sale_link_id uuid not null,

  idempotency_key     text not null,
  request_fingerprint text not null,
  memo                text not null,

  posting_state text not null default 'PENDING' check (posting_state in
    ('PENDING', 'CREATED', 'RECONCILED', 'FAILED_CONFIRMED_NO_WRITE', 'FAILED_UNCERTAIN')),
  attempt_count integer not null default 1 check (attempt_count > 0),

  amount_ex_vat_cents bigint not null check (amount_ex_vat_cents > 0),
  tax_cents           bigint not null check (tax_cents >= 0),
  total_cents         bigint not null check (total_cents = amount_ex_vat_cents + tax_cents),

  cin7_sale_id        text not null,
  cin7_invoice_number text,
  cin7_task_id        text,
  cin7_status         text,

  requested_by_email text not null,
  requested_at timestamptz not null default clock_timestamp(),
  completed_at   timestamptz,
  reconciled_at  timestamptz,
  last_error_code    text,
  last_error_message text,
  evidence jsonb,

  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),

  foreign key (claim_id, project_id, org_id) references project_claims (id, project_id, org_id),
  foreign key (sale_link_id, project_id, org_id) references project_cin7_sale_links (id, project_id, org_id),
  unique (claim_id),                    -- ONE posting per claim, ever
  unique (org_id, idempotency_key),
  unique (org_id, memo),
  check (posting_state not in ('CREATED', 'RECONCILED') or (cin7_invoice_number is not null and cin7_task_id is not null and completed_at is not null)),
  check (posting_state <> 'RECONCILED' or reconciled_at is not null)
);

create index if not exists project_claim_cin7_postings_project_idx on project_claim_cin7_postings (project_id);

alter table project_cin7_sale_links     enable row level security;
alter table project_claim_cin7_postings enable row level security;
create policy "org members read project_cin7_sale_links"     on project_cin7_sale_links     for select using (is_org_member(org_id));
create policy "org members read project_claim_cin7_postings" on project_claim_cin7_postings for select using (is_org_member(org_id));

comment on table project_cin7_sale_links is 'Projects: the ONE Cin7 Advanced Sale a Project invoices against. Immutable once linked. Service-role writes only.';
comment on table project_claim_cin7_postings is 'Projects: the Cin7 invoice posting for an APPROVED claim — one row per claim, state machine enforced here. Service-role writes only.';

-- ── Trigger: the Sale link is immutable (only last_reconciled_at moves) and never deleted ──
create or replace function project_cin7_sale_links_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from projects where id = old.project_id) and exists (select 1 from organizations where id = old.org_id) then
      raise exception 'project_cin7_sale_links %: a Sale link is permanent; it cannot be removed', old.id;
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if not exists (select 1 from projects where id = new.project_id and org_id = new.org_id and status = 'ACTIVE') then
      raise exception 'project_cin7_sale_links: project % is not ACTIVE', new.project_id;
    end if;
    return new;
  end if;
  if (to_jsonb(new) - 'last_reconciled_at') is distinct from (to_jsonb(old) - 'last_reconciled_at') then
    raise exception 'project_cin7_sale_links %: a Sale link is immutable (only last_reconciled_at may change)', old.id;
  end if;
  return new;
end;
$$;
create trigger project_cin7_sale_links_guard_trg before insert or update or delete on project_cin7_sale_links
  for each row execute function project_cin7_sale_links_guard();

-- ── Trigger: postings — only APPROVED claims; state machine; frozen request identity ──
create or replace function project_claim_cin7_postings_guard() returns trigger language plpgsql set search_path = public as $$
declare v_ok boolean;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from projects where id = old.project_id) and exists (select 1 from organizations where id = old.org_id) then
      raise exception 'project_claim_cin7_postings %: postings are an audit record and are never deleted', old.id;
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.posting_state <> 'PENDING' then raise exception 'project_claim_cin7_postings: a posting starts as PENDING'; end if;
    if not exists (select 1 from project_claims where id = new.claim_id and project_id = new.project_id and org_id = new.org_id and status = 'APPROVED') then
      raise exception 'project_claim_cin7_postings: only an APPROVED claim can be posted';
    end if;
    if not exists (select 1 from project_cin7_sale_links where id = new.sale_link_id and project_id = new.project_id and cin7_sale_id = new.cin7_sale_id) then
      raise exception 'project_claim_cin7_postings: the posting must use the project''s linked Sale';
    end if;
    return new;
  end if;

  new.updated_at := clock_timestamp();

  -- The request's identity and amounts never change, whatever the state.
  if new.claim_id is distinct from old.claim_id or new.project_id is distinct from old.project_id or new.org_id is distinct from old.org_id
     or new.sale_link_id is distinct from old.sale_link_id or new.idempotency_key is distinct from old.idempotency_key
     or new.request_fingerprint is distinct from old.request_fingerprint or new.memo is distinct from old.memo
     or new.amount_ex_vat_cents is distinct from old.amount_ex_vat_cents or new.tax_cents is distinct from old.tax_cents
     or new.total_cents is distinct from old.total_cents or new.cin7_sale_id is distinct from old.cin7_sale_id then
    raise exception 'project_claim_cin7_postings %: the request identity and amounts are immutable', old.id;
  end if;

  if new.posting_state is distinct from old.posting_state then
    v_ok := case old.posting_state
      when 'PENDING'                   then new.posting_state in ('CREATED', 'FAILED_CONFIRMED_NO_WRITE', 'FAILED_UNCERTAIN')
      when 'FAILED_CONFIRMED_NO_WRITE' then new.posting_state = 'PENDING'                       -- controlled retry, same row / key / memo
      when 'FAILED_UNCERTAIN'          then new.posting_state in ('CREATED', 'FAILED_CONFIRMED_NO_WRITE')  -- ONLY via reconciliation; never straight to PENDING
      when 'CREATED'                   then new.posting_state = 'RECONCILED'
      else false                                                                                -- RECONCILED is final
    end;
    if not v_ok then
      raise exception 'project_claim_cin7_postings %: illegal posting transition % -> %', old.id, old.posting_state, new.posting_state;
    end if;
    if new.posting_state = 'PENDING' and new.attempt_count <= old.attempt_count then
      raise exception 'project_claim_cin7_postings %: a retry must increment attempt_count', old.id;
    end if;
  elsif old.posting_state in ('CREATED', 'RECONCILED')
        and (new.cin7_invoice_number is distinct from old.cin7_invoice_number or new.cin7_task_id is distinct from old.cin7_task_id) then
    raise exception 'project_claim_cin7_postings %: the created Cin7 invoice reference is immutable', old.id;
  end if;
  return new;
end;
$$;
create trigger project_claim_cin7_postings_guard_trg before insert or update or delete on project_claim_cin7_postings
  for each row execute function project_claim_cin7_postings_guard();
