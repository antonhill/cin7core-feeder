-- Transactional test for migration 0110 (commercial approvals). BEGIN/ROLLBACK - leaves no rows.
-- Covers: submit/resubmit/supersede, exact digest + version checks, reason rules, separation of duties + override, duplicate decisions, append-only
-- history, notification dedupe, one PENDING per document, org isolation, grants and RLS.
begin;

create or replace function pg_temp.act_as(uid uuid, mail text) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'email', mail)::text, true);
end $$;
create or replace function pg_temp.reset_role() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); end $$;
create or replace function pg_temp.expect_denied(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then return; end;
  raise exception 'EXPECTED DENIAL but succeeded: %', label;
end $$;
create or replace function pg_temp.expect_error(sql text, pattern text, label text) returns void language plpgsql as $$
declare m text;
begin
  begin execute sql; exception when others then get stacked diagnostics m = message_text;
    if m !~ pattern then raise exception 'WRONG ERROR for %: got [%] expected /%/', label, m, pattern; end if; return; end;
  raise exception 'EXPECTED ERROR but succeeded: %', label;
end $$;

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000010a1'), ('00000000-0000-0000-0000-0000000010a2');
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000010b1', 'AP Org A'), ('00000000-0000-0000-0000-0000000010b2', 'AP Org B');
insert into org_members (org_id, user_id, role) values ('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-0000000010a1', 'member'), ('00000000-0000-0000-0000-0000000010b2', '00000000-0000-0000-0000-0000000010a2', 'member');

-- helper: submit a claim revision (digest d)
create or replace function pg_temp.submit(req uuid, org uuid, doc uuid, d text, prep text, assignee text) returns approval_requests language sql as $$
  select approval_submit(org, req, 'CLAIM', doc, 'PRJ-1 claim #02', null, 'PRJ-1', 'Cust', d, 5000000, prep, assignee, now() + interval '2 days', prep, 'Preparer',
    jsonb_build_array(jsonb_build_object('kind','SUBMITTED','recipient', coalesce(assignee,'mgr@x'),'subject','s','body','b')));
$$;

select pg_temp.submit('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000d001', repeat('a',64), 'Prep@X', 'mgr@x');
do $$ begin
  if (select count(*) from approval_requests) <> 1 then raise exception 'one request'; end if;
  if (select revision from approval_requests) <> 1 then raise exception 'revision 1'; end if;
  if (select prepared_by_email from approval_requests) <> 'prep@x' then raise exception 'emails are normalised to lower case'; end if;
  if (select array_agg(action order by created_at) from approval_events) <> array['SUBMITTED','ASSIGNED'] then raise exception 'events SUBMITTED + ASSIGNED, got %', (select array_agg(action) from approval_events); end if;
  if (select count(*) from approval_notifications) <> 2 then raise exception 'an IN_APP and an EMAIL notification'; end if;
  if (select status from approval_notifications where channel = 'IN_APP') <> 'SENT' then raise exception 'in-app is delivered immediately'; end if;
  if (select status from approval_notifications where channel = 'EMAIL') <> 'PENDING' then raise exception 'email is NOT sent until a provider accepts it'; end if;
end $$;

-- identical resubmission is idempotent: no new request, no new events, no duplicate notifications
select pg_temp.submit('00000000-0000-0000-0000-00000000c0ff', '00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000d001', repeat('a',64), 'prep@x', 'mgr@x');
do $$ begin
  if (select count(*) from approval_requests) <> 1 or (select count(*) from approval_events) <> 2 or (select count(*) from approval_notifications) <> 2 then raise exception 'identical submit must be a no-op'; end if;
end $$;

-- a second PENDING for the same document cannot be inserted directly either
select pg_temp.expect_denied($$insert into approval_requests (id, org_id, doc_type, doc_id, doc_ref, revision, digest, amount_cents, prepared_by_email) values (gen_random_uuid(), '00000000-0000-0000-0000-0000000010b1', 'CLAIM', '00000000-0000-0000-0000-00000000d001', 'x', 9, repeat('b',64), 1, 'p@x')$$, 'two pending requests for one document');

-- stale decisions: wrong version, wrong digest
select pg_temp.expect_error($$select approval_decide('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000c001', 'APPROVE', 'mgr@x', 'Mgr', null, 99, repeat('a',64), false, '[]')$$, 'approval_stale', 'stale version');
select pg_temp.expect_error($$select approval_decide('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000c001', 'APPROVE', 'mgr@x', 'Mgr', null, 1, repeat('f',64), false, '[]')$$, 'approval_stale', 'stale digest (document changed)');
-- reasons
select pg_temp.expect_error($$select approval_decide('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000c001', 'RETURN', 'mgr@x', 'Mgr', ' ', 1, repeat('a',64), false, '[]')$$, 'written reason', 'return needs a reason');
select pg_temp.expect_error($$select approval_decide('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000c001', 'REJECT', 'mgr@x', 'Mgr', '', 1, repeat('a',64), false, '[]')$$, 'written reason', 'reject needs a reason');
-- separation of duties: the preparer cannot approve; an override needs a real reason
select pg_temp.expect_error($$select approval_decide('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000c001', 'APPROVE', 'PREP@x', 'Prep', null, 1, repeat('a',64), false, '[]')$$, 'approval_separation', 'self approval');
select pg_temp.expect_error($$select approval_decide('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000c001', 'APPROVE', 'prep@x', 'Prep', 'ok', 1, repeat('a',64), true, '[]')$$, 'override needs a written reason', 'override without a real reason');
-- other organisation cannot decide it
select pg_temp.expect_error($$select approval_decide('00000000-0000-0000-0000-0000000010b2', '00000000-0000-0000-0000-00000000c001', 'APPROVE', 'mgr@x', 'Mgr', null, 1, repeat('a',64), false, '[]')$$, 'not found', 'cross-organisation decision');

-- RETURN with a reason, then revise + resubmit (revision 2)
select approval_decide('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000c001', 'RETURN', 'mgr@x', 'Mgr', 'Please recheck the stage values', 1, repeat('a',64), false,
  jsonb_build_array(jsonb_build_object('kind','RETURNED','recipient','prep@x','subject','s','body','b')));
select pg_temp.expect_error($$select approval_decide('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000c001', 'APPROVE', 'mgr@x', 'Mgr', null, 2, repeat('a',64), false, '[]')$$, 'approval_not_pending', 'a returned submission cannot be approved');
select pg_temp.submit('00000000-0000-0000-0000-00000000c002', '00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000d001', repeat('b',64), 'prep@x', 'mgr@x');
do $$ begin
  if (select revision from approval_requests where id = '00000000-0000-0000-0000-00000000c002') <> 2 then raise exception 'resubmission is revision 2'; end if;
  if (select status from approval_requests where id = '00000000-0000-0000-0000-00000000c001') <> 'RETURNED' then raise exception 'revision 1 stays RETURNED'; end if;
  if not exists (select 1 from approval_events where request_id = '00000000-0000-0000-0000-00000000c002' and action = 'RESUBMITTED') then raise exception 'RESUBMITTED event'; end if;
end $$;

-- a changed document submitted while the previous revision is still pending SUPERSEDES it
select pg_temp.submit('00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000d001', repeat('c',64), 'prep@x', 'mgr@x');
do $$ begin
  if (select status from approval_requests where id = '00000000-0000-0000-0000-00000000c002') <> 'SUPERSEDED' then raise exception 'rev 2 superseded'; end if;
  if (select count(*) from approval_requests where status = 'PENDING') <> 1 then raise exception 'exactly one pending'; end if;
end $$;
select pg_temp.expect_error($$select approval_decide('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000c002', 'APPROVE', 'mgr@x', 'Mgr', null, 2, repeat('b',64), false, '[]')$$, 'approval_not_pending', 'a superseded submission cannot be approved');

-- APPROVE by a different user; second (duplicate) approve is refused and creates nothing extra
select approval_decide('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000c003', 'APPROVE', 'Mgr@X', 'Mgr', 'ok', 1, repeat('c',64), false,
  jsonb_build_array(jsonb_build_object('kind','APPROVED','recipient','prep@x','subject','s','body','b')));
select pg_temp.expect_error($$select approval_decide('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000c003', 'APPROVE', 'mgr@x', 'Mgr', null, 1, repeat('c',64), false, '[]')$$, 'approval_not_pending', 'duplicate approval');
do $$ begin
  if (select status from approval_requests where id = '00000000-0000-0000-0000-00000000c003') <> 'APPROVED' then raise exception 'approved'; end if;
  if (select decided_at from approval_requests where id = '00000000-0000-0000-0000-00000000c003') is null then raise exception 'decided_at recorded'; end if;
  if (select count(*) from approval_events where request_id = '00000000-0000-0000-0000-00000000c003' and action = 'APPROVED') <> 1 then raise exception 'exactly one APPROVED event'; end if;
  if (select count(*) from approval_notifications where kind = 'APPROVED') <> 2 then raise exception 'one in-app + one email, not duplicated'; end if;
end $$;

-- ADMIN OVERRIDE: self-approval with a real reason is recorded as OVERRIDE_APPROVED
select pg_temp.submit('00000000-0000-0000-0000-00000000c010', '00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000d002', repeat('d',64), 'owner@x', null);
select approval_decide('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000c010', 'APPROVE', 'owner@x', 'Owner', 'Sole administrator approving own test submission during acceptance', 1, repeat('d',64), true, '[]');
do $$ begin
  if not (select admin_override from approval_requests where id = '00000000-0000-0000-0000-00000000c010') then raise exception 'override flag'; end if;
  if not exists (select 1 from approval_events where request_id = '00000000-0000-0000-0000-00000000c010' and action = 'OVERRIDE_APPROVED') then raise exception 'OVERRIDE_APPROVED event'; end if;
end $$;

-- REJECT and WITHDRAW
select pg_temp.submit('00000000-0000-0000-0000-00000000c020', '00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000d003', repeat('e',64), 'prep@x', 'mgr@x');
select approval_decide('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000c020', 'REJECT', 'mgr@x', 'Mgr', 'Not agreed with the customer', 1, repeat('e',64), false, '[]');
select pg_temp.submit('00000000-0000-0000-0000-00000000c030', '00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000d004', repeat('9',64), 'prep@x', 'mgr@x');
select approval_decide('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000c030', 'WITHDRAW', 'prep@x', 'Prep', null, 1, repeat('9',64), false, '[]');
do $$ begin
  if (select status from approval_requests where id = '00000000-0000-0000-0000-00000000c020') <> 'REJECTED' then raise exception 'rejected'; end if;
  if (select status from approval_requests where id = '00000000-0000-0000-0000-00000000c030') <> 'WITHDRAWN' then raise exception 'withdrawn'; end if;
  if (select decided_at from approval_requests where id = '00000000-0000-0000-0000-00000000c030') is not null then raise exception 'a withdrawal is not a decision'; end if;
end $$;

-- reassign + reminder counters (stale reminder counter = no second reminder)
select pg_temp.submit('00000000-0000-0000-0000-00000000c040', '00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000d005', repeat('7',64), 'prep@x', 'mgr@x');
select approval_reassign('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000c040', 'other@x', 'mgr@x', 'Mgr', 1, jsonb_build_array(jsonb_build_object('kind','REASSIGNED','recipient','other@x','subject','s','body','b')));
select pg_temp.expect_error($$select approval_reassign('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000c040', 'x@x', 'mgr@x', 'Mgr', 1, '[]')$$, 'approval_stale', 'reassign with a stale version');
do $$ declare ok1 boolean; ok2 boolean; begin
  select approval_record_reminder('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000c040', 0, jsonb_build_array(jsonb_build_object('kind','REMINDER-1','recipient','other@x','subject','s','body','b'))) into ok1;
  select approval_record_reminder('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000c040', 0, jsonb_build_array(jsonb_build_object('kind','REMINDER-1','recipient','other@x','subject','s','body','b'))) into ok2;
  if not ok1 or ok2 then raise exception 'a reminder is recorded once (%, %)', ok1, ok2; end if;
  if (select count(*) from approval_notifications where kind = 'REMINDER-1') <> 2 then raise exception 'one reminder = one in-app + one email'; end if;
  if (select assigned_to_email from approval_requests where id = '00000000-0000-0000-0000-00000000c040') <> 'other@x' then raise exception 'reassigned'; end if;
end $$;
-- first view recorded once, never by the preparer
select approval_mark_viewed('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000c040', 'prep@x', 'Prep');
select approval_mark_viewed('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000c040', 'other@x', 'Other');
select approval_mark_viewed('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000c040', 'other@x', 'Other');
do $$ begin if (select count(*) from approval_events where request_id = '00000000-0000-0000-0000-00000000c040' and action = 'VIEWED') <> 1 then raise exception 'VIEWED once'; end if; end $$;

-- immutable history / identity
select pg_temp.expect_denied($$update approval_events set reason = 'tampered'$$, 'events are append-only (update)');
select pg_temp.expect_denied($$delete from approval_events$$, 'events are append-only (delete)');
select pg_temp.expect_denied($$delete from approval_requests$$, 'requests are never deleted');
select pg_temp.expect_denied($$update approval_requests set digest = repeat('0',64) where id = '00000000-0000-0000-0000-00000000c040'$$, 'submitted digest is immutable');
select pg_temp.expect_denied($$update approval_requests set amount_cents = 1 where id = '00000000-0000-0000-0000-00000000c040'$$, 'submitted amount is immutable');
select pg_temp.expect_denied($$update approval_requests set status = 'PENDING', closed_at = null where id = '00000000-0000-0000-0000-00000000c003'$$, 'a decided request cannot be reopened');
select pg_temp.expect_denied($$update approval_notifications set body = 'x'$$, 'notification content is immutable');
select pg_temp.expect_denied($$update approval_notifications set status = 'PENDING' where channel = 'IN_APP'$$, 'a sent notification stays sent');
select pg_temp.expect_denied($$insert into approval_notifications (org_id, request_id, kind, recipient_email, channel, subject, body, dedupe_key) select org_id, id, 'APPROVED', 'prep@x', 'EMAIL', 's', 'b', 'APPROVED:' || id || ':prep@x:EMAIL' from approval_requests where id = '00000000-0000-0000-0000-00000000c003'$$, 'duplicate notification (dedupe key)');

-- access: members of A read A only, never B; no direct writes for clients; functions are not callable by clients
select pg_temp.act_as('00000000-0000-0000-0000-0000000010a1', 'prep@x');
do $$ begin
  if (select count(*) from approval_requests) = 0 then raise exception 'a member reads their organisation''s requests'; end if;
  if (select count(*) from approval_requests where org_id = '00000000-0000-0000-0000-0000000010b2') <> 0 then raise exception 'cross-org read'; end if;
  if (select count(*) from approval_notifications where recipient_email <> 'prep@x') <> 0 then raise exception 'a recipient sees only their own notifications'; end if;
  if (select count(*) from approval_notifications) = 0 then raise exception 'recipient sees their notifications'; end if;
end $$;
select pg_temp.expect_denied($$insert into approval_requests (id, org_id, doc_type, doc_id, doc_ref, revision, digest, amount_cents, prepared_by_email) values (gen_random_uuid(), '00000000-0000-0000-0000-0000000010b1', 'CLAIM', gen_random_uuid(), 'x', 1, repeat('b',64), 1, 'p@x')$$, 'client insert');
select pg_temp.expect_denied($$update approval_requests set decision_reason = 'x'$$, 'client update');
select pg_temp.expect_denied($$select approval_decide('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-00000000c040', 'APPROVE', 'prep@x', 'x', null, 3, repeat('7',64), true, '[]')$$, 'client calling approval_decide');
select pg_temp.expect_denied($$select approval_submit('00000000-0000-0000-0000-0000000010b1', gen_random_uuid(), 'CLAIM', gen_random_uuid(), 'x', null, null, null, repeat('b',64), 1, 'p@x', null, null, 'p@x', 'p', '[]')$$, 'client calling approval_submit');
select pg_temp.reset_role();
select pg_temp.act_as('00000000-0000-0000-0000-0000000010a2', 'other@x');
do $$ begin if (select count(*) from approval_requests) <> 0 then raise exception 'org B member must not see org A approvals'; end if; end $$;
select pg_temp.reset_role();

select 'ok' as result;
rollback;
