-- Projects: BASE + VARIATION billing scopes, variation billing schedules, per-invoice physical lines.
--
-- ADDITIVE ONLY. Nothing in 0101-0104 is rewritten; no existing row changes meaning (every existing project becomes scope BASE).
--
-- MODEL. A Toolbox project is a BASE billing project plus zero or more VARIATION billing projects (children), each created from ONE
-- APPROVED variation. Every billing project keeps exactly ONE Cin7 Advanced Sale (0104 unique(project_id) is deliberately UNCHANGED),
-- so: one BASE Sale per project, one VARIATION Sale per approved variation, a claim resolves to exactly one Sale (its own billing
-- project's), and the 0101 claim/stage/progress guards apply to variation billing unmodified. Consolidation across the parent and its
-- children is a read concern (application / views), never a second source of truth.
--
-- VARIATION SCHEDULE. Each variation owns a percentage schedule (project_variation_stages, basis points, must total 10000) that is
-- editable only while the variation is DRAFT, validated and frozen when it is APPROVED. After approval the ONLY way to change it is
-- amend_variation_schedule(), which is service-role only, audited (project_variation_schedule_amendments), and refused once any claim
-- or progress event exists on the variation's billing project.
--
-- Nothing here calls Cin7. RLS: org members read; every write is a service-role Server Action. FORWARD RECOVERY: see
-- docs/projects-poc/migration-0105-recovery.md (no destructive down-migration; unused columns/tables are safe to leave).

-- ── projects: billing scope ─────────────────────────────────────────────────
alter table projects add column if not exists billing_scope text not null default 'BASE';
alter table projects add column if not exists parent_project_id uuid;
alter table projects add column if not exists variation_id uuid;

alter table projects add constraint projects_billing_scope_check check (billing_scope in ('BASE', 'VARIATION'));
alter table projects add constraint projects_scope_shape_check check (
  (billing_scope = 'BASE' and parent_project_id is null and variation_id is null)
  or (billing_scope = 'VARIATION' and parent_project_id is not null and variation_id is not null));
alter table projects add constraint projects_parent_fk foreign key (parent_project_id, org_id) references projects (id, org_id) on delete restrict;
alter table projects add constraint projects_variation_fk foreign key (variation_id, org_id) references project_variations (id, org_id) on delete restrict;
create unique index if not exists projects_one_billing_project_per_variation on projects (variation_id) where variation_id is not null;
create index if not exists projects_parent_idx on projects (parent_project_id) where parent_project_id is not null;

create or replace function projects_billing_scope_guard() returns trigger language plpgsql set search_path = public as $$
declare v_parent projects%rowtype; v_var project_variations%rowtype;
begin
  if tg_op = 'UPDATE' then
    if new.billing_scope is distinct from old.billing_scope or new.parent_project_id is distinct from old.parent_project_id
       or new.variation_id is distinct from old.variation_id then
      raise exception 'projects %: billing scope, parent and variation are immutable', old.id;
    end if;
    return new;
  end if;
  if new.billing_scope = 'BASE' then return new; end if;
  select * into v_parent from projects where id = new.parent_project_id and org_id = new.org_id;
  if not found or v_parent.billing_scope <> 'BASE' then raise exception 'projects: a variation billing project needs a BASE parent in the same organization'; end if;
  if v_parent.status <> 'ACTIVE' then raise exception 'projects: parent project % is not ACTIVE', v_parent.id; end if;
  select * into v_var from project_variations where id = new.variation_id and org_id = new.org_id;
  if not found or v_var.project_id <> new.parent_project_id then raise exception 'projects: the variation does not belong to the parent project'; end if;
  if v_var.status <> 'APPROVED' then raise exception 'projects: only an APPROVED variation can be billed (this one is %)', v_var.status; end if;
  if new.original_contract_cents <> v_var.amount_cents then raise exception 'projects: the variation billing contract must equal the approved variation amount'; end if;
  if new.cin7_customer_id is distinct from v_parent.cin7_customer_id or new.customer_name is distinct from v_parent.customer_name
     or new.tax_rate_bps is distinct from v_parent.tax_rate_bps or new.tax_inclusive is distinct from v_parent.tax_inclusive
     or new.currency is distinct from v_parent.currency or new.instance_id is distinct from v_parent.instance_id then
    raise exception 'projects: a variation billing project must share the parent''s customer, tax and Cin7 instance';
  end if;
  return new;
end;
$$;
create trigger projects_billing_scope_guard_trg before insert or update on projects
  for each row execute function projects_billing_scope_guard();

-- ── project_variations: estimated cost (for the variation's estimated margin) ─
-- Nullable = unknown (never 0). Editable only while DRAFT: the 0102 guard already makes an APPROVED/REJECTED variation final, so this
-- freezes with the decision. Internal figure: the application withholds it from viewers who may not see cost.
alter table project_variations add column if not exists estimated_cost_cents bigint check (estimated_cost_cents is null or estimated_cost_cents >= 0);

-- ── project_variation_stages: the variation's own percentage schedule ───────
create table if not exists project_variation_stages (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations (id) on delete cascade,
  variation_id uuid not null,
  sort_order   integer not null check (sort_order > 0),
  name         text not null check (length(btrim(name)) > 0),
  -- Basis points of the variation amount (10000 = 100%). The cents value is derived deterministically when the billing project is created.
  bps          integer not null check (bps between 1 and 10000),
  created_at   timestamptz not null default clock_timestamp(),
  foreign key (variation_id, org_id) references project_variations (id, org_id) on delete cascade,
  unique (variation_id, sort_order),
  unique (variation_id, name)
);

create table if not exists project_variation_schedule_amendments (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations (id) on delete cascade,
  variation_id uuid not null,
  reason       text not null check (length(btrim(reason)) > 0),
  amended_by_email text not null,
  before_stages jsonb not null,
  after_stages  jsonb not null,
  amended_at   timestamptz not null default clock_timestamp(),
  foreign key (variation_id, org_id) references project_variations (id, org_id) on delete restrict
);

alter table project_variation_stages              enable row level security;
alter table project_variation_schedule_amendments enable row level security;
create policy "org members read project_variation_stages"              on project_variation_stages              for select using (is_org_member(org_id));
create policy "org members read project_variation_schedule_amendments" on project_variation_schedule_amendments for select using (is_org_member(org_id));
comment on table project_variation_stages is 'Projects: a variation''s own billing schedule (basis points, totals 10000 at approval). Editable only while DRAFT; thereafter only via amend_variation_schedule(). Service-role writes only.';
comment on table project_variation_schedule_amendments is 'Projects: audit trail of controlled post-approval schedule amendments. Append-only.';

create or replace function project_variation_stages_guard() returns trigger language plpgsql set search_path = public as $$
declare v_var uuid := coalesce(new.variation_id, old.variation_id); v_status text;
begin
  if tg_op = 'DELETE' and not exists (select 1 from project_variations where id = old.variation_id) then return old; end if; -- cascade
  if coalesce(current_setting('newquip.variation_amend', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  select status into v_status from project_variations where id = v_var;
  if v_status is distinct from 'DRAFT' then
    raise exception 'project_variation_stages: the schedule of a % variation is frozen (use amend_variation_schedule)', coalesce(v_status, 'missing');
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger project_variation_stages_guard_trg before insert or update or delete on project_variation_stages
  for each row execute function project_variation_stages_guard();

create or replace function project_variation_amendments_append_only() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from project_variations where id = old.variation_id) then return old; end if;
  raise exception 'project_variation_schedule_amendments: append-only audit record';
end;
$$;
create trigger project_variation_amendments_append_only_trg before update or delete on project_variation_schedule_amendments
  for each row execute function project_variation_amendments_append_only();

-- A variation cannot be approved without a valid schedule: at least one stage, totalling exactly 100%. (Separate trigger: the 0102 guard is not rebuilt.)
create or replace function project_variations_schedule_guard() returns trigger language plpgsql set search_path = public as $$
declare v_sum bigint; v_n integer;
begin
  if old.status = 'DRAFT' and new.status = 'APPROVED' then
    select coalesce(sum(bps), 0), count(*) into v_sum, v_n from project_variation_stages where variation_id = new.id;
    if v_n = 0 or v_sum <> 10000 then
      raise exception 'project_variations %: the billing schedule must have at least one stage and total exactly 100%% (it totals % bps)', new.id, v_sum;
    end if;
  end if;
  return new;
end;
$$;
create trigger project_variations_schedule_guard_trg before update on project_variations
  for each row execute function project_variations_schedule_guard();

-- ── deterministic cents split (largest remainder; ties to the earliest stage) ─
-- The TypeScript twin (src/lib/projects/variation-schedule.ts) is tested against the same worked examples, so the cents the application
-- shows are exactly the cents the database enforces. The result always sums to p_amount.
create or replace function variation_stage_cents(p_amount bigint, p_bps integer[]) returns bigint[]
language plpgsql immutable set search_path = public as $$
declare n integer := coalesce(array_length(p_bps, 1), 0); floors bigint[] := '{}'; rems bigint[] := '{}'; used bigint := 0; spare bigint; i integer; best integer;
begin
  if n = 0 or p_amount < 0 then raise exception 'variation_stage_cents: need stages and a non-negative amount'; end if;
  for i in 1..n loop
    floors[i] := (p_amount * p_bps[i]) / 10000;
    rems[i]   := (p_amount * p_bps[i]) % 10000;
    used := used + floors[i];
  end loop;
  spare := p_amount - used;
  while spare > 0 loop
    best := null;
    for i in 1..n loop
      if rems[i] >= 0 and (best is null or rems[i] > rems[best]) then best := i; end if;
    end loop;
    floors[best] := floors[best] + 1; rems[best] := -1; spare := spare - 1;
  end loop;
  return floors;
end;
$$;

-- ── controlled amendment (service role only) ────────────────────────────────
-- Replaces an APPROVED variation's schedule AND its billing project's stages in one transaction, with an audit row, but ONLY while the
-- billing project has no claim of any status and no progress event. Anything later needs a separately designed credit/re-issue flow.
create or replace function amend_variation_schedule(p_org uuid, p_variation uuid, p_stages jsonb, p_reason text, p_email text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_var project_variations%rowtype; v_bp projects%rowtype; v_before jsonb; v_sum bigint; v_bps integer[]; v_names text[]; v_cents bigint[]; i integer;
begin
  select * into v_var from project_variations where id = p_variation and org_id = p_org;
  if not found then raise exception 'amend_variation_schedule: variation not found'; end if;
  if v_var.status <> 'APPROVED' then raise exception 'amend_variation_schedule: only an APPROVED variation can be amended'; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then raise exception 'amend_variation_schedule: a reason is required'; end if;
  if p_email is null or length(btrim(p_email)) = 0 then raise exception 'amend_variation_schedule: the amending user is required'; end if;
  if jsonb_typeof(p_stages) <> 'array' or jsonb_array_length(p_stages) = 0 then raise exception 'amend_variation_schedule: stages must be a non-empty array'; end if;
  select coalesce(sum((e->>'bps')::integer), 0), array_agg((e->>'bps')::integer order by ord), array_agg(btrim(e->>'name') order by ord)
    into v_sum, v_bps, v_names from jsonb_array_elements(p_stages) with ordinality as t(e, ord);
  if v_sum <> 10000 then raise exception 'amend_variation_schedule: stages must total exactly 100%% (got % bps)', v_sum; end if;

  select * into v_bp from projects where variation_id = p_variation and org_id = p_org;
  if found and (exists (select 1 from project_claims where project_id = v_bp.id) or exists (select 1 from project_progress_events where project_id = v_bp.id)) then
    raise exception 'amend_variation_schedule: the billing project already has claims or progress; the schedule can no longer be amended';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('sort_order', sort_order, 'name', name, 'bps', bps) order by sort_order), '[]'::jsonb)
    into v_before from project_variation_stages where variation_id = p_variation;

  perform set_config('newquip.variation_amend', 'on', true);
  delete from project_variation_stages where variation_id = p_variation;
  for i in 1..array_length(v_bps, 1) loop
    insert into project_variation_stages (org_id, variation_id, sort_order, name, bps) values (p_org, p_variation, i, v_names[i], v_bps[i]);
  end loop;
  perform set_config('newquip.variation_amend', 'off', true);

  if v_bp.id is not null then
    v_cents := variation_stage_cents(v_var.amount_cents, v_bps);
    delete from project_stages where project_id = v_bp.id;
    for i in 1..array_length(v_bps, 1) loop
      insert into project_stages (org_id, project_id, sort_order, name, value_cents) values (p_org, v_bp.id, i, v_names[i], v_cents[i]);
    end loop;
    if not project_schedule_balanced(v_bp.id) then raise exception 'amend_variation_schedule: billing stages do not balance to the variation amount'; end if;
  end if;

  insert into project_variation_schedule_amendments (org_id, variation_id, reason, amended_by_email, before_stages, after_stages)
  values (p_org, p_variation, btrim(p_reason), p_email, v_before,
          (select jsonb_agg(jsonb_build_object('sort_order', sort_order, 'name', name, 'bps', bps) order by sort_order) from project_variation_stages where variation_id = p_variation));
end;
$$;
revoke all on function amend_variation_schedule(uuid, uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function amend_variation_schedule(uuid, uuid, jsonb, text, text) to service_role;
revoke all on function variation_stage_cents(bigint, integer[]) from public, anon, authenticated;
grant execute on function variation_stage_cents(bigint, integer[]) to service_role;

-- ── Sale links: role must match the billing project's scope ─────────────────
alter table project_cin7_sale_links add column if not exists sale_role text not null default 'BASE' check (sale_role in ('BASE', 'VARIATION'));
create or replace function project_cin7_sale_links_role_guard() returns trigger language plpgsql set search_path = public as $$
declare v_scope text;
begin
  select billing_scope into v_scope from projects where id = new.project_id and org_id = new.org_id;
  if v_scope is distinct from new.sale_role then
    raise exception 'project_cin7_sale_links: a % Sale cannot be linked to a % billing project', new.sale_role, coalesce(v_scope, 'missing');
  end if;
  return new;
end;
$$;
create trigger project_cin7_sale_links_role_guard_trg before insert on project_cin7_sale_links
  for each row execute function project_cin7_sale_links_role_guard();

-- ── Postings: physical product lines invoiced at R0 (Slice E) ───────────────
alter table project_claim_cin7_postings add column if not exists physical_lines jsonb;
alter table project_claim_cin7_postings add constraint project_claim_cin7_postings_physical_lines_check
  check (physical_lines is null or (jsonb_typeof(physical_lines) = 'array' and jsonb_array_length(physical_lines) > 0));
create or replace function project_claim_cin7_postings_lines_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if new.physical_lines is distinct from old.physical_lines then
    raise exception 'project_claim_cin7_postings %: the invoiced product lines are immutable', old.id;
  end if;
  return new;
end;
$$;
create trigger project_claim_cin7_postings_lines_guard_trg before update on project_claim_cin7_postings
  for each row execute function project_claim_cin7_postings_lines_guard();

-- ── Advanced Sale creation intents (Slice D) ────────────────────────────────
-- ONE durable intent per billing project, persisted BEFORE any Cin7 call. unique(project_id) is the concurrency lock and the replay
-- guard: a second attempt finds this row instead of creating a second Sale. The stable external_id is what Cin7 carries (ExternalID) and
-- what reconciliation searches for. The row records only what Toolbox sent and saw; it never links the Sale itself (that happens
-- through project_cin7_sale_links after the read-back verifies the Sale).
create table if not exists project_cin7_sale_creations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  project_id  uuid not null,
  instance_id uuid not null references cin7_instances (id) on delete restrict,
  sale_role   text not null check (sale_role in ('BASE', 'VARIATION')),
  external_id         text not null check (length(btrim(external_id)) > 0),
  request_fingerprint text not null check (length(btrim(request_fingerprint)) > 0),
  creation_state text not null default 'PENDING' check (creation_state in
    ('PENDING', 'CREATED', 'RECONCILED', 'FAILED_CONFIRMED_NO_WRITE', 'FAILED_UNCERTAIN')),
  attempt_count integer not null default 1 check (attempt_count > 0),
  -- What was requested (customer, location, contract value, physical lines): the audit of the plan, not a source of truth.
  plan jsonb not null,
  contract_ex_vat_cents bigint not null check (contract_ex_vat_cents > 0),
  cin7_sale_id     text,
  cin7_sale_number text,
  -- How far the two-step create got: NONE (nothing created), HEADER (Sale exists but is incomplete - needs manual completion), DONE.
  progress text not null default 'NONE' check (progress in ('NONE', 'HEADER', 'DONE')),
  requested_by_email text not null,
  requested_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  verified_at  timestamptz,
  last_error_code    text,
  last_error_message text,
  evidence jsonb,
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (project_id, org_id) references projects (id, org_id) on delete cascade,
  unique (project_id),
  unique (org_id, external_id),
  check (creation_state not in ('CREATED', 'RECONCILED') or (cin7_sale_id is not null and completed_at is not null)),
  check (creation_state <> 'RECONCILED' or verified_at is not null),
  check (progress <> 'DONE' or cin7_sale_id is not null)
);
alter table project_cin7_sale_creations enable row level security;
create policy "org members read project_cin7_sale_creations" on project_cin7_sale_creations for select using (is_org_member(org_id));
comment on table project_cin7_sale_creations is 'Projects: the durable intent to create a Cin7 Advanced Sale for a billing project - one row per project, state machine enforced here. Service-role writes only.';

create or replace function project_cin7_sale_creations_guard() returns trigger language plpgsql set search_path = public as $$
declare v_ok boolean; v_scope text;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from projects where id = old.project_id) and exists (select 1 from organizations where id = old.org_id) then
      raise exception 'project_cin7_sale_creations %: creation intents are an audit record and are never deleted', old.id;
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.creation_state <> 'PENDING' then raise exception 'project_cin7_sale_creations: an intent starts as PENDING'; end if;
    select billing_scope into v_scope from projects where id = new.project_id and org_id = new.org_id and status = 'ACTIVE';
    if v_scope is null then raise exception 'project_cin7_sale_creations: project % is not ACTIVE', new.project_id; end if;
    if v_scope <> new.sale_role then raise exception 'project_cin7_sale_creations: a % Sale cannot be created for a % billing project', new.sale_role, v_scope; end if;
    if exists (select 1 from project_cin7_sale_links where project_id = new.project_id) then
      raise exception 'project_cin7_sale_creations: project % already has a linked Cin7 Sale', new.project_id;
    end if;
    return new;
  end if;
  new.updated_at := clock_timestamp();
  if new.project_id is distinct from old.project_id or new.org_id is distinct from old.org_id or new.instance_id is distinct from old.instance_id
     or new.sale_role is distinct from old.sale_role or new.external_id is distinct from old.external_id
     or new.request_fingerprint is distinct from old.request_fingerprint or new.plan is distinct from old.plan
     or new.contract_ex_vat_cents is distinct from old.contract_ex_vat_cents then
    raise exception 'project_cin7_sale_creations %: the request identity and plan are immutable', old.id;
  end if;
  if old.cin7_sale_id is not null and new.cin7_sale_id is distinct from old.cin7_sale_id then
    raise exception 'project_cin7_sale_creations %: the created Sale reference is immutable', old.id;
  end if;
  if new.progress is distinct from old.progress and not (
       (old.progress = 'NONE' and new.progress in ('HEADER', 'DONE')) or (old.progress = 'HEADER' and new.progress = 'DONE')) then
    raise exception 'project_cin7_sale_creations %: progress can only move forward', old.id;
  end if;
  if new.creation_state is distinct from old.creation_state then
    v_ok := case old.creation_state
      when 'PENDING'                   then new.creation_state in ('CREATED', 'FAILED_CONFIRMED_NO_WRITE', 'FAILED_UNCERTAIN')
      when 'FAILED_CONFIRMED_NO_WRITE' then new.creation_state = 'PENDING'
      when 'FAILED_UNCERTAIN'          then new.creation_state in ('CREATED', 'FAILED_CONFIRMED_NO_WRITE')
      when 'CREATED'                   then new.creation_state = 'RECONCILED'
      else false
    end;
    if not v_ok then raise exception 'project_cin7_sale_creations %: illegal creation transition % -> %', old.id, old.creation_state, new.creation_state; end if;
    if new.creation_state = 'PENDING' and new.attempt_count <= old.attempt_count then
      raise exception 'project_cin7_sale_creations %: a retry must increment attempt_count', old.id;
    end if;
    if new.creation_state = 'FAILED_CONFIRMED_NO_WRITE' and new.progress <> 'NONE' then
      raise exception 'project_cin7_sale_creations %: a Sale that exists in Cin7 is never a confirmed no-write failure', old.id;
    end if;
  end if;
  return new;
end;
$$;
create trigger project_cin7_sale_creations_guard_trg before insert or update or delete on project_cin7_sale_creations
  for each row execute function project_cin7_sale_creations_guard();

-- A Sale link may not appear for a project whose creation intent is in flight or uncertain (it would race the creation).
create or replace function project_cin7_sale_links_creation_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if exists (select 1 from project_cin7_sale_creations where project_id = new.project_id and creation_state in ('PENDING', 'FAILED_UNCERTAIN')) then
    raise exception 'project_cin7_sale_links: a Sale creation for project % is in flight or uncertain; reconcile it first', new.project_id;
  end if;
  return new;
end;
$$;
create trigger project_cin7_sale_links_creation_guard_trg before insert on project_cin7_sale_links
  for each row execute function project_cin7_sale_links_creation_guard();
