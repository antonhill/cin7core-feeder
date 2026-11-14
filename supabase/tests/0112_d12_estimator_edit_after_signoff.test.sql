-- Transactional test (BEGIN/ROLLBACK, leaves no rows) for D-12 against the REAL staged approval functions of migration 0112.
-- Scenario: the Estimator signed off (ESTIMATOR stage APPROVED, MANAGER stage PENDING), then the content changes. The application re-submits the new content at the ESTIMATOR stage. The database must:
--   * supersede the pending MANAGER-stage request (append-only history kept) and open exactly ONE new PENDING request, at the ESTIMATOR stage, as the next revision;
--   * refuse any decision on the superseded request (a Manager can no longer approve the OLD content);
--   * leave the earlier APPROVED estimator-stage record untouched;
--   * let the Estimator sign off the new content, a manager-stage request follow, and the Manager approve it.
-- It runs the real functions; nothing here is an emulation. (Hosted verification of the same flow with real sessions is step 12 of docs/newquip-ux006-hosted-uat-runsheet.md.)
begin;

create or replace function pg_temp.expect_error(sql text, pattern text, label text) returns void language plpgsql as $$
declare m text;
begin
  begin execute sql; exception when others then get stacked diagnostics m = message_text;
    if m !~ pattern then raise exception 'WRONG ERROR for %: got [%] expected /%/', label, m, pattern; end if; return; end;
  raise exception 'EXPECTED ERROR but succeeded: %', label;
end $$;
create or replace function pg_temp.expect_denied(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then return; end;
  raise exception 'EXPECTED DENIAL but succeeded: %', label;
end $$;

insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000d12b1', 'D12 Org');

create or replace function pg_temp.sub(req uuid, stage text, d text, prep text, orig text, assignee text) returns approval_requests language sql as $$
  select approval_submit_staged('00000000-0000-0000-0000-0000000d12b1', req, 'QUOTE', '00000000-0000-0000-0000-0000000d12d1', 'NQ-Q-D12', null, null, 'Cust', d, 9000000, prep, orig,
    stage, case stage when 'ESTIMATOR' then 'ESTIMATOR' else 'MANAGER' end, assignee, now() + interval '2 days', prep, 'Preparer',
    jsonb_build_array(jsonb_build_object('kind','SUBMITTED','recipient', coalesce(assignee,'x@x'),'subject','s','body','b')));
$$;
create or replace function pg_temp.dec(req uuid, action text, actor text, reason text, ovr boolean, dest text) returns approval_requests language sql as $$
  select approval_decide_staged('00000000-0000-0000-0000-0000000d12b1', req, action, actor, actor, reason,
    (select version from approval_requests where id = req), (select digest from approval_requests where id = req), ovr, dest, '[]'::jsonb);
$$;

-- Rep submits (ESTIMATOR stage), the Estimator signs off, the Manager-stage request opens on the same content
select pg_temp.sub('00000000-0000-0000-0000-0000000d12e1', 'ESTIMATOR', repeat('a',64), 'rep@x', 'rep@x', 'est@x');
select pg_temp.dec('00000000-0000-0000-0000-0000000d12e1', 'APPROVE', 'est@x', null, false, null);
select pg_temp.sub('00000000-0000-0000-0000-0000000d12e2', 'MANAGER', repeat('a',64), 'est@x', 'rep@x', 'mgr@x');
do $$ begin
  if (select count(*) from approval_requests where doc_id = '00000000-0000-0000-0000-0000000d12d1' and status = 'PENDING') <> 1 then raise exception 'one PENDING (manager stage) after sign-off'; end if;
  if (select stage from approval_requests where status = 'PENDING' and doc_id = '00000000-0000-0000-0000-0000000d12d1') <> 'MANAGER' then raise exception 'the pending request is at the manager stage'; end if;
end $$;

-- THE CONTENT CHANGES after sign-off: the new content is submitted at the ESTIMATOR stage (new digest)
create temp table d12_events_before as select count(*) as n from approval_events where doc_id = '00000000-0000-0000-0000-0000000d12d1';
select pg_temp.sub('00000000-0000-0000-0000-0000000d12e3', 'ESTIMATOR', repeat('b',64), 'rep@x', 'rep@x', 'est@x');
do $$ begin
  if (select status from approval_requests where id = '00000000-0000-0000-0000-0000000d12e2') <> 'SUPERSEDED' then raise exception 'the pending MANAGER request is superseded'; end if;
  if (select status from approval_requests where id = '00000000-0000-0000-0000-0000000d12e1') <> 'APPROVED' then raise exception 'the earlier estimator-stage approval is untouched'; end if;
  if (select count(*) from approval_requests where doc_id = '00000000-0000-0000-0000-0000000d12d1' and status = 'PENDING') <> 1 then raise exception 'exactly one PENDING after the edit'; end if;
  if (select stage from approval_requests where id = '00000000-0000-0000-0000-0000000d12e3') <> 'ESTIMATOR' then raise exception 'the new request is at the ESTIMATOR stage'; end if;
  if (select status from approval_requests where id = '00000000-0000-0000-0000-0000000d12e3') <> 'PENDING' then raise exception 'the new request is PENDING'; end if;
  if (select revision from approval_requests where id = '00000000-0000-0000-0000-0000000d12e3') <> 3 then raise exception 'it is the next revision'; end if;
  if (select count(*) from approval_events where request_id = '00000000-0000-0000-0000-0000000d12e2' and action = 'SUPERSEDED') <> 1 then raise exception 'the supersession is recorded in the history'; end if;
  if (select count(*) from approval_events where doc_id = '00000000-0000-0000-0000-0000000d12d1') <= (select n from d12_events_before) then raise exception 'history only grows'; end if;
end $$;

-- a Manager can no longer approve (or return) the OLD content
select pg_temp.expect_error($q$select approval_decide_staged('00000000-0000-0000-0000-0000000d12b1', '00000000-0000-0000-0000-0000000d12e2', 'APPROVE', 'mgr@x', 'M', null, 2, repeat('a',64), false, null, '[]')$q$, 'approval_not_pending', 'the superseded manager request cannot be approved');
select pg_temp.expect_error($q$select approval_decide_staged('00000000-0000-0000-0000-0000000d12b1', '00000000-0000-0000-0000-0000000d12e2', 'RETURN', 'mgr@x', 'M', 'too late to return', 2, repeat('a',64), false, 'ESTIMATOR', '[]')$q$, 'approval_not_pending', 'the superseded manager request cannot be returned');

-- the Estimator re-signs the new content, the manager stage follows, and the Manager (not the preparer / originator) approves it
select pg_temp.dec('00000000-0000-0000-0000-0000000d12e3', 'APPROVE', 'est@x', null, false, null);
select pg_temp.sub('00000000-0000-0000-0000-0000000d12e4', 'MANAGER', repeat('b',64), 'est@x', 'rep@x', 'mgr@x');
select pg_temp.dec('00000000-0000-0000-0000-0000000d12e4', 'APPROVE', 'mgr@x', null, false, null);
do $$ begin
  if (select status from approval_requests where id = '00000000-0000-0000-0000-0000000d12e4') <> 'APPROVED' then raise exception 'the Manager approves the re-signed content'; end if;
  if (select count(*) from approval_requests where doc_id = '00000000-0000-0000-0000-0000000d12d1' and status = 'PENDING') <> 0 then raise exception 'nothing is left pending'; end if;
  if (select array_agg(stage || ':' || status order by revision) from approval_requests where doc_id = '00000000-0000-0000-0000-0000000d12d1')
     <> array['ESTIMATOR:APPROVED', 'MANAGER:SUPERSEDED', 'ESTIMATOR:APPROVED', 'MANAGER:APPROVED'] then raise exception 'the full request trail is kept in order'; end if;
end $$;

-- the history stays append-only
select pg_temp.expect_denied($q$update approval_events set reason = 'x' where doc_id = '00000000-0000-0000-0000-0000000d12d1'$q$, 'approval history is append-only (update)');
select pg_temp.expect_denied($q$delete from approval_events where doc_id = '00000000-0000-0000-0000-0000000d12d1'$q$, 'approval history is append-only (delete)');

select 'OK: D-12 estimator edit after sign-off (real staged functions)' as result;
rollback;
