-- RLS regression test for migration 0078_fix_admin_only_settings_rls.sql.
--
-- Security re-audit round 3, item 5: proves 4 admin-only settings tables now
-- require is_org_admin (not is_org_member) for writes, that member-level
-- reads are unaffected, and that the 3 service-only log/queue tables have no
-- client-role access at all (neither read nor write).
--
-- Self-contained and NON-DESTRUCTIVE: everything runs inside one transaction
-- that ROLLS BACK, so it can be run safely against any database (including
-- production) AFTER 0078 is applied.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0078_fix_admin_only_settings_rls.test.sql
-- Expect: "ALL 0078 RLS-FIX ASSERTIONS PASSED" and a ROLLBACK.

begin;

grant select, insert, update, delete on cin7_instances to authenticated, anon;
grant select, insert, update, delete on ship_by_notification_settings to authenticated, anon;
grant select, insert, update, delete on ship_by_notification_reps to authenticated, anon;
grant select, insert, update, delete on bom_alert_settings to authenticated, anon;
grant select, insert, update, delete on picking_calendar_settings to authenticated, anon;
grant select, insert, update, delete on ship_by_change_pending to authenticated, anon;
grant select, insert, update, delete on ship_by_change_notifications to authenticated, anon;
grant select, insert, update, delete on bom_alert_notifications to authenticated, anon;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
end $$;

-- See supabase/tests/0052_org_admin_rls.test.sql's own comment for why this
-- checks row_count instead of expecting an exception: an UPDATE whose target
-- row is filtered out by a policy's USING clause silently affects 0 rows
-- rather than raising, unlike an INSERT's WITH CHECK failure.
create or replace function pg_temp.expect_no_effect(sql text, label text) returns void language plpgsql as $$
declare
  v_count int;
begin
  execute sql;
  get diagnostics v_count = row_count;
  if v_count <> 0 then
    raise exception 'EXPECTED 0 rows affected (RLS-filtered) but % row(s) changed: %', v_count, label;
  end if;
end $$;

do $$
declare
  org_x uuid := gen_random_uuid();
  inst_x uuid;
  u_admin uuid := gen_random_uuid();
  u_member uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (u_admin), (u_member);
  insert into organizations (id, name) values (org_x, 'RLS Fix Test Org');
  insert into org_members (org_id, user_id, role) values (org_x, u_admin, 'admin'), (org_x, u_member, 'member');
  insert into cin7_instances (org_id, name, account_id, application_key_encrypted, base_url, active)
    values (org_x, 'seed', 'acct', 'ciphertext', 'https://inventory.dearsystems.com/ExternalApi/v2', true)
    returning id into inst_x;

  insert into ship_by_notification_settings (org_id, enabled) values (org_x, false);
  insert into ship_by_notification_reps (org_id, rep_name, email) values (org_x, 'Rep One', 'rep@example.com');
  insert into bom_alert_settings (org_id, enabled) values (org_x, false);
  insert into picking_calendar_settings (org_id, offset_days) values (org_x, 1);
  insert into ship_by_change_pending (org_id, cin7_sale_id, instance_id, latest_ship_by, first_changed_at, send_after)
    values (org_x, 'sale-x', inst_x, current_date, now(), now());
  insert into ship_by_change_notifications (org_id, cin7_sale_id, instance_id, new_ship_by, recipients)
    values (org_x, 'sale-x', inst_x, current_date, array['rep@example.com']);
  insert into bom_alert_notifications (org_id, cin7_sale_id, instance_id, bom_skus)
    values (org_x, 'sale-x', inst_x, array['SKU-1']);

  ---------------------------------------------------------------- ordinary member
  perform pg_temp.act_as(u_member);

  -- Admin-only settings: member can still READ (unaffected), cannot WRITE.
  if not exists (select 1 from ship_by_notification_settings where org_id = org_x) then
    raise exception 'FAIL: member cannot SELECT ship_by_notification_settings (should still be allowed)';
  end if;
  perform pg_temp.expect_no_effect(
    format('update ship_by_notification_settings set enabled=true where org_id=%L', org_x),
    'member UPDATE ship_by_notification_settings');
  perform pg_temp.expect_no_effect(
    format('update ship_by_notification_reps set rep_name=''hacked'' where org_id=%L', org_x),
    'member UPDATE ship_by_notification_reps');
  perform pg_temp.expect_no_effect(
    format('update bom_alert_settings set enabled=true where org_id=%L', org_x),
    'member UPDATE bom_alert_settings');
  perform pg_temp.expect_no_effect(
    format('update picking_calendar_settings set offset_days=9 where org_id=%L', org_x),
    'member UPDATE picking_calendar_settings');

  -- Service-only log/queue tables: member gets zero access, read or write.
  if exists (select 1 from ship_by_change_pending where org_id = org_x) then
    raise exception 'FAIL: member can SELECT ship_by_change_pending (should be service-only)';
  end if;
  if exists (select 1 from ship_by_change_notifications where org_id = org_x) then
    raise exception 'FAIL: member can SELECT ship_by_change_notifications (should be service-only)';
  end if;
  if exists (select 1 from bom_alert_notifications where org_id = org_x) then
    raise exception 'FAIL: member can SELECT bom_alert_notifications (should be service-only)';
  end if;
  perform pg_temp.expect_no_effect(
    format('update ship_by_change_pending set cin7_sale_id=cin7_sale_id where org_id=%L', org_x),
    'member UPDATE ship_by_change_pending');
  perform pg_temp.expect_no_effect(
    format('update ship_by_change_notifications set cin7_sale_id=cin7_sale_id where org_id=%L', org_x),
    'member UPDATE ship_by_change_notifications');
  perform pg_temp.expect_no_effect(
    format('update bom_alert_notifications set cin7_sale_id=cin7_sale_id where org_id=%L', org_x),
    'member UPDATE bom_alert_notifications');

  ---------------------------------------------------------------- org admin
  perform pg_temp.act_as(u_admin);
  update ship_by_notification_settings set enabled = true where org_id = org_x; -- must succeed
  update ship_by_notification_reps set rep_name = 'Rep Renamed' where org_id = org_x; -- must succeed
  update bom_alert_settings set enabled = true where org_id = org_x; -- must succeed
  update picking_calendar_settings set offset_days = 3 where org_id = org_x; -- must succeed

  reset role;
  raise notice 'ALL 0078 RLS-FIX ASSERTIONS PASSED';
end $$;

rollback;
