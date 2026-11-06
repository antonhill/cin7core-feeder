-- NewQuip commercial approvals (additive; applies after 0109). NOT applied to hosted Supabase.
--
-- One approval framework for quotations, progress claims and variations. The DOCUMENTS keep their own tables and their own approve/return/cancel
-- actions (nothing is duplicated); this adds the CANONICAL approval state of each submission, an append-only history, durable notifications and
-- the settings for due dates and reminders.
--
--   approval_requests       one row per submission of a document REVISION: who prepared it, the exact content digest and amount that were submitted,
--                           the assigned approver, due date and outcome. At most one PENDING request per document.
--   approval_events         append-only history (never updated or deleted).
--   approval_notifications  durable outbox: an IN_APP row (the notification) and an EMAIL row (delivery tracked; SENT only after the provider accepted it).
--   approval_settings       per-organisation approval target and reminder cadence.
--
-- State changes happen ONLY through approval_submit / approval_decide / approval_reassign, each one transaction that updates the request, appends the
-- event and creates the notifications together. They verify the expected version AND digest (a changed document can never be approved on a stale
-- submission), refuse a second decision, enforce a written reason for return / reject / override, and enforce separation of duties.
-- Nothing here calls Cin7 and no existing row is modified.

create table if not exists approval_settings (
  org_id uuid primary key references organizations (id) on delete cascade,
  target_business_days integer not null default 2 check (target_business_days between 1 and 30),
  reminder_every_hours integer not null default 24 check (reminder_every_hours between 1 and 720),
  max_reminders integer not null default 3 check (max_reminders between 0 and 20),
  escalation_email text,
  updated_by_email text,
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists approval_requests (
  id uuid primary key,
  org_id uuid not null references organizations (id) on delete cascade,
  doc_type text not null check (doc_type in ('QUOTE', 'CLAIM', 'VARIATION')),
  doc_id uuid not null,
  doc_ref text not null check (length(btrim(doc_ref)) > 0),
  project_id uuid,
  project_ref text,
  customer_name text,
  revision integer not null check (revision >= 1),
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  amount_cents bigint not null check (amount_cents >= 0),
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'RETURNED', 'REJECTED', 'WITHDRAWN', 'SUPERSEDED')),
  prepared_by_email text not null,
  submitted_at timestamptz not null default clock_timestamp(),
  assigned_to_email text,
  assigned_at timestamptz,
  due_at timestamptz,
  first_viewed_at timestamptz,
  decided_by_email text,
  decided_by_name text,
  decided_at timestamptz,
  decision_reason text,
  admin_override boolean not null default false,
  closed_at timestamptz,
  version integer not null default 1,
  reminders_sent integer not null default 0,
  last_reminder_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (org_id, doc_type, doc_id, revision),
  check ((status = 'PENDING') = (closed_at is null)),
  check (status not in ('APPROVED', 'RETURNED', 'REJECTED') or (decided_by_email is not null and decided_at is not null)),
  check (status not in ('RETURNED', 'REJECTED') or (decision_reason is not null and length(btrim(decision_reason)) > 0)),
  check (not admin_override or (decision_reason is not null and length(btrim(decision_reason)) > 0))
);
create unique index if not exists approval_requests_one_pending_idx on approval_requests (org_id, doc_type, doc_id) where status = 'PENDING';
create index if not exists approval_requests_queue_idx on approval_requests (org_id, status, submitted_at);

create table if not exists approval_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  request_id uuid not null references approval_requests (id) on delete cascade,
  doc_type text not null,
  doc_id uuid not null,
  doc_ref text not null,
  revision integer not null,
  project_id uuid,
  action text not null check (action in ('SUBMITTED', 'RESUBMITTED', 'ASSIGNED', 'REASSIGNED', 'VIEWED', 'APPROVED', 'OVERRIDE_APPROVED', 'RETURNED', 'REJECTED', 'WITHDRAWN', 'SUPERSEDED', 'REMINDER_SENT')),
  from_status text,
  to_status text,
  actor_email text not null,
  actor_name text,
  reason text,
  digest text not null,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists approval_events_request_idx on approval_events (request_id, created_at);
create index if not exists approval_events_doc_idx on approval_events (org_id, doc_type, doc_id, created_at);

create table if not exists approval_notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  request_id uuid not null references approval_requests (id) on delete cascade,
  event_id uuid references approval_events (id),
  kind text not null check (length(btrim(kind)) > 0),
  recipient_email text not null check (length(btrim(recipient_email)) > 0),
  channel text not null check (channel in ('IN_APP', 'EMAIL')),
  subject text not null,
  body text not null,
  -- the same logical notification can be created twice (retry, duplicate click) and only one row can exist
  dedupe_key text not null unique,
  status text not null default 'PENDING' check (status in ('PENDING', 'SENT', 'FAILED', 'ABANDONED')),
  attempts integer not null default 0,
  last_error text,
  provider_message_id text,
  sent_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check ((status = 'SENT') = (sent_at is not null)),
  check (channel = 'EMAIL' or read_at is null or status = 'SENT')
);
create index if not exists approval_notifications_recipient_idx on approval_notifications (org_id, recipient_email, channel, created_at);
create index if not exists approval_notifications_outbox_idx on approval_notifications (status, channel) where channel = 'EMAIL' and status in ('PENDING', 'FAILED');

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
     or new.submitted_at is distinct from old.submitted_at or new.created_at is distinct from old.created_at then
    raise exception 'approval_requests %: the submitted revision, digest, amount and preparer are immutable', old.id;
  end if;
  if old.status <> 'PENDING' then raise exception 'approval_requests %: a % request is final', old.id, old.status; end if;
  if new.status <> 'PENDING' and new.status not in ('APPROVED', 'RETURNED', 'REJECTED', 'WITHDRAWN', 'SUPERSEDED') then raise exception 'illegal status'; end if;
  return new;
end;
$$;
create trigger approval_requests_guard_trg before update or delete on approval_requests for each row execute function approval_requests_guard();

create or replace function approval_append_only_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if exists (select 1 from organizations where id = old.org_id) then raise exception '%: rows are an audit record and are never updated or deleted', tg_table_name; end if;
  return old; -- cascade from a deleted organization
end;
$$;
create trigger approval_events_append_only_trg before update or delete on approval_events for each row execute function approval_append_only_guard();

create or replace function approval_notifications_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from organizations where id = old.org_id) then raise exception 'approval_notifications %: never deleted', old.id; end if;
    return old;
  end if;
  if new.org_id is distinct from old.org_id or new.request_id is distinct from old.request_id or new.kind is distinct from old.kind or new.recipient_email is distinct from old.recipient_email
     or new.channel is distinct from old.channel or new.subject is distinct from old.subject or new.body is distinct from old.body or new.dedupe_key is distinct from old.dedupe_key
     or new.created_at is distinct from old.created_at then
    raise exception 'approval_notifications %: only delivery status and read state may change', old.id;
  end if;
  if old.status = 'SENT' and new.status <> 'SENT' then raise exception 'approval_notifications %: a sent notification stays sent', old.id; end if;
  return new;
end;
$$;
create trigger approval_notifications_guard_trg before update or delete on approval_notifications for each row execute function approval_notifications_guard();

-- ── notifications helper: p_notifications = [{kind, recipient, subject, body}] -> an IN_APP row (delivered immediately) and an EMAIL row (outbox) each ──
create or replace function approval_enqueue(p_org uuid, p_request uuid, p_event uuid, p_notifications jsonb) returns void language plpgsql set search_path = public as $$
declare n jsonb;
begin
  for n in select * from jsonb_array_elements(coalesce(p_notifications, '[]'::jsonb)) loop
    insert into approval_notifications (org_id, request_id, event_id, kind, recipient_email, channel, subject, body, dedupe_key, status, sent_at)
      values (p_org, p_request, p_event, n->>'kind', lower(n->>'recipient'), 'IN_APP', n->>'subject', n->>'body', (n->>'kind') || ':' || p_request || ':' || lower(n->>'recipient') || ':IN_APP', 'SENT', clock_timestamp())
      on conflict (dedupe_key) do nothing;
    insert into approval_notifications (org_id, request_id, event_id, kind, recipient_email, channel, subject, body, dedupe_key)
      values (p_org, p_request, p_event, n->>'kind', lower(n->>'recipient'), 'EMAIL', n->>'subject', n->>'body', (n->>'kind') || ':' || p_request || ':' || lower(n->>'recipient') || ':EMAIL')
      on conflict (dedupe_key) do nothing;
  end loop;
end;
$$;

create or replace function approval_event(p_req approval_requests, p_action text, p_from text, p_to text, p_actor text, p_actor_name text, p_reason text) returns uuid language plpgsql set search_path = public as $$
declare v_id uuid;
begin
  insert into approval_events (org_id, request_id, doc_type, doc_id, doc_ref, revision, project_id, action, from_status, to_status, actor_email, actor_name, reason, digest)
    values (p_req.org_id, p_req.id, p_req.doc_type, p_req.doc_id, p_req.doc_ref, p_req.revision, p_req.project_id, p_action, p_from, p_to, lower(p_actor), p_actor_name, p_reason, p_req.digest)
    returning id into v_id;
  return v_id;
end;
$$;

-- ── submit: records the exact revision + digest; supersedes a different pending submission of the same document; idempotent for an identical one ──
create or replace function approval_submit(
  p_org uuid, p_id uuid, p_doc_type text, p_doc_id uuid, p_doc_ref text, p_project_id uuid, p_project_ref text, p_customer text,
  p_digest text, p_amount bigint, p_prepared_by text, p_assigned_to text, p_due_at timestamptz, p_actor text, p_actor_name text, p_notifications jsonb
) returns approval_requests language plpgsql set search_path = public as $$
declare v_old approval_requests; v_rev integer; v_new approval_requests; v_ev uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || p_doc_type || p_doc_id::text, 0));
  select * into v_old from approval_requests where org_id = p_org and doc_type = p_doc_type and doc_id = p_doc_id and status = 'PENDING' for update;
  if found then
    if v_old.digest = p_digest then return v_old; end if; -- identical content already pending: nothing to do (idempotent)
    update approval_requests set status = 'SUPERSEDED', closed_at = clock_timestamp(), version = version + 1 where id = v_old.id returning * into v_old;
    perform approval_event(v_old, 'SUPERSEDED', 'PENDING', 'SUPERSEDED', p_actor, p_actor_name, 'The document changed and was submitted again.');
  end if;
  select coalesce(max(revision), 0) + 1 into v_rev from approval_requests where org_id = p_org and doc_type = p_doc_type and doc_id = p_doc_id;
  insert into approval_requests (id, org_id, doc_type, doc_id, doc_ref, project_id, project_ref, customer_name, revision, digest, amount_cents, prepared_by_email, assigned_to_email, assigned_at, due_at)
    values (p_id, p_org, p_doc_type, p_doc_id, p_doc_ref, p_project_id, p_project_ref, p_customer, v_rev, p_digest, p_amount, lower(p_prepared_by), lower(p_assigned_to), case when p_assigned_to is null then null else clock_timestamp() end, p_due_at)
    returning * into v_new;
  v_ev := approval_event(v_new, case when v_rev > 1 then 'RESUBMITTED' else 'SUBMITTED' end, null, 'PENDING', p_actor, p_actor_name, null);
  if p_assigned_to is not null then perform approval_event(v_new, 'ASSIGNED', 'PENDING', 'PENDING', p_actor, p_actor_name, p_assigned_to); end if;
  perform approval_enqueue(p_org, v_new.id, v_ev, p_notifications);
  return v_new;
end;
$$;

-- ── decide: APPROVE | RETURN | REJECT | WITHDRAW. One transaction: lock, verify state/version/digest/separation, update, event, notifications ──
create or replace function approval_decide(
  p_org uuid, p_request uuid, p_action text, p_actor text, p_actor_name text, p_reason text, p_expected_version integer, p_expected_digest text, p_override boolean, p_notifications jsonb
) returns approval_requests language plpgsql set search_path = public as $$
declare v approval_requests; v_to text; v_ev uuid; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if p_action not in ('APPROVE', 'RETURN', 'REJECT', 'WITHDRAW') then raise exception 'approval: unknown action %', p_action; end if;
  select * into v from approval_requests where id = p_request and org_id = p_org for update;
  if not found then raise exception 'approval: request not found'; end if;
  if v.status <> 'PENDING' then raise exception 'approval_not_pending: this submission is already %', v.status; end if;
  if v.version <> p_expected_version then raise exception 'approval_stale: the submission changed (version % vs %); reload and review again', v.version, p_expected_version; end if;
  if v.digest <> p_expected_digest then raise exception 'approval_stale: the submitted content is not what was reviewed'; end if;
  if p_action in ('RETURN', 'REJECT') and (v_reason is null or length(v_reason) < 3) then raise exception 'approval: a written reason is required to return or reject'; end if;
  if p_action = 'APPROVE' and lower(p_actor) = v.prepared_by_email then
    if not coalesce(p_override, false) then raise exception 'approval_separation: you prepared this submission and cannot approve it without an administrator override'; end if;
    if v_reason is null or length(v_reason) < 10 then raise exception 'approval: an override needs a written reason (at least a short sentence)'; end if;
  end if;
  v_to := case p_action when 'APPROVE' then 'APPROVED' when 'RETURN' then 'RETURNED' when 'REJECT' then 'REJECTED' else 'WITHDRAWN' end;
  update approval_requests set status = v_to, closed_at = clock_timestamp(), version = version + 1,
      decided_by_email = case when p_action = 'WITHDRAW' then null else lower(p_actor) end, decided_by_name = case when p_action = 'WITHDRAW' then null else p_actor_name end,
      decided_at = case when p_action = 'WITHDRAW' then null else clock_timestamp() end,
      decision_reason = v_reason, admin_override = (p_action = 'APPROVE' and lower(p_actor) = v.prepared_by_email)
    where id = v.id returning * into v;
  v_ev := approval_event(v, case when v.admin_override then 'OVERRIDE_APPROVED' else v_to end, 'PENDING', v_to, p_actor, p_actor_name, v_reason);
  perform approval_enqueue(p_org, v.id, v_ev, p_notifications);
  return v;
end;
$$;

create or replace function approval_reassign(p_org uuid, p_request uuid, p_new text, p_actor text, p_actor_name text, p_expected_version integer, p_notifications jsonb)
returns approval_requests language plpgsql set search_path = public as $$
declare v approval_requests; v_old text; v_ev uuid;
begin
  select * into v from approval_requests where id = p_request and org_id = p_org for update;
  if not found then raise exception 'approval: request not found'; end if;
  if v.status <> 'PENDING' then raise exception 'approval_not_pending: this submission is already %', v.status; end if;
  if v.version <> p_expected_version then raise exception 'approval_stale: the submission changed; reload and try again'; end if;
  v_old := v.assigned_to_email;
  update approval_requests set assigned_to_email = lower(p_new), assigned_at = clock_timestamp(), version = version + 1, reminders_sent = 0, last_reminder_at = null where id = v.id returning * into v;
  v_ev := approval_event(v, 'REASSIGNED', 'PENDING', 'PENDING', p_actor, p_actor_name, coalesce(v_old, '(unassigned)') || ' -> ' || lower(p_new));
  perform approval_enqueue(p_org, v.id, v_ev, p_notifications);
  return v;
end;
$$;

-- first view by the assigned approver, recorded once
create or replace function approval_mark_viewed(p_org uuid, p_request uuid, p_actor text, p_actor_name text) returns void language plpgsql set search_path = public as $$
declare v approval_requests;
begin
  select * into v from approval_requests where id = p_request and org_id = p_org for update;
  if not found or v.status <> 'PENDING' or v.first_viewed_at is not null or lower(p_actor) = v.prepared_by_email then return; end if;
  update approval_requests set first_viewed_at = clock_timestamp() where id = v.id returning * into v;
  perform approval_event(v, 'VIEWED', 'PENDING', 'PENDING', p_actor, p_actor_name, null);
end;
$$;

-- an overdue reminder: increments the counter and appends the event in one step (a stale counter = no second reminder)
create or replace function approval_record_reminder(p_org uuid, p_request uuid, p_expected_reminders integer, p_notifications jsonb) returns boolean language plpgsql set search_path = public as $$
declare v approval_requests; v_ev uuid;
begin
  select * into v from approval_requests where id = p_request and org_id = p_org for update;
  if not found or v.status <> 'PENDING' or v.reminders_sent <> p_expected_reminders then return false; end if;
  update approval_requests set reminders_sent = reminders_sent + 1, last_reminder_at = clock_timestamp() where id = v.id returning * into v;
  v_ev := approval_event(v, 'REMINDER_SENT', 'PENDING', 'PENDING', 'system', 'System', 'Reminder ' || v.reminders_sent);
  perform approval_enqueue(p_org, v.id, v_ev, p_notifications);
  return true;
end;
$$;

-- ── access ───────────────────────────────────────────────────────────────────
alter table approval_settings enable row level security;
alter table approval_requests enable row level security;
alter table approval_events enable row level security;
alter table approval_notifications enable row level security;
create policy "org members read approval_requests" on approval_requests for select using (is_org_member(org_id));
create policy "org members read approval_events" on approval_events for select using (is_org_member(org_id));
create policy "org admins read approval_settings" on approval_settings for select using (is_org_admin(org_id));
-- a notification is visible only to its recipient
create policy "recipients read approval_notifications" on approval_notifications for select using (is_org_member(org_id) and recipient_email = lower(coalesce(auth.jwt() ->> 'email', '')));
-- All writes go through the service role (server actions) and the functions above; no insert/update/delete policies are granted.
revoke all on approval_settings, approval_requests, approval_events, approval_notifications from anon, authenticated;
grant select on approval_settings, approval_requests, approval_events, approval_notifications to authenticated;

revoke all on function approval_requests_guard(), approval_append_only_guard(), approval_notifications_guard() from public, anon, authenticated;
revoke all on function approval_enqueue(uuid, uuid, uuid, jsonb), approval_event(approval_requests, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function approval_submit(uuid, uuid, text, uuid, text, uuid, text, text, text, bigint, text, text, timestamptz, text, text, jsonb) from public, anon, authenticated;
revoke all on function approval_decide(uuid, uuid, text, text, text, text, integer, text, boolean, jsonb) from public, anon, authenticated;
revoke all on function approval_reassign(uuid, uuid, text, text, text, integer, jsonb) from public, anon, authenticated;
revoke all on function approval_mark_viewed(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function approval_record_reminder(uuid, uuid, integer, jsonb) from public, anon, authenticated;
