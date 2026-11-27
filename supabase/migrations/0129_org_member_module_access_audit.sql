-- 0129: audit trail for per-member module access changes, written atomically with the change.
--
-- ADDITIVE ONLY. No existing column or row changes meaning. org_members.allowed_modules keeps its definition (migration 0039); for NewQuip-only users the application
-- reads it as an explicit grant list of main Toolbox modules (src/newquip/toolbox-access.ts), which needs no schema change.
--
-- set_member_modules() is the ONE write path for allowed_modules from the app: it locks the membership row, records previous and new values, and updates, in one
-- transaction, so a change can never exist without its audit row. Service-role only (the Server Action authorises the caller first and passes the actor).
-- The audit table is append-only and readable by the organisation's own members through RLS; every write is the function above.
--
-- FORWARD RECOVERY: unused objects are safe to leave; there is no destructive down-migration. To undo a grant, set the member's modules back through the app.

create table if not exists org_member_module_audit (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  target_user_id   uuid not null,
  target_email     text,
  actor_user_id    uuid not null,
  actor_email      text,
  previous_modules text[],
  new_modules      text[],
  changed_at       timestamptz not null default now()
);
create index if not exists org_member_module_audit_org_idx on org_member_module_audit (org_id, changed_at desc);
create index if not exists org_member_module_audit_target_idx on org_member_module_audit (org_id, target_user_id, changed_at desc);

alter table org_member_module_audit enable row level security;
create policy "org members read org_member_module_audit" on org_member_module_audit for select using (is_org_member(org_id));
comment on table org_member_module_audit is 'Who changed whose module access, when, from what to what. Append-only; written only by set_member_modules().';

create or replace function org_member_module_audit_append_only() returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'org_member_module_audit: append-only audit record';
end $$;
create trigger org_member_module_audit_append_only_trg before update or delete on org_member_module_audit
  for each row execute function org_member_module_audit_append_only();

create or replace function set_member_modules(p_org_id uuid, p_user_id uuid, p_modules text[], p_actor_user_id uuid, p_actor_email text, p_target_email text)
returns table (previous_modules text[], new_modules text[]) language plpgsql security definer set search_path = public as $$
declare v_prev text[]; v_found boolean;
begin
  select allowed_modules, true into v_prev, v_found from org_members where org_id = p_org_id and user_id = p_user_id for update;
  if not coalesce(v_found, false) then raise exception 'set_member_modules: that person is not a member of this organisation'; end if;
  update org_members set allowed_modules = p_modules where org_id = p_org_id and user_id = p_user_id;
  insert into org_member_module_audit (org_id, target_user_id, target_email, actor_user_id, actor_email, previous_modules, new_modules)
    values (p_org_id, p_user_id, p_target_email, p_actor_user_id, p_actor_email, v_prev, p_modules);
  return query select v_prev, p_modules;
end $$;
revoke all on function set_member_modules(uuid, uuid, text[], uuid, text, text) from public, anon, authenticated;
grant execute on function set_member_modules(uuid, uuid, text[], uuid, text, text) to service_role;
