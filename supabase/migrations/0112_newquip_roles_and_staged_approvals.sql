-- NewQuip functional roles, approval policies and STAGED approvals (additive; applies after 0111). NOT applied to hosted Supabase.
--
-- Extends the Phase H approval framework (0110); it does not replace it. Nothing here calls Cin7 and no existing row is modified (new columns default to
-- the existing single-manager behaviour, and the 0110 functions are left in place so an older deployment keeps working).
--
--   org_functional_roles        who holds which functional role (REP, ESTIMATOR, MANAGER, PROJECT_MANAGER, PROCUREMENT, ADMINISTRATOR) in an organisation.
--   org_functional_role_events  append-only history of every assignment and removal.
--   approval_policies           per document type: the role (and optional named approver) of each approval stage. A quote has an ESTIMATOR stage then a
--                               MANAGER stage; a claim or variation has a MANAGER stage.
--   approval_policy_events      append-only history of every policy save.
--   approval_requests           gains stage / stage_role / originator_email / return_destination: one request per stage of a submitted revision.
--   approval_events             gains stage / destination so the history shows where a return was sent.
--
-- State changes still happen only inside transactional functions that verify version, digest, reasons and separation of duties.

-- ── roles ────────────────────────────────────────────────────────────────────
create table if not exists org_functional_roles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  user_id uuid not null,
  user_email text not null check (length(btrim(user_email)) > 0),
  role text not null check (role in ('REP', 'ESTIMATOR', 'MANAGER', 'PROJECT_MANAGER', 'PROCUREMENT', 'ADMINISTRATOR')),
  assigned_by_email text not null,
  assigned_at timestamptz not null default clock_timestamp(),
  unique (org_id, user_id, role)
);
create index if not exists org_functional_roles_org_idx on org_functional_roles (org_id, role);

create table if not exists org_functional_role_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  user_id uuid not null,
  user_email text not null,
  role text not null,
  action text not null check (action in ('ASSIGNED', 'REMOVED')),
  actor_email text not null,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists org_functional_role_events_org_idx on org_functional_role_events (org_id, created_at);

-- ── policies ─────────────────────────────────────────────────────────────────
create table if not exists approval_policies (
  org_id uuid not null references organizations (id) on delete cascade,
  doc_type text not null check (doc_type in ('QUOTE', 'CLAIM', 'VARIATION')),
  -- [{ "stage": "ESTIMATOR" | "MANAGER", "role": text, "approverEmail": text | null }, ...] in order
  stages jsonb not null check (jsonb_typeof(stages) = 'array' and jsonb_array_length(stages) > 0),
  version integer not null default 1,
  updated_by_email text not null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (org_id, doc_type)
);
create table if not exists approval_policy_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  doc_type text not null,
  stages jsonb not null,
  version integer not null,
  actor_email text not null,
  created_at timestamptz not null default clock_timestamp()
);

-- Strict roles: off by default, so a user with no explicit role keeps the tier-based behaviour of Phase H (member = rep + estimator, admin = also manager).
-- An organisation switches it on when its roles are assigned; from then on only explicit roles count.
alter table approval_settings add column if not exists roles_enforced boolean not null default false;

-- ── staged requests ──────────────────────────────────────────────────────────
alter table approval_requests add column if not exists stage text not null default 'MANAGER' check (stage in ('ESTIMATOR', 'MANAGER'));
alter table approval_requests add column if not exists stage_role text;
alter table approval_requests add column if not exists originator_email text;
alter table approval_requests add column if not exists return_destination text check (return_destination in ('ESTIMATOR', 'PREPARER'));
alter table approval_events add column if not exists stage text;
alter table approval_events add column if not exists destination text;

-- ── guards ───────────────────────────────────────────────────────────────────
create or replace function approval_requests_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from organizations where id = old.org_id) then raise exception 'approval_requests %: approval history is never deleted', old.id; end if;
    return old; -- cascade from a deleted organization
  end if;
  if new.id is distinct from old.id or new.org_id is distinct from old.org_id or new.doc_type is distinct from old.doc_type or new.doc_id is distinct from old.doc_id
     or new.doc_ref is distinct from old.doc_ref or new.revision is distinct from old.revision or new.digest is distinct from old.digest
     or new.amount_cents is distinct from old.amount_cents or new.prepared_by_email is distinct from old.prepared_by_email
     or new.submitted_at is distinct from old.submitted_at or new.created_at is distinct from old.created_at
     or new.stage is distinct from old.stage or new.stage_role is distinct from old.stage_role or new.originator_email is distinct from old.originator_email then
    raise exception 'approval_requests %: the submitted revision, digest, amount, stage and preparer are immutable', old.id;
  end if;
  if old.status <> 'PENDING' then raise exception 'approval_requests %: a % request is final', old.id, old.status; end if;
  if new.status <> 'PENDING' and new.status not in ('APPROVED', 'RETURNED', 'REJECTED', 'WITHDRAWN', 'SUPERSEDED') then raise exception 'illegal status'; end if;
  return new;
end;
$$;

create or replace function newquip_append_only_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if exists (select 1 from organizations where id = old.org_id) then raise exception '%: rows are an audit record and are never updated or deleted', tg_table_name; end if;
  return old; -- cascade from a deleted organization
end;
$$;
create trigger org_functional_role_events_append_only_trg before update or delete on org_functional_role_events for each row execute function newquip_append_only_guard();
create trigger approval_policy_events_append_only_trg before update or delete on approval_policy_events for each row execute function newquip_append_only_guard();

-- ── role assignment: one transaction changes the assignment and appends the history ──
create or replace function org_role_assign(p_org uuid, p_user uuid, p_email text, p_role text, p_actor text) returns boolean language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from org_members where org_id = p_org and user_id = p_user) then raise exception 'org_role: that user is not a member of this organisation'; end if;
  insert into org_functional_roles (org_id, user_id, user_email, role, assigned_by_email) values (p_org, p_user, lower(p_email), p_role, lower(p_actor))
    on conflict (org_id, user_id, role) do nothing;
  if not found then return false; end if;
  insert into org_functional_role_events (org_id, user_id, user_email, role, action, actor_email) values (p_org, p_user, lower(p_email), p_role, 'ASSIGNED', lower(p_actor));
  return true;
end;
$$;
create or replace function org_role_remove(p_org uuid, p_user uuid, p_role text, p_actor text) returns boolean language plpgsql set search_path = public as $$
declare v_email text;
begin
  delete from org_functional_roles where org_id = p_org and user_id = p_user and role = p_role returning user_email into v_email;
  if not found then return false; end if;
  insert into org_functional_role_events (org_id, user_id, user_email, role, action, actor_email) values (p_org, p_user, v_email, p_role, 'REMOVED', lower(p_actor));
  return true;
end;
$$;

-- ── policy save: validated, versioned, logged ──
create or replace function approval_policy_save(p_org uuid, p_doc_type text, p_stages jsonb, p_actor text) returns approval_policies language plpgsql set search_path = public as $$
declare s jsonb; v_stage text[] := '{}'; v_row approval_policies;
begin
  if p_doc_type not in ('QUOTE', 'CLAIM', 'VARIATION') then raise exception 'approval_policy: unknown document type'; end if;
  if jsonb_typeof(p_stages) <> 'array' then raise exception 'approval_policy: stages must be a list'; end if;
  for s in select * from jsonb_array_elements(p_stages) loop
    if (s->>'stage') not in ('ESTIMATOR', 'MANAGER') then raise exception 'approval_policy: unknown stage %', s->>'stage'; end if;
    if (s->>'role') not in ('REP', 'ESTIMATOR', 'MANAGER', 'PROJECT_MANAGER', 'PROCUREMENT', 'ADMINISTRATOR') then raise exception 'approval_policy: unknown role %', s->>'role'; end if;
    v_stage := v_stage || (s->>'stage');
  end loop;
  -- the estimator review of a quotation can be re-assigned but never removed; a claim or variation has a single manager stage
  if p_doc_type = 'QUOTE' and v_stage <> array['ESTIMATOR', 'MANAGER'] then raise exception 'approval_policy: a quotation always needs an estimator stage followed by a manager stage'; end if;
  if p_doc_type <> 'QUOTE' and v_stage <> array['MANAGER'] then raise exception 'approval_policy: a % has a single manager stage', lower(p_doc_type); end if;
  insert into approval_policies (org_id, doc_type, stages, version, updated_by_email) values (p_org, p_doc_type, p_stages, 1, lower(p_actor))
    on conflict (org_id, doc_type) do update set stages = excluded.stages, version = approval_policies.version + 1, updated_by_email = excluded.updated_by_email, updated_at = clock_timestamp()
    returning * into v_row;
  insert into approval_policy_events (org_id, doc_type, stages, version, actor_email) values (p_org, p_doc_type, p_stages, v_row.version, lower(p_actor));
  return v_row;
end;
$$;

-- ── staged submit: one request per stage of a submitted revision ──
create or replace function approval_submit_staged(
  p_org uuid, p_id uuid, p_doc_type text, p_doc_id uuid, p_doc_ref text, p_project_id uuid, p_project_ref text, p_customer text,
  p_digest text, p_amount bigint, p_prepared_by text, p_originator text, p_stage text, p_stage_role text, p_assigned_to text, p_due_at timestamptz,
  p_actor text, p_actor_name text, p_notifications jsonb
) returns approval_requests language plpgsql set search_path = public as $$
declare v_old approval_requests; v_rev integer; v_new approval_requests; v_ev uuid;
begin
  if p_stage not in ('ESTIMATOR', 'MANAGER') then raise exception 'approval: unknown stage %', p_stage; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || p_doc_type || p_doc_id::text, 0));
  select * into v_old from approval_requests where org_id = p_org and doc_type = p_doc_type and doc_id = p_doc_id and status = 'PENDING' for update;
  if found then
    if v_old.digest = p_digest and v_old.stage = p_stage then return v_old; end if; -- identical content at the same stage already pending (idempotent)
    update approval_requests set status = 'SUPERSEDED', closed_at = clock_timestamp(), version = version + 1 where id = v_old.id returning * into v_old;
    insert into approval_events (org_id, request_id, doc_type, doc_id, doc_ref, revision, project_id, action, from_status, to_status, actor_email, actor_name, reason, digest, stage)
      values (v_old.org_id, v_old.id, v_old.doc_type, v_old.doc_id, v_old.doc_ref, v_old.revision, v_old.project_id, 'SUPERSEDED', 'PENDING', 'SUPERSEDED', lower(p_actor), p_actor_name, 'The document changed and was submitted again.', v_old.digest, v_old.stage);
  end if;
  select coalesce(max(revision), 0) + 1 into v_rev from approval_requests where org_id = p_org and doc_type = p_doc_type and doc_id = p_doc_id;
  insert into approval_requests (id, org_id, doc_type, doc_id, doc_ref, project_id, project_ref, customer_name, revision, digest, amount_cents, prepared_by_email, originator_email,
      stage, stage_role, assigned_to_email, assigned_at, due_at)
    values (p_id, p_org, p_doc_type, p_doc_id, p_doc_ref, p_project_id, p_project_ref, p_customer, v_rev, p_digest, p_amount, lower(p_prepared_by), lower(p_originator),
      p_stage, p_stage_role, lower(p_assigned_to), case when p_assigned_to is null then null else clock_timestamp() end, p_due_at)
    returning * into v_new;
  insert into approval_events (org_id, request_id, doc_type, doc_id, doc_ref, revision, project_id, action, from_status, to_status, actor_email, actor_name, reason, digest, stage)
    values (v_new.org_id, v_new.id, v_new.doc_type, v_new.doc_id, v_new.doc_ref, v_new.revision, v_new.project_id, case when exists (select 1 from approval_requests where org_id = p_org and doc_type = p_doc_type and doc_id = p_doc_id and stage = p_stage and id <> p_id) then 'RESUBMITTED' else 'SUBMITTED' end, null, 'PENDING', lower(p_actor), p_actor_name, null, v_new.digest, p_stage)
    returning id into v_ev;
  if p_assigned_to is not null then
    insert into approval_events (org_id, request_id, doc_type, doc_id, doc_ref, revision, project_id, action, from_status, to_status, actor_email, actor_name, reason, digest, stage)
      values (v_new.org_id, v_new.id, v_new.doc_type, v_new.doc_id, v_new.doc_ref, v_new.revision, v_new.project_id, 'ASSIGNED', 'PENDING', 'PENDING', lower(p_actor), p_actor_name, lower(p_assigned_to), v_new.digest, p_stage);
  end if;
  perform approval_enqueue(p_org, v_new.id, v_ev, p_notifications);
  return v_new;
end;
$$;

-- ── staged decide: APPROVE | RETURN | REJECT | WITHDRAW with a return destination ──
create or replace function approval_decide_staged(
  p_org uuid, p_request uuid, p_action text, p_actor text, p_actor_name text, p_reason text, p_expected_version integer, p_expected_digest text,
  p_override boolean, p_destination text, p_notifications jsonb
) returns approval_requests language plpgsql set search_path = public as $$
declare v approval_requests; v_to text; v_ev uuid; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_self boolean; v_dest text;
begin
  if p_action not in ('APPROVE', 'RETURN', 'REJECT', 'WITHDRAW') then raise exception 'approval: unknown action %', p_action; end if;
  select * into v from approval_requests where id = p_request and org_id = p_org for update;
  if not found then raise exception 'approval: request not found'; end if;
  if v.status <> 'PENDING' then raise exception 'approval_not_pending: this submission is already %', v.status; end if;
  if v.version <> p_expected_version then raise exception 'approval_stale: the submission changed (version % vs %); reload and review again', v.version, p_expected_version; end if;
  if v.digest <> p_expected_digest then raise exception 'approval_stale: the submitted content is not what was reviewed'; end if;
  if p_action in ('RETURN', 'REJECT') and (v_reason is null or length(v_reason) < 3) then raise exception 'approval: a written reason is required to return or reject'; end if;
  v_self := lower(p_actor) = v.prepared_by_email or lower(p_actor) = coalesce(v.originator_email, '');
  if p_action = 'APPROVE' and v_self then
    if not coalesce(p_override, false) then raise exception 'approval_separation: you prepared or originated this submission and cannot approve it without an administrator override'; end if;
    if v_reason is null or length(v_reason) < 10 then raise exception 'approval: an override needs a written reason (at least a short sentence)'; end if;
  end if;
  if p_action = 'APPROVE' and not v_self and coalesce(p_override, false) and (v_reason is null or length(v_reason) < 10) then
    raise exception 'approval: an override needs a written reason (at least a short sentence)';
  end if;
  v_dest := case when p_action = 'RETURN' then coalesce(p_destination, 'PREPARER') else null end;
  if v_dest is not null and v_dest not in ('ESTIMATOR', 'PREPARER') then raise exception 'approval: unknown return destination %', v_dest; end if;
  if v_dest = 'ESTIMATOR' and not (v.doc_type = 'QUOTE' and v.stage = 'MANAGER') then raise exception 'approval: only a quotation in manager review can be returned to the estimator'; end if;
  v_to := case p_action when 'APPROVE' then 'APPROVED' when 'RETURN' then 'RETURNED' when 'REJECT' then 'REJECTED' else 'WITHDRAWN' end;
  update approval_requests set status = v_to, closed_at = clock_timestamp(), version = version + 1,
      decided_by_email = case when p_action = 'WITHDRAW' then null else lower(p_actor) end, decided_by_name = case when p_action = 'WITHDRAW' then null else p_actor_name end,
      decided_at = case when p_action = 'WITHDRAW' then null else clock_timestamp() end,
      decision_reason = v_reason, admin_override = (p_action = 'APPROVE' and (v_self or coalesce(p_override, false))), return_destination = v_dest
    where id = v.id returning * into v;
  insert into approval_events (org_id, request_id, doc_type, doc_id, doc_ref, revision, project_id, action, from_status, to_status, actor_email, actor_name, reason, digest, stage, destination)
    values (v.org_id, v.id, v.doc_type, v.doc_id, v.doc_ref, v.revision, v.project_id, case when v.admin_override then 'OVERRIDE_APPROVED' else v_to end, 'PENDING', v_to, lower(p_actor), p_actor_name, v_reason, v.digest, v.stage, v_dest)
    returning id into v_ev;
  perform approval_enqueue(p_org, v.id, v_ev, p_notifications);
  return v;
end;
$$;

-- ── access ───────────────────────────────────────────────────────────────────
alter table org_functional_roles enable row level security;
alter table org_functional_role_events enable row level security;
alter table approval_policies enable row level security;
alter table approval_policy_events enable row level security;
create policy "org members read org_functional_roles" on org_functional_roles for select using (is_org_member(org_id));
create policy "org admins read org_functional_role_events" on org_functional_role_events for select using (is_org_admin(org_id));
create policy "org members read approval_policies" on approval_policies for select using (is_org_member(org_id));
create policy "org admins read approval_policy_events" on approval_policy_events for select using (is_org_admin(org_id));
-- All writes go through the service role (server actions) and the functions above; no insert/update/delete policies are granted.
revoke all on org_functional_roles, org_functional_role_events, approval_policies, approval_policy_events from anon, authenticated;
grant select on org_functional_roles, org_functional_role_events, approval_policies, approval_policy_events to authenticated;

revoke all on function newquip_append_only_guard() from public, anon, authenticated;
revoke all on function org_role_assign(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function org_role_remove(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function approval_policy_save(uuid, text, jsonb, text) from public, anon, authenticated;
revoke all on function approval_submit_staged(uuid, uuid, text, uuid, text, uuid, text, text, text, bigint, text, text, text, text, text, timestamptz, text, text, jsonb) from public, anon, authenticated;
revoke all on function approval_decide_staged(uuid, uuid, text, text, text, text, integer, text, boolean, text, jsonb) from public, anon, authenticated;
