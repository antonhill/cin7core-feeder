-- Transactional test for migration 0112 (functional roles, approval policies, staged approvals). BEGIN/ROLLBACK - leaves no rows.
-- Covers: role assignment + immutable history, policy validation, staged submit (estimator -> manager), exact digest/version, separation of duties for
-- the preparer AND the originator, override rules, return destinations, stage immutability, one PENDING per document, 0110 functions still working, RLS.
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

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000012a1'), ('00000000-0000-0000-0000-0000000012a2'), ('00000000-0000-0000-0000-0000000012a3');
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000012b1', 'SR Org A'), ('00000000-0000-0000-0000-0000000012b2', 'SR Org B');
insert into org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000012b1', '00000000-0000-0000-0000-0000000012a1', 'member'),
  ('00000000-0000-0000-0000-0000000012b1', '00000000-0000-0000-0000-0000000012a2', 'admin'),
  ('00000000-0000-0000-0000-0000000012b2', '00000000-0000-0000-0000-0000000012a3', 'member');

-- ── roles ──
select org_role_assign('00000000-0000-0000-0000-0000000012b1', '00000000-0000-0000-0000-0000000012a1', 'Est@X', 'ESTIMATOR', 'Admin@X');
select org_role_assign('00000000-0000-0000-0000-0000000012b1', '00000000-0000-0000-0000-0000000012a2', 'mgr@x', 'MANAGER', 'admin@x');
do $$ begin
  if (select count(*) from org_functional_roles) <> 2 then raise exception 'two role rows'; end if;
  if (select user_email from org_functional_roles where role = 'ESTIMATOR') <> 'est@x' then raise exception 'emails are lower-cased'; end if;
  if org_role_assign('00000000-0000-0000-0000-0000000012b1', '00000000-0000-0000-0000-0000000012a1', 'est@x', 'ESTIMATOR', 'admin@x') then raise exception 'a duplicate assignment must report false'; end if;
  if (select count(*) from org_functional_role_events) <> 2 then raise exception 'a duplicate assignment writes no history'; end if;
end $$;
select pg_temp.expect_error($q$select org_role_assign('00000000-0000-0000-0000-0000000012b1', '00000000-0000-0000-0000-0000000012a3', 'x@y', 'MANAGER', 'admin@x')$q$, 'not a member', 'a user of another organisation cannot be given a role');
select pg_temp.expect_denied($q$insert into org_functional_roles (org_id, user_id, user_email, role, assigned_by_email) values ('00000000-0000-0000-0000-0000000012b1','00000000-0000-0000-0000-0000000012a1','a@b','SUPERUSER','x')$q$, 'unknown role');
select org_role_remove('00000000-0000-0000-0000-0000000012b1', '00000000-0000-0000-0000-0000000012a1', 'ESTIMATOR', 'admin@x');
do $$ begin
  if (select count(*) from org_functional_roles) <> 1 then raise exception 'role removed'; end if;
  if (select array_agg(action order by created_at) from org_functional_role_events where role = 'ESTIMATOR') <> array['ASSIGNED', 'REMOVED'] then raise exception 'history keeps both events'; end if;
end $$;
select pg_temp.expect_denied($q$update org_functional_role_events set actor_email = 'z'$q$, 'role history is append-only (update)');
select pg_temp.expect_denied($q$delete from org_functional_role_events$q$, 'role history is append-only (delete)');
select org_role_assign('00000000-0000-0000-0000-0000000012b1', '00000000-0000-0000-0000-0000000012a1', 'est@x', 'ESTIMATOR', 'admin@x');

-- ── policies ──
select approval_policy_save('00000000-0000-0000-0000-0000000012b1', 'QUOTE', '[{"stage":"ESTIMATOR","role":"ESTIMATOR","approverEmail":"est@x"},{"stage":"MANAGER","role":"MANAGER","approverEmail":null}]', 'admin@x');
select approval_policy_save('00000000-0000-0000-0000-0000000012b1', 'QUOTE', '[{"stage":"ESTIMATOR","role":"ESTIMATOR","approverEmail":null},{"stage":"MANAGER","role":"MANAGER","approverEmail":"mgr@x"}]', 'admin@x');
do $$ begin
  if (select version from approval_policies where doc_type = 'QUOTE') <> 2 then raise exception 'policy is versioned'; end if;
  if (select count(*) from approval_policy_events) <> 2 then raise exception 'every save is logged'; end if;
end $$;
select pg_temp.expect_error($q$select approval_policy_save('00000000-0000-0000-0000-0000000012b1', 'QUOTE', '[{"stage":"MANAGER","role":"MANAGER","approverEmail":null}]', 'a@x')$q$, 'estimator stage', 'the estimator stage of a quotation cannot be removed');
select pg_temp.expect_error($q$select approval_policy_save('00000000-0000-0000-0000-0000000012b1', 'CLAIM', '[{"stage":"ESTIMATOR","role":"ESTIMATOR","approverEmail":null},{"stage":"MANAGER","role":"MANAGER","approverEmail":null}]', 'a@x')$q$, 'single manager stage', 'a claim has one stage');
select pg_temp.expect_error($q$select approval_policy_save('00000000-0000-0000-0000-0000000012b1', 'CLAIM', '[{"stage":"MANAGER","role":"GOD","approverEmail":null}]', 'a@x')$q$, 'unknown role', 'unknown role refused');

-- ── staged approvals: estimator stage -> manager stage ──
create or replace function pg_temp.sub(req uuid, stage text, d text, prep text, orig text, assignee text) returns approval_requests language sql as $$
  select approval_submit_staged('00000000-0000-0000-0000-0000000012b1', req, 'QUOTE', '00000000-0000-0000-0000-0000000012d1', 'NQ-Q-0001', null, null, 'Cust', d, 9000000, prep, orig,
    stage, case stage when 'ESTIMATOR' then 'ESTIMATOR' else 'MANAGER' end, assignee, now() + interval '2 days', prep, 'Preparer',
    jsonb_build_array(jsonb_build_object('kind','SUBMITTED','recipient', coalesce(assignee,'x@x'),'subject','s','body','b')));
$$;
create or replace function pg_temp.dec(req uuid, action text, actor text, reason text, ovr boolean, dest text) returns approval_requests language sql as $$
  select approval_decide_staged('00000000-0000-0000-0000-0000000012b1', req, action, actor, actor, reason,
    (select version from approval_requests where id = req), (select digest from approval_requests where id = req), ovr, dest, '[]'::jsonb);
$$;

select pg_temp.sub('00000000-0000-0000-0000-00000000e001', 'ESTIMATOR', repeat('a',64), 'rep@x', 'rep@x', 'est@x');
do $$ begin
  if (select stage from approval_requests where id = '00000000-0000-0000-0000-00000000e001') <> 'ESTIMATOR' then raise exception 'estimator-stage request'; end if;
  if (select originator_email from approval_requests where id = '00000000-0000-0000-0000-00000000e001') <> 'rep@x' then raise exception 'originator recorded'; end if;
  if (select assigned_to_email from approval_requests where id = '00000000-0000-0000-0000-00000000e001') <> 'est@x' then raise exception 'named assignee recorded'; end if;
end $$;
-- the estimator cannot return it "to the estimator", and the rep cannot sign off their own handoff without an override
select pg_temp.expect_error($q$select pg_temp.dec('00000000-0000-0000-0000-00000000e001', 'RETURN', 'est@x', 'wrong qty', false, 'ESTIMATOR')$q$, 'only a quotation in manager review', 'return-to-estimator is only a manager-stage move');
select pg_temp.expect_error($q$select pg_temp.dec('00000000-0000-0000-0000-00000000e001', 'APPROVE', 'rep@x', null, false, null)$q$, 'approval_separation', 'the originating rep cannot sign off');
select pg_temp.expect_error($q$select pg_temp.dec('00000000-0000-0000-0000-00000000e001', 'APPROVE', 'rep@x', 'short', true, null)$q$, 'override needs a written reason', 'an override needs a real reason');
-- a normal estimator sign-off
select pg_temp.dec('00000000-0000-0000-0000-00000000e001', 'APPROVE', 'est@x', null, false, null);
do $$ begin
  if (select status from approval_requests where id = '00000000-0000-0000-0000-00000000e001') <> 'APPROVED' then raise exception 'estimator stage approved'; end if;
  if (select admin_override from approval_requests where id = '00000000-0000-0000-0000-00000000e001') then raise exception 'a normal sign-off is not an override'; end if;
end $$;
select pg_temp.expect_error($q$select pg_temp.dec('00000000-0000-0000-0000-00000000e001', 'APPROVE', 'est@x', null, false, null)$q$, 'not_pending', 'a second decision is refused');

-- manager stage for the SAME content, prepared by the estimator
select pg_temp.sub('00000000-0000-0000-0000-00000000e002', 'MANAGER', repeat('a',64), 'est@x', 'rep@x', 'mgr@x');
do $$ begin
  if (select count(*) from approval_requests where doc_id = '00000000-0000-0000-0000-0000000012d1' and status = 'PENDING') <> 1 then raise exception 'one PENDING request per document'; end if;
  if (select revision from approval_requests where id = '00000000-0000-0000-0000-00000000e002') <> 2 then raise exception 'second request is revision 2'; end if;
end $$;
do $$ begin
  -- the first request at a NEW stage is a SUBMITTED event (not a re-submission); a second request at the same stage is RESUBMITTED
  if (select action from approval_events where request_id = '00000000-0000-0000-0000-00000000e002' and action in ('SUBMITTED', 'RESUBMITTED')) <> 'SUBMITTED' then raise exception 'first manager-stage request is SUBMITTED'; end if;
end $$;
-- the estimator who signed off cannot approve as manager, and neither can the originating rep; both are separate from an explicit, reasoned override
select pg_temp.expect_error($q$select pg_temp.dec('00000000-0000-0000-0000-00000000e002', 'APPROVE', 'est@x', null, false, null)$q$, 'approval_separation', 'estimator cannot also be the approving manager');
select pg_temp.expect_error($q$select pg_temp.dec('00000000-0000-0000-0000-00000000e002', 'APPROVE', 'rep@x', null, false, null)$q$, 'approval_separation', 'originating rep cannot approve');
-- stale protection: a changed digest is refused
select pg_temp.expect_error($q$select approval_decide_staged('00000000-0000-0000-0000-0000000012b1', '00000000-0000-0000-0000-00000000e002', 'APPROVE', 'mgr@x', 'M', null, 1, repeat('b',64), false, null, '[]')$q$, 'approval_stale', 'a different digest is stale');
select pg_temp.expect_error($q$select approval_decide_staged('00000000-0000-0000-0000-0000000012b1', '00000000-0000-0000-0000-00000000e002', 'APPROVE', 'mgr@x', 'M', null, 99, repeat('a',64), false, null, '[]')$q$, 'approval_stale', 'a wrong version is stale');
-- manager returns it to the ESTIMATOR: reason required, destination recorded in the request and the history
select pg_temp.expect_error($q$select pg_temp.dec('00000000-0000-0000-0000-00000000e002', 'RETURN', 'mgr@x', null, false, 'ESTIMATOR')$q$, 'written reason', 'a return needs a reason');
select pg_temp.dec('00000000-0000-0000-0000-00000000e002', 'RETURN', 'mgr@x', 'Margin looks too thin on the feeders', false, 'ESTIMATOR');
do $$ begin
  if (select return_destination from approval_requests where id = '00000000-0000-0000-0000-00000000e002') <> 'ESTIMATOR' then raise exception 'destination stored'; end if;
  if (select destination from approval_events where request_id = '00000000-0000-0000-0000-00000000e002' and action = 'RETURNED') <> 'ESTIMATOR' then raise exception 'destination in history'; end if;
  if (select stage from approval_events where request_id = '00000000-0000-0000-0000-00000000e002' and action = 'RETURNED') <> 'MANAGER' then raise exception 'stage in history'; end if;
end $$;
-- the estimator re-signs a corrected revision (new digest) and the manager approves with an override of their own preparation: allowed only with a reason
select pg_temp.sub('00000000-0000-0000-0000-00000000e003', 'ESTIMATOR', repeat('c',64), 'rep@x', 'rep@x', 'est@x');
select pg_temp.dec('00000000-0000-0000-0000-00000000e003', 'APPROVE', 'est@x', null, false, null);
select pg_temp.sub('00000000-0000-0000-0000-00000000e004', 'MANAGER', repeat('c',64), 'est@x', 'rep@x', null);
select pg_temp.dec('00000000-0000-0000-0000-00000000e004', 'APPROVE', 'est@x', 'Sole administrator approving while the manager is away', true, null);
do $$ begin
  if not (select admin_override from approval_requests where id = '00000000-0000-0000-0000-00000000e004') then raise exception 'override flagged'; end if;
  if (select count(*) from approval_events where request_id = '00000000-0000-0000-0000-00000000e004' and action = 'OVERRIDE_APPROVED') <> 1 then raise exception 'override recorded as such'; end if;
  -- an override on the manager stage does NOT touch the estimator stage's own record
  if (select admin_override from approval_requests where id = '00000000-0000-0000-0000-00000000e003') then raise exception 'overrides do not leak across stages'; end if;
end $$;

-- a changed digest at the same stage supersedes the pending request (never two PENDING)
select pg_temp.sub('00000000-0000-0000-0000-00000000e005', 'ESTIMATOR', repeat('d',64), 'rep@x', 'rep@x', 'est@x');
select pg_temp.sub('00000000-0000-0000-0000-00000000e006', 'ESTIMATOR', repeat('e',64), 'rep@x', 'rep@x', 'est@x');
do $$ begin
  if (select status from approval_requests where id = '00000000-0000-0000-0000-00000000e005') <> 'SUPERSEDED' then raise exception 'older pending submission superseded'; end if;
  if (select count(*) from approval_requests where doc_id = '00000000-0000-0000-0000-0000000012d1' and status = 'PENDING') <> 1 then raise exception 'exactly one PENDING'; end if;
  -- identical re-submission at the same stage is idempotent
  if (select id from pg_temp.sub('00000000-0000-0000-0000-00000000e007', 'ESTIMATOR', repeat('e',64), 'rep@x', 'rep@x', 'est@x')) <> '00000000-0000-0000-0000-00000000e006' then raise exception 'idempotent re-submission'; end if;
end $$;

-- the same content submitted at a DIFFERENT stage is a new request, never mistaken for the pending one
select pg_temp.sub('00000000-0000-0000-0000-00000000e008', 'MANAGER', repeat('e',64), 'est@x', 'rep@x', null);
do $$ begin
  if (select status from approval_requests where id = '00000000-0000-0000-0000-00000000e006') <> 'SUPERSEDED' then raise exception 'a pending estimator request is superseded by the manager-stage request'; end if;
  if (select stage from approval_requests where id = '00000000-0000-0000-0000-00000000e008') <> 'MANAGER' then raise exception 'manager-stage request created'; end if;
  if (select count(*) from approval_requests where doc_id = '00000000-0000-0000-0000-0000000012d1' and status = 'PENDING') <> 1 then raise exception 'still exactly one PENDING'; end if;
end $$;

-- stage / preparer / originator are immutable; history is append-only
select pg_temp.expect_denied($q$update approval_requests set stage = 'ESTIMATOR' where id = '00000000-0000-0000-0000-00000000e008'$q$, 'stage is immutable');
select pg_temp.expect_denied($q$update approval_requests set originator_email = 'z@z' where id = '00000000-0000-0000-0000-00000000e008'$q$, 'originator is immutable');
select pg_temp.expect_denied($q$update approval_events set reason = 'x'$q$, 'approval history is append-only');

-- the 0110 functions are untouched and still work
select approval_submit('00000000-0000-0000-0000-0000000012b1', '00000000-0000-0000-0000-00000000f001', 'CLAIM', '00000000-0000-0000-0000-0000000012d2', 'PRJ-1 claim #01', null, 'PRJ-1', 'Cust', repeat('f',64), 100, 'pm@x', null, null, 'pm@x', 'PM', '[]'::jsonb);
do $$ begin
  if (select stage from approval_requests where id = '00000000-0000-0000-0000-00000000f001') <> 'MANAGER' then raise exception 'legacy requests default to the manager stage'; end if;
end $$;
select approval_decide('00000000-0000-0000-0000-0000000012b1', '00000000-0000-0000-0000-00000000f001', 'APPROVE', 'mgr@x', 'M', null, 1, repeat('f',64), false, '[]'::jsonb);

-- RLS: members read their own organisation only; no client writes; role history is admin-only
select pg_temp.act_as('00000000-0000-0000-0000-0000000012a1', 'est@x');
do $$ begin
  if (select count(*) from org_functional_roles) <> 2 then raise exception 'a member sees only their own organisation roles'; end if;
  if (select count(*) from approval_policies) <> 1 then raise exception 'a member reads their own policy'; end if;
  if (select count(*) from org_functional_role_events) <> 0 then raise exception 'role history is admin-only'; end if;
end $$;
select pg_temp.expect_denied($q$insert into org_functional_roles (org_id, user_id, user_email, role, assigned_by_email) values ('00000000-0000-0000-0000-0000000012b1','00000000-0000-0000-0000-0000000012a1','a@b','MANAGER','x')$q$, 'a member cannot grant themselves a role');
select pg_temp.expect_denied($q$select org_role_assign('00000000-0000-0000-0000-0000000012b1', '00000000-0000-0000-0000-0000000012a1', 'a@b', 'MANAGER', 'a@b')$q$, 'role functions are not callable by clients');
select pg_temp.expect_denied($q$select approval_decide_staged('00000000-0000-0000-0000-0000000012b1', '00000000-0000-0000-0000-00000000e008', 'APPROVE', 'a@b', 'x', null, 1, repeat('e',64), false, null, '[]')$q$, 'staged decide is not callable by clients');
select pg_temp.reset_role();

select 'OK: 0112 roles and staged approvals' as result;
rollback;
