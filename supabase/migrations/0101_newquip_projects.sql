-- Projects POC (percentage-completion project billing) — Toolbox-local commercial model.
--
-- Billing basis is CONTRACT VALUE x APPROVED COMMERCIAL COMPLETION (not expenses x markup).
-- Reported physical completion, approved commercial completion and billed % are kept separate.
-- NOTHING here talks to Cin7: project_cin7_links is a place to RECORD a future invoice link; the
-- POC has no write path to it. NOT applied to hosted Supabase — owner approval required.
--
-- CONVENTIONS (mirrors 0084 quotes / 0092 scorecards):
--   * every business row carries org_id (on delete cascade to organizations);
--   * RLS: org members may SELECT; there are NO insert/update/delete policies — all writes go through
--     Server Actions on the service-role client, which authorize at the action boundary;
--   * child tables reference their parent with a COMPOSITE (parent_id, org_id) foreign key, so a
--     child row can never carry a different organisation than its parent, even via service role;
--   * money is integer cents (bigint), percentages are integer basis points (10000 = 100%) —
--     no floating point anywhere in the money path (see src/lib/projects/claim-engine.ts);
--   * the engine's invariants are mirrored here as the backstop: claim status transitions, the
--     "release needs positive no-write evidence" rule, frozen baseline, frozen approved claims,
--     append-only progress history.
--
-- VARIATIONS (out of scope, designed for): the ORIGINAL contract lives in
-- projects.original_contract_cents and is never the revised value. A future project_variations
-- table adds approved deltas; revised = original + sum(approved variations). Nothing in this
-- migration needs to change when they arrive.

-- ── projects ────────────────────────────────────────────────────────────────
create table if not exists projects (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations (id) on delete cascade,
  -- The Cin7 instance whose customer/sales this project belongs to (same shape as quotes).
  instance_id   uuid references cin7_instances (id) on delete set null,

  project_reference text not null,
  name              text not null,

  cin7_customer_id  text,
  customer_name     text not null,

  -- Originating approved quote (text reference always; FK when it is a Toolbox quote).
  originating_quote_ref text,
  originating_quote_id  uuid references quotes (id) on delete set null,

  original_contract_cents bigint not null check (original_contract_cents >= 0),
  currency       text not null default 'ZAR',
  -- Resolved tax input: the engine never hard-codes a rate. The rule name + bps are stored as
  -- resolved from the customer/Toolbox tax rule when the project is set up.
  tax_rule       text,
  tax_rate_bps   integer not null default 0 check (tax_rate_bps between 0 and 10000),
  tax_inclusive  boolean not null default false,

  salesperson      text,
  project_manager  text,
  start_date            date,
  target_completion_date date,

  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'ACTIVE', 'COMPLETED', 'CLOSED', 'CANCELLED')),

  -- Immutable snapshot of the approved commercial baseline (quote lines, BOM, estimated costs) —
  -- later product price changes never alter it.
  baseline_snapshot jsonb not null default '{}'::jsonb,

  created_by_email text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),

  unique (org_id, project_reference),
  unique (id, org_id)
);

create index if not exists projects_org_status_idx on projects (org_id, status);

-- ── project_stages (Schedule of Values) ─────────────────────────────────────
create table if not exists project_stages (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  project_id  uuid not null,
  sort_order  integer not null,
  name        text not null check (length(btrim(name)) > 0),
  description text,
  value_cents bigint not null check (value_cents >= 0),
  created_at  timestamptz not null default clock_timestamp(),
  updated_at  timestamptz not null default clock_timestamp(),
  foreign key (project_id, org_id) references projects (id, org_id) on delete cascade,
  unique (project_id, sort_order),
  unique (id, org_id),
  unique (id, project_id, org_id)
);

create index if not exists project_stages_project_idx on project_stages (project_id, sort_order);

-- ── project_stage_allocations (baseline BOM/work visibility; NEVER drives billing) ──
create table if not exists project_stage_allocations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  project_id  uuid not null,
  stage_id    uuid not null,
  -- The line in baseline_snapshot this row allocates (stable key within the snapshot).
  baseline_line_ref text not null,
  sku             text,
  description     text not null,
  quantity        numeric not null default 0,
  sales_value_cents    bigint not null default 0 check (sales_value_cents >= 0),
  estimated_cost_cents bigint check (estimated_cost_cents is null or estimated_cost_cents >= 0), -- null = unknown, never 0
  allocation_bps  integer not null default 10000 check (allocation_bps between 1 and 10000),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (project_id, org_id) references projects (id, org_id) on delete cascade,
  foreign key (stage_id, project_id, org_id) references project_stages (id, project_id, org_id) on delete cascade,
  unique (project_id, baseline_line_ref, stage_id)
);

-- ── project_progress_events (APPEND-ONLY history) ───────────────────────────
-- Reported physical completion and approved commercial completion are separate columns and are
-- recorded with the previous values, the user, the time and a reason. Never overwritten.
create table if not exists project_progress_events (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  project_id  uuid not null,
  stage_id    uuid not null,
  reported_bps          integer not null check (reported_bps between 0 and 10000),
  approved_bps          integer not null check (approved_bps between 0 and 10000),
  previous_reported_bps integer check (previous_reported_bps is null or previous_reported_bps between 0 and 10000),
  previous_approved_bps integer check (previous_approved_bps is null or previous_approved_bps between 0 and 10000),
  comment     text,
  recorded_by_email text not null,
  created_at  timestamptz not null default clock_timestamp(),
  foreign key (project_id, org_id) references projects (id, org_id) on delete cascade,
  foreign key (stage_id, project_id, org_id) references project_stages (id, project_id, org_id) on delete cascade
);

create index if not exists project_progress_events_stage_idx on project_progress_events (stage_id, created_at desc);

-- ── project_claims ──────────────────────────────────────────────────────────
create table if not exists project_claims (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  project_id  uuid not null,
  claim_seq   integer not null check (claim_seq > 0),
  claim_number text not null,
  claim_date  date not null,

  -- Financial-commitment state. RESERVING: APPROVED, CIN7_PENDING, CIN7_CREATED, RECONCILED,
  -- FAILED_UNCERTAIN. RELEASED: DRAFT, READY_FOR_APPROVAL, FAILED_CONFIRMED_NO_WRITE,
  -- CANCELLED_BEFORE_WRITE. An ambiguous failure is FAILED_UNCERTAIN and stays reserved.
  status text not null default 'DRAFT' check (status in (
    'DRAFT', 'READY_FOR_APPROVAL', 'APPROVED', 'CIN7_PENDING', 'CIN7_CREATED', 'RECONCILED',
    'FAILED_UNCERTAIN', 'FAILED_CONFIRMED_NO_WRITE', 'CANCELLED_BEFORE_WRITE'
  )),

  tax_rate_bps   integer not null check (tax_rate_bps between 0 and 10000),
  subtotal_cents bigint not null check (subtotal_cents >= 0),
  tax_cents      bigint not null check (tax_cents >= 0),
  total_cents    bigint not null check (total_cents = subtotal_cents + tax_cents),

  -- Hash of the frozen line snapshot, and of the project baseline at the time (claim-snapshot.ts).
  snapshot_hash text not null,
  baseline_hash text not null,

  -- Durable idempotency key (deterministic over project + claim sequence + snapshot). One per org.
  idempotency_key text not null,

  -- Positive proof that no Cin7 document exists. REQUIRED to move a RESERVING claim to a released state.
  no_write_evidence jsonb,

  -- Audit lineage for the stale-draft policy: a recalculated draft points at the stale draft it
  -- supersedes (that draft is CANCELLED_BEFORE_WRITE with its original lines untouched). Plain FK,
  -- NO ACTION: it must never run a SET NULL update through the frozen-claim guard on org deletion.
  supersedes_claim_id uuid,

  author_email   text not null,
  approver_email text,
  approved_at    timestamptz,
  created_at     timestamptz not null default clock_timestamp(),
  updated_at     timestamptz not null default clock_timestamp(),

  foreign key (project_id, org_id) references projects (id, org_id) on delete cascade,
  unique (project_id, claim_seq),
  unique (org_id, claim_number),
  unique (org_id, idempotency_key),
  unique (id, project_id, org_id),
  check (status not in ('APPROVED', 'CIN7_PENDING', 'CIN7_CREATED', 'RECONCILED', 'FAILED_UNCERTAIN')
         or (approver_email is not null and approved_at is not null))
);

alter table project_claims add constraint project_claims_supersedes_fk foreign key (supersedes_claim_id) references project_claims (id);

create index if not exists project_claims_project_idx on project_claims (project_id, claim_seq);

-- ── project_claim_lines (frozen financial snapshot per stage) ───────────────
create table if not exists project_claim_lines (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  project_id  uuid not null,
  claim_id    uuid not null,
  stage_id    uuid not null,
  stage_name  text not null,
  stage_value_cents          bigint not null check (stage_value_cents >= 0),
  approved_bps               integer not null check (approved_bps between 0 and 10000),
  reported_bps               integer check (reported_bps is null or reported_bps between 0 and 10000),
  earned_to_date_cents       bigint not null check (earned_to_date_cents >= 0),
  previously_committed_cents bigint not null check (previously_committed_cents >= 0),
  current_claim_cents        bigint not null check (current_claim_cents > 0),
  tax_cents                  bigint not null check (tax_cents >= 0),
  created_at  timestamptz not null default clock_timestamp(),
  foreign key (claim_id, project_id, org_id) references project_claims (id, project_id, org_id) on delete cascade,
  foreign key (stage_id, project_id, org_id) references project_stages (id, project_id, org_id) on delete cascade,
  unique (claim_id, stage_id),
  -- the line's own arithmetic must hold, whatever wrote it
  check (current_claim_cents = earned_to_date_cents - previously_committed_cents),
  check (previously_committed_cents + current_claim_cents <= stage_value_cents)
);

-- ── project_cin7_links (RECORD ONLY — the POC has no write path to this table) ──
create table if not exists project_cin7_links (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  project_id  uuid not null,
  claim_id    uuid not null,
  instance_id uuid references cin7_instances (id) on delete set null,
  -- Our reconciliation key written to the Cin7 document's ExternalID/reference.
  external_id       text not null,
  cin7_sale_id      text,
  cin7_invoice_id   text,
  cin7_invoice_number text,
  cin7_status       text,
  -- Evidence gathered by re-reading the Cin7 document (customer, reference, lines, totals, status).
  reconciliation_evidence jsonb,
  reconciled_at   timestamptz,
  created_at      timestamptz not null default clock_timestamp(),
  foreign key (claim_id, project_id, org_id) references project_claims (id, project_id, org_id) on delete cascade,
  unique (claim_id),                 -- at most ONE Cin7 document per claim
  unique (org_id, external_id)
);

-- ── RLS: org members read; writes only via service role ─────────────────────
alter table projects                   enable row level security;
alter table project_stages             enable row level security;
alter table project_stage_allocations  enable row level security;
alter table project_progress_events    enable row level security;
alter table project_claims             enable row level security;
alter table project_claim_lines        enable row level security;
alter table project_cin7_links         enable row level security;

create policy "org members read projects"                  on projects                  for select using (is_org_member(org_id));
create policy "org members read project_stages"            on project_stages            for select using (is_org_member(org_id));
create policy "org members read project_stage_allocations" on project_stage_allocations for select using (is_org_member(org_id));
create policy "org members read project_progress_events"   on project_progress_events   for select using (is_org_member(org_id));
create policy "org members read project_claims"            on project_claims            for select using (is_org_member(org_id));
create policy "org members read project_claim_lines"       on project_claim_lines       for select using (is_org_member(org_id));
create policy "org members read project_cin7_links"        on project_cin7_links        for select using (is_org_member(org_id));

comment on table projects is
  'Projects POC: commercial baseline for percentage-completion billing. Service-role writes only; org members read. Baseline frozen once a claim is APPROVED+.';
comment on table project_claims is
  'Projects POC: progress claims. Status mirrors the claim engine financial-commitment model; FAILED_UNCERTAIN keeps value reserved. Service-role writes only.';

-- ── Helper functions (security invoker; read-only) ──────────────────────────

-- A claim "commits" the baseline once it is APPROVED or any later/uncertain state.
create or replace function project_has_committed_claim(p_project uuid)
returns boolean language sql stable set search_path = public as $$
  select exists (
    select 1 from project_claims
    where project_id = p_project
      and status in ('APPROVED', 'CIN7_PENDING', 'CIN7_CREATED', 'RECONCILED', 'FAILED_UNCERTAIN')
  );
$$;

create or replace function project_schedule_balanced(p_project uuid)
returns boolean language sql stable set search_path = public as $$
  select coalesce((select sum(value_cents) from project_stages where project_id = p_project), 0)
       = (select original_contract_cents from projects where id = p_project);
$$;

-- ── Trigger: projects ───────────────────────────────────────────────────────
create or replace function projects_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    new.updated_at := clock_timestamp();
    -- Baseline immutability: once a claim is APPROVED+ the commercial baseline cannot change.
    if project_has_committed_claim(old.id) and (
         new.org_id is distinct from old.org_id
      or (new.instance_id is distinct from old.instance_id and new.instance_id is not null)
      or new.cin7_customer_id is distinct from old.cin7_customer_id
      or new.customer_name is distinct from old.customer_name
      or new.original_contract_cents is distinct from old.original_contract_cents
      or new.baseline_snapshot is distinct from old.baseline_snapshot
      or new.tax_rate_bps is distinct from old.tax_rate_bps
      or new.tax_inclusive is distinct from old.tax_inclusive
      or new.currency is distinct from old.currency
    ) then
      raise exception 'projects %: the commercial baseline is frozen once a claim is approved (use a Variation)', old.id;
    end if;
    if new.status = 'ACTIVE' and old.status is distinct from 'ACTIVE' and not project_schedule_balanced(old.id) then
      raise exception 'projects %: stage values must sum exactly to the contract value before activation', old.id;
    end if;
  end if;
  return new;
end;
$$;

create trigger projects_guard_trg before update on projects
  for each row execute function projects_guard();

-- ── Trigger: stages frozen once committed ───────────────────────────────────
create or replace function project_stages_guard() returns trigger language plpgsql set search_path = public as $$
declare v_project uuid := coalesce(new.project_id, old.project_id);
begin
  -- Cascade from the parent project or organization (parent row already deleted) must not block.
  if tg_op = 'DELETE' and (not exists (select 1 from projects where id = old.project_id)
                           or not exists (select 1 from organizations where id = old.org_id)) then
    return old;
  end if;
  if project_has_committed_claim(v_project) then
    raise exception 'project_stages: stages of project % are frozen once a claim is approved', v_project;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create trigger project_stages_guard_trg before insert or update or delete on project_stages
  for each row execute function project_stages_guard();

-- ── Trigger: progress events are append-only ────────────────────────────────
create or replace function project_progress_events_append_only() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'project_progress_events are append-only (event %)', old.id;
  end if;
  -- DELETE: allowed only when the parent project or organization is already gone (cascade).
  if exists (select 1 from projects where id = old.project_id) and exists (select 1 from organizations where id = old.org_id) then
    raise exception 'project_progress_events are append-only (event %)', old.id;
  end if;
  return old;
end;
$$;

create trigger project_progress_events_append_only_trg before update or delete on project_progress_events
  for each row execute function project_progress_events_append_only();

-- ── Trigger: claims — creation preconditions, status machine, frozen financials ──
create or replace function project_claims_guard() returns trigger language plpgsql set search_path = public as $$
declare
  v_reserving text[] := array['APPROVED', 'CIN7_PENDING', 'CIN7_CREATED', 'RECONCILED', 'FAILED_UNCERTAIN'];
  v_ok boolean;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'DRAFT' then
      raise exception 'project_claims: a claim must be created as DRAFT';
    end if;
    if not exists (select 1 from projects where id = new.project_id and status = 'ACTIVE') then
      raise exception 'project_claims: project % is not ACTIVE', new.project_id;
    end if;
    if not project_schedule_balanced(new.project_id) then
      raise exception 'project_claims: project % stage values do not reconcile to the contract', new.project_id;
    end if;
    if new.supersedes_claim_id is not null and not exists (
      select 1 from project_claims where id = new.supersedes_claim_id and project_id = new.project_id and org_id = new.org_id
    ) then
      raise exception 'project_claims: supersedes_claim_id must reference a claim of the same project';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    -- Claims are never deleted while their project exists (cascade from project/org is fine).
    if exists (select 1 from projects where id = old.project_id) and exists (select 1 from organizations where id = old.org_id) then
      raise exception 'project_claims % cannot be deleted; cancel it instead', old.id;
    end if;
    return old;
  end if;

  -- UPDATE
  new.updated_at := clock_timestamp();

  -- Financials/identity are frozen from APPROVED onward.
  if old.status = any (v_reserving) then
    if new.project_id is distinct from old.project_id
       or new.org_id is distinct from old.org_id
       or new.claim_seq is distinct from old.claim_seq
       or new.claim_number is distinct from old.claim_number
       or new.claim_date is distinct from old.claim_date
       or new.tax_rate_bps is distinct from old.tax_rate_bps
       or new.subtotal_cents is distinct from old.subtotal_cents
       or new.tax_cents is distinct from old.tax_cents
       or new.total_cents is distinct from old.total_cents
       or new.snapshot_hash is distinct from old.snapshot_hash
       or new.baseline_hash is distinct from old.baseline_hash
       or new.idempotency_key is distinct from old.idempotency_key
       or new.author_email is distinct from old.author_email
       or new.approver_email is distinct from old.approver_email
       or new.approved_at is distinct from old.approved_at
       or new.supersedes_claim_id is distinct from old.supersedes_claim_id then
      raise exception 'project_claims %: financial values are frozen once the claim is approved', old.id;
    end if;
  end if;

  if new.status is distinct from old.status then
    v_ok := case old.status
      when 'DRAFT'              then new.status in ('READY_FOR_APPROVAL', 'CANCELLED_BEFORE_WRITE')
      when 'READY_FOR_APPROVAL' then new.status in ('DRAFT', 'APPROVED', 'CANCELLED_BEFORE_WRITE')
      when 'APPROVED'           then new.status in ('CIN7_PENDING', 'CANCELLED_BEFORE_WRITE')
      when 'CIN7_PENDING'       then new.status in ('CIN7_CREATED', 'FAILED_UNCERTAIN', 'FAILED_CONFIRMED_NO_WRITE')
      when 'CIN7_CREATED'       then new.status in ('RECONCILED')
      when 'FAILED_UNCERTAIN'   then new.status in ('CIN7_CREATED', 'FAILED_CONFIRMED_NO_WRITE')
      else false
    end;
    if not v_ok then
      raise exception 'project_claims %: illegal status transition % -> %', old.id, old.status, new.status;
    end if;
    -- Giving reserved value back requires positive no-write evidence.
    if old.status = any (v_reserving) and not (new.status = any (v_reserving)) and new.no_write_evidence is null then
      raise exception 'project_claims %: releasing a % claim requires no_write_evidence', old.id, old.status;
    end if;
    -- Approving reserves value: each line's previously-committed amount must equal what OTHER
    -- reserving claims already hold on that stage right now (else the draft is stale -> re-draft).
    if new.status = 'APPROVED' then
      if exists (
        select 1
        from project_claim_lines l
        where l.claim_id = new.id
          and l.previously_committed_cents <> (
            select coalesce(sum(l2.current_claim_cents), 0)
            from project_claim_lines l2
            join project_claims c2 on c2.id = l2.claim_id
            where l2.stage_id = l.stage_id and c2.id <> new.id and c2.status = any (v_reserving)
          )
      ) then
        raise exception 'project_claims %: previously-committed amounts are stale; re-draft the claim', new.id;
      end if;
    end if;
  elsif old.status in ('FAILED_CONFIRMED_NO_WRITE', 'CANCELLED_BEFORE_WRITE') then
    raise exception 'project_claims %: a released claim is final', old.id;
  end if;

  return new;
end;
$$;

create trigger project_claims_guard_trg before insert or update or delete on project_claims
  for each row execute function project_claims_guard();

-- ── Trigger: claim lines editable only while the claim is DRAFT ─────────────
create or replace function project_claim_lines_guard() returns trigger language plpgsql set search_path = public as $$
declare v_claim uuid := coalesce(new.claim_id, old.claim_id); v_status text;
begin
  if tg_op = 'DELETE' and (not exists (select 1 from project_claims where id = old.claim_id)
                           or not exists (select 1 from organizations where id = old.org_id)) then
    return old; -- cascade from the parent claim / organization
  end if;
  select status into v_status from project_claims where id = v_claim;
  if v_status is distinct from 'DRAFT' then
    raise exception 'project_claim_lines: claim % is % — its lines are frozen', v_claim, v_status;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger project_claim_lines_guard_trg before insert or update or delete on project_claim_lines
  for each row execute function project_claim_lines_guard();

-- ── Module visibility: hidden by default for every existing org (mirrors 0065/0085/0094) ──
update organizations
set disabled_modules = array_append(disabled_modules, '/projects')
where not ('/projects' = any(disabled_modules));
