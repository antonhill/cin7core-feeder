-- Opening commitments: value already committed / certified BEFORE the project entered the Toolbox claim workflow.
-- A local record only: it creates no claim and no Cin7 link, and moves no progress % or contract value. It counts toward each
-- stage's billed/committed, so claimable = earned - committed (the claim formula itself is unchanged).
-- Editable only while the project has ZERO claims; frozen as soon as any claim exists.
-- Writes are service-role Server Actions only (RLS: org members read, no write policies). NOT applied to hosted Supabase.

create table if not exists project_opening_commitments (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  project_id  uuid not null,
  stage_id    uuid not null,
  amount_cents bigint not null check (amount_cents >= 0),
  reason      text not null check (length(btrim(reason)) > 0),
  recorded_by_email text not null,
  recorded_at timestamptz not null default clock_timestamp(),
  created_at  timestamptz not null default clock_timestamp(),
  updated_at  timestamptz not null default clock_timestamp(),
  foreign key (project_id, org_id) references projects (id, org_id) on delete cascade,
  foreign key (stage_id, project_id, org_id) references project_stages (id, project_id, org_id) on delete cascade,
  unique (project_id, stage_id)
);

alter table project_opening_commitments enable row level security;
create policy "org members read project_opening_commitments" on project_opening_commitments for select using (is_org_member(org_id));
comment on table project_opening_commitments is
  'Projects POC: value committed before the Toolbox claim workflow. Counts toward billed/committed. Frozen once any claim exists. Service-role writes only.';

create or replace function project_opening_commitments_guard() returns trigger language plpgsql set search_path = public as $$
declare v_project uuid := coalesce(new.project_id, old.project_id);
begin
  -- Cascade from the parent project / organization must not be blocked.
  if tg_op = 'DELETE' and (not exists (select 1 from projects where id = old.project_id)
                           or not exists (select 1 from organizations where id = old.org_id)) then
    return old;
  end if;
  if exists (select 1 from project_claims where project_id = v_project) then
    raise exception 'project_opening_commitments: project % already has a claim — opening commitments are frozen', v_project;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if new.amount_cents > (select value_cents from project_stages where id = new.stage_id) then
    raise exception 'project_opening_commitments: an opening commitment cannot exceed the stage value';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create trigger project_opening_commitments_guard_trg before insert or update or delete on project_opening_commitments
  for each row execute function project_opening_commitments_guard();

-- Claim approval re-checks that each line's previously-committed amount equals what is already held on the stage. That now
-- includes the opening commitment. This is 0101's project_claims_guard with that ONE term added.
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
          ) + coalesce((select o.amount_cents from project_opening_commitments o where o.project_id = l.project_id and o.stage_id = l.stage_id), 0)
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

