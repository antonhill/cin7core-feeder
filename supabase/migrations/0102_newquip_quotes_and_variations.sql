-- NewQuip end-to-end POC: Grower quotes with an immutable accepted baseline, and Project variations.
--
--   newquip_quotes      REP_DRAFT -> ESTIMATOR_REVIEW -> MANAGER_APPROVED_FINAL. Manager approval freezes the accepted baseline
--                       (config, estimator inputs, rule versions, outputs, mappings, overrides, pricing source, prices, assumptions,
--                       revision, contract value). Once approved NOTHING but the one-time project_id link may change.
--   project_variations  The only way scope/value changes after acceptance. original_contract_cents NEVER moves;
--                       revised = original + SUM(APPROVED variations). DRAFT/REJECTED variations touch no contract value.
--
-- NOTHING here talks to Cin7 or Xero. Conventions mirror 0101: org_id on every row, composite (id, org_id) foreign keys,
-- integer cents, RLS = members read / NO write policies (all writes are service-role Server Actions that authorise first).
-- NOT applied to hosted Supabase — owner approval required. Single stream owner: feature/newquip-poc-final.

-- ── newquip_quotes ──────────────────────────────────────────────────────────
create table if not exists newquip_quotes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,

  quote_ref   text not null,
  -- Bumped each time an estimator returns the quote to the rep (a re-drafted quote is a new revision).
  revision    integer not null default 1 check (revision > 0),
  customer_name text not null default '',
  site_name     text not null default '',
  quote_type    text not null default 'project' check (quote_type in ('day_to_day', 'project')),

  state text not null default 'REP_DRAFT' check (state in ('REP_DRAFT', 'ESTIMATOR_REVIEW', 'MANAGER_APPROVED_FINAL')),

  -- The editable QuoteDraft (inputs only; every number is recomputed server-side). Hash of it drives sign-off staleness.
  draft      jsonb not null default '{}'::jsonb,
  draft_hash text  not null default '',

  -- Rep -> Estimator handoff: the customer confirmed this ex-VAT amount.
  customer_confirmed_cents bigint check (customer_confirmed_cents is null or customer_confirmed_cents > 0),
  customer_confirmed_by    text,
  customer_confirmed_at    timestamptz,
  handoff_by_email         text,

  -- Estimator double-check of THIS exact draft_hash.
  estimator_signoff_hash     text,
  estimator_signoff_by_email text,
  estimator_signoff_at       timestamptz,

  -- Manager final approval + the frozen accepted baseline.
  approved_by_email text,
  approved_at       timestamptz,
  accepted_baseline jsonb,
  baseline_hash     text,
  contract_cents    bigint check (contract_cents is null or contract_cents > 0),

  -- Set once, by the Quote -> Project adapter.
  project_id uuid,

  created_by_email text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),

  unique (org_id, quote_ref),
  unique (id, org_id),
  unique (project_id),
  foreign key (project_id, org_id) references projects (id, org_id),

  check (state <> 'MANAGER_APPROVED_FINAL' or (
        accepted_baseline is not null and baseline_hash is not null and contract_cents is not null
    and approved_by_email is not null and approved_at is not null
    and customer_confirmed_cents is not null and customer_confirmed_cents = contract_cents
    and estimator_signoff_hash is not null and estimator_signoff_hash = draft_hash)),
  check (project_id is null or state = 'MANAGER_APPROVED_FINAL')
);

create index if not exists newquip_quotes_org_state_idx on newquip_quotes (org_id, state);

-- ── project_variations ──────────────────────────────────────────────────────
create table if not exists project_variations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  project_id  uuid not null,
  code        text not null check (code ~ '^V[0-9]{3,}$'),
  title       text not null check (length(btrim(title)) > 0),
  description text,
  -- Ex VAT. Additions only in the POC; credits/omissions are post-POC.
  amount_cents bigint not null check (amount_cents > 0),
  status      text not null default 'DRAFT' check (status in ('DRAFT', 'APPROVED', 'REJECTED')),
  raised_by_email  text not null,
  priced_by_email  text,
  decided_by_email text,
  decided_at       timestamptz,
  decision_reason  text,
  created_at  timestamptz not null default clock_timestamp(),
  updated_at  timestamptz not null default clock_timestamp(),
  foreign key (project_id, org_id) references projects (id, org_id) on delete cascade,
  unique (project_id, code),
  unique (id, org_id),
  check (status = 'DRAFT' or (decided_by_email is not null and decided_at is not null)),
  check (status <> 'REJECTED' or (decision_reason is not null and length(btrim(decision_reason)) > 0))
);

create index if not exists project_variations_project_idx on project_variations (project_id, code);

-- ── RLS: members read; writes only via service role ─────────────────────────
alter table newquip_quotes     enable row level security;
alter table project_variations enable row level security;

create policy "org members read newquip_quotes"     on newquip_quotes     for select using (is_org_member(org_id));
create policy "org members read project_variations" on project_variations for select using (is_org_member(org_id));

comment on table newquip_quotes is
  'NewQuip POC: Grower quotes. Manager approval freezes accepted_baseline; an approved quote can only gain its one-time project_id. Service-role writes only.';
comment on table project_variations is
  'Projects: variations. original_contract_cents never changes; revised = original + approved variations. Decisions are final. Service-role writes only.';

-- ── Trigger: quotes — state machine + frozen accepted baseline ──────────────
create or replace function newquip_quotes_guard() returns trigger language plpgsql set search_path = public as $$
declare v_ok boolean;
begin
  if tg_op = 'DELETE' then
    -- Cascade from the organization is fine; deleting an accepted quote on its own never is.
    if exists (select 1 from organizations where id = old.org_id) and old.state = 'MANAGER_APPROVED_FINAL' then
      raise exception 'newquip_quotes %: an accepted quote cannot be deleted', old.id;
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.state <> 'REP_DRAFT' then raise exception 'newquip_quotes: a quote must be created as REP_DRAFT'; end if;
    return new;
  end if;

  new.updated_at := clock_timestamp();

  if old.state = 'MANAGER_APPROVED_FINAL' then
    -- FROZEN. Only the one-time project link may be added.
    if (to_jsonb(new) - 'project_id' - 'updated_at') is distinct from (to_jsonb(old) - 'project_id' - 'updated_at') then
      raise exception 'newquip_quotes %: the accepted baseline is frozen (post-acceptance changes must be Variations)', old.id;
    end if;
    if old.project_id is not null and new.project_id is distinct from old.project_id then
      raise exception 'newquip_quotes %: already linked to a project', old.id;
    end if;
    return new;
  end if;

  if new.state is distinct from old.state then
    v_ok := case old.state
      when 'REP_DRAFT'        then new.state = 'ESTIMATOR_REVIEW'
      when 'ESTIMATOR_REVIEW' then new.state in ('REP_DRAFT', 'MANAGER_APPROVED_FINAL')
      else false
    end;
    if not v_ok then raise exception 'newquip_quotes %: illegal state transition % -> %', old.id, old.state, new.state; end if;
    if new.state = 'MANAGER_APPROVED_FINAL' and new.accepted_baseline is null then
      raise exception 'newquip_quotes %: approval requires the accepted baseline', old.id;
    end if;
  end if;
  if new.project_id is not null and new.state <> 'MANAGER_APPROVED_FINAL' then
    raise exception 'newquip_quotes %: only an accepted quote can have a project', old.id;
  end if;
  return new;
end;
$$;

create trigger newquip_quotes_guard_trg before insert or update or delete on newquip_quotes
  for each row execute function newquip_quotes_guard();

-- ── Trigger: variations — DRAFT -> APPROVED|REJECTED, decisions final ───────
create or replace function project_variations_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from projects where id = old.project_id) and exists (select 1 from organizations where id = old.org_id) then
      raise exception 'project_variations %: variations are never deleted; reject them instead', old.id;
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'DRAFT' then raise exception 'project_variations: a variation must be created as DRAFT'; end if;
    if not exists (select 1 from projects where id = new.project_id and org_id = new.org_id and status = 'ACTIVE') then
      raise exception 'project_variations: project % is not ACTIVE', new.project_id;
    end if;
    return new;
  end if;

  new.updated_at := clock_timestamp();
  if old.status <> 'DRAFT' then
    raise exception 'project_variations %: a % variation is final', old.id, old.status;
  end if;
  if new.project_id is distinct from old.project_id or new.org_id is distinct from old.org_id or new.code is distinct from old.code then
    raise exception 'project_variations %: identity is immutable', old.id;
  end if;
  if new.status <> 'DRAFT' and new.amount_cents is distinct from old.amount_cents then
    raise exception 'project_variations %: a variation is decided at its priced amount', old.id;
  end if;
  if new.status = 'APPROVED' and not exists (select 1 from projects where id = new.project_id and status = 'ACTIVE') then
    raise exception 'project_variations: project % is not ACTIVE', new.project_id;
  end if;
  return new;
end;
$$;

create trigger project_variations_guard_trg before insert or update or delete on project_variations
  for each row execute function project_variations_guard();

-- ── Trigger: the ORIGINAL contract value is immutable once a project leaves DRAFT ──
-- Separate from projects_guard (0101) so that function is not rebuilt here.
create or replace function projects_original_contract_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if old.status <> 'DRAFT' and new.original_contract_cents is distinct from old.original_contract_cents then
    raise exception 'projects %: original_contract_cents is immutable once the project is active (use a Variation)', old.id;
  end if;
  return new;
end;
$$;

create trigger projects_original_contract_guard_trg before update on projects
  for each row execute function projects_original_contract_guard();
