-- Transactional test for migration 0114 (SUPPRESSED email status). BEGIN/ROLLBACK - leaves no rows.
-- Covers: SUPPRESSED is accepted for an EMAIL row; an unknown status is still refused; a SUPPRESSED row cannot carry sent_at; a SENT row still cannot move.
begin;

create or replace function pg_temp.expect_denied(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then return; end;
  raise exception 'EXPECTED DENIAL but succeeded: %', label;
end $$;

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000114a1');
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000114b1', 'ES Org');
insert into org_members (org_id, user_id, role) values ('00000000-0000-0000-0000-0000000114b1', '00000000-0000-0000-0000-0000000114a1', 'member');

select approval_submit('00000000-0000-0000-0000-0000000114b1', '00000000-0000-0000-0000-0000000114c1', 'CLAIM', '00000000-0000-0000-0000-0000000114d1', 'PRJ-1 claim #02', null, 'PRJ-1', 'Cust', repeat('a',64), 5000000, 'prep@x', 'mgr@x', now() + interval '2 days', 'prep@x', 'Preparer',
  jsonb_build_array(jsonb_build_object('kind','SUBMITTED','recipient','outsider@elsewhere.example','subject','s','body','b')));

do $$ declare n uuid; m uuid; begin
  select id into n from approval_notifications where channel = 'EMAIL' limit 1;
  if n is null then raise exception 'setup: an EMAIL notification must exist'; end if;
  update approval_notifications set status = 'SUPPRESSED', last_error = 'not on the Preview allowlist' where id = n;
  if (select status from approval_notifications where id = n) <> 'SUPPRESSED' then raise exception 'SUPPRESSED must be accepted'; end if;
  begin update approval_notifications set status = 'BOGUS' where id = n; raise exception 'EXPECTED DENIAL: unknown status'; exception when check_violation then null; end;
  begin update approval_notifications set sent_at = now() where id = n; raise exception 'EXPECTED DENIAL: suppressed with sent_at'; exception when check_violation then null; end;
  update approval_notifications set status = 'PENDING', last_error = null where id = n;           -- a re-queue (retry) of a suppressed row is allowed
  update approval_notifications set status = 'SENT', sent_at = now() where id = n;
  begin update approval_notifications set status = 'SUPPRESSED', sent_at = null where id = n; raise exception 'EXPECTED DENIAL: sent stays sent'; exception when others then
    if sqlerrm like 'EXPECTED DENIAL%' then raise; end if; end;
end $$;

select 'OK: 0114 suppressed email status' as result;
rollback;
