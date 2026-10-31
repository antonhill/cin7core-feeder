-- NewQuip customer-level Rep isolation (Slice 1B). NOT applied to hosted Supabase (owner approval required). Additive and DISABLED BY DEFAULT.
--
-- What it adds:
--   newquip_access_settings          one row per organisation: is Rep customer isolation ENABLED? Default OFF (no row = OFF).
--   newquip_access_setting_events    append-only audit of every enable/disable (who, when, why, the read-only preflight that was shown).
--   newquip_set_rep_isolation(...)   the ONLY way to change the switch (service_role only): setting + audit event in ONE transaction.
--   newquip_isolation_on(org), newquip_quote_scope_ok(org), newquip_project_scope_ok(org)   SECURITY DEFINER helpers used by the read policies.
--   Re-created SELECT policies on the quotation, response, approval and Project tables (below) and on NewQuip/approvals/projects rows of activity_log.
--
-- Behaviour:
--   * Switch OFF (the default, and until the owner enables it): every re-created policy is exactly `is_org_member(org_id)` in effect - nothing changes for anyone.
--   * Switch ON for an organisation: through the database API (authenticated role) only
--         - an organisation owner/admin, or
--         - a user holding an EXPLICIT org_functional_roles assignment of ESTIMATOR or MANAGER (quotation/approval tables), plus PROJECT_MANAGER or PROCUREMENT (Project tables)
--       can read those rows (approval requests/events by document type: QUOTE follows the quotation rule, CLAIM/VARIATION the Project rule; `projects.*` activity rows follow the Project rule).
--       Everyone else - including a Rep, a plain member and a member who only holds the implicit tier-default roles - reads NOTHING from them directly.
--       A Rep's sanctioned read path is the server boundary (src/lib/newquip-assignments/access.ts), which applies the customer assignment and strips cost; it uses the service role.
--       The tier-default roles of a user with no explicit assignment (REP + ESTIMATOR while strict roles are off) deliberately do NOT confer organisation-wide visibility.
--   * Nothing here enables strict functional roles, touches service_role access, or changes any write policy.
--   * The application reads none of these tables through an RLS-subject client (docs/projects-poc/slice-1a-customer-assignments.md section 6), so no application behaviour depends on the old org-wide policies.
-- Not covered by RLS (by design): the Cin7 customer master `customers` (a general Toolbox table) and organisation configuration (templates, FX rates, package mappings, company profile).
-- Storage: the NewQuip buckets have NO storage.objects policy for anon/authenticated (0115/0117); documents and evidence are served only by authorised server routes.
-- Rollback: re-create each policy below as `using (is_org_member(org_id))` (activity_log: unchanged expression), then
--   drop function newquip_set_rep_isolation(uuid, boolean, text, text, jsonb); drop function newquip_project_scope_ok(uuid); drop function newquip_quote_scope_ok(uuid); drop function newquip_isolation_on(uuid);
--   drop table newquip_access_setting_events; drop table newquip_access_settings;   (see docs/projects-poc/slice-1b-rep-isolation.md for the exact statements)

create table if not exists newquip_access_settings (
  org_id uuid primary key references organizations (id) on delete cascade,
  rep_isolation_enabled boolean not null default false,
  changed_by_email text,
  changed_at timestamptz not null default clock_timestamp(),
  change_reason text
);

create table if not exists newquip_access_setting_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  enabled boolean not null,
  actor_email text not null check (length(btrim(actor_email)) > 3),
  reason text not null check (length(btrim(reason)) >= 5),
  preflight jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists newquip_access_setting_events_org_idx on newquip_access_setting_events (org_id, created_at desc);

-- append-only audit (deleted only by the cascade of removing the whole organisation)
create or replace function newquip_access_setting_events_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from organizations where id = old.org_id) then raise exception 'newquip_access_setting_events: the audit of access-setting changes is never deleted'; end if;
    return old;
  end if;
  raise exception 'newquip_access_setting_events: append-only';
end;
$$;
drop trigger if exists newquip_access_setting_events_guard_trg on newquip_access_setting_events;
create trigger newquip_access_setting_events_guard_trg before update or delete on newquip_access_setting_events for each row execute function newquip_access_setting_events_guard();

-- ── the switch: setting + audit event in ONE transaction, serialised per organisation ──────────
create or replace function newquip_set_rep_isolation(p_org uuid, p_enabled boolean, p_actor_email text, p_reason text, p_preflight jsonb)
returns boolean language plpgsql set search_path = public as $$
declare v_reason text := btrim(coalesce(p_reason, ''));
begin
  if p_org is null or p_enabled is null then raise exception 'newquip_set_rep_isolation: organisation and desired state are required'; end if;
  if length(btrim(coalesce(p_actor_email, ''))) <= 3 then raise exception 'newquip_set_rep_isolation: the actor is required'; end if;
  if length(v_reason) < 5 then raise exception 'newquip_set_rep_isolation: give a reason (at least 5 characters)'; end if;
  if not exists (select 1 from organizations where id = p_org) then raise exception 'newquip_set_rep_isolation: unknown organisation'; end if;
  perform pg_advisory_xact_lock(hashtextextended('newquip_access_settings:' || p_org::text, 0));
  insert into newquip_access_settings (org_id, rep_isolation_enabled, changed_by_email, changed_at, change_reason)
    values (p_org, p_enabled, p_actor_email, clock_timestamp(), v_reason)
    on conflict (org_id) do update set rep_isolation_enabled = excluded.rep_isolation_enabled, changed_by_email = excluded.changed_by_email, changed_at = excluded.changed_at, change_reason = excluded.change_reason;
  insert into newquip_access_setting_events (org_id, enabled, actor_email, reason, preflight) values (p_org, p_enabled, p_actor_email, v_reason, coalesce(p_preflight, '{}'::jsonb));
  return p_enabled;
end;
$$;

-- ── helpers used by the read policies (SECURITY DEFINER so a signed-in user need not read the settings/role tables) ──
create or replace function newquip_isolation_on(p_org uuid) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select s.rep_isolation_enabled from newquip_access_settings s where s.org_id = p_org), false);
$$;

-- Quotation, response and approval tables: isolation off, OR organisation owner/admin, OR an EXPLICIT Estimator/Manager assignment.
create or replace function newquip_quote_scope_ok(p_org uuid) returns boolean language sql stable security definer set search_path = public as $$
  select is_org_member(p_org) and (
    not newquip_isolation_on(p_org)
    or is_org_admin(p_org)
    or exists (select 1 from org_functional_roles r where r.org_id = p_org and r.user_id = auth.uid() and r.role in ('ESTIMATOR', 'MANAGER')));
$$;

-- Project tables: as above, plus the explicit Project Manager and Procurement roles (operational staff, not Reps).
create or replace function newquip_project_scope_ok(p_org uuid) returns boolean language sql stable security definer set search_path = public as $$
  select is_org_member(p_org) and (
    not newquip_isolation_on(p_org)
    or is_org_admin(p_org)
    or exists (select 1 from org_functional_roles r where r.org_id = p_org and r.user_id = auth.uid() and r.role in ('ESTIMATOR', 'MANAGER', 'PROJECT_MANAGER', 'PROCUREMENT')));
$$;

-- ── read policies ───────────────────────────────────────────────────────────
-- quotations, documents, sends, responses, reviews, evidence, links, approvals
drop policy if exists "org members read newquip_quotes" on newquip_quotes;
create policy "org members read newquip_quotes" on newquip_quotes for select using (is_org_member(org_id) and newquip_quote_scope_ok(org_id));
drop policy if exists "org members read newquip_quote_customers" on newquip_quote_customers;
create policy "org members read newquip_quote_customers" on newquip_quote_customers for select using (is_org_member(org_id) and newquip_quote_scope_ok(org_id));
drop policy if exists "org members read newquip_quote_documents" on newquip_quote_documents;
create policy "org members read newquip_quote_documents" on newquip_quote_documents for select using (is_org_member(org_id) and newquip_quote_scope_ok(org_id));
drop policy if exists "org members read newquip_quote_sends" on newquip_quote_sends;
create policy "org members read newquip_quote_sends" on newquip_quote_sends for select using (is_org_member(org_id) and newquip_quote_scope_ok(org_id));
drop policy if exists "org members read newquip_quote_responses" on newquip_quote_responses;
create policy "org members read newquip_quote_responses" on newquip_quote_responses for select using (is_org_member(org_id) and newquip_quote_scope_ok(org_id));
drop policy if exists "org members read newquip_response_reviews" on newquip_response_reviews;
create policy "org members read newquip_response_reviews" on newquip_response_reviews for select using (is_org_member(org_id) and newquip_quote_scope_ok(org_id));
drop policy if exists "org members read newquip_response_evidence" on newquip_response_evidence;
create policy "org members read newquip_response_evidence" on newquip_response_evidence for select using (is_org_member(org_id) and newquip_quote_scope_ok(org_id));
drop policy if exists "org members read newquip_response_links" on newquip_response_links;
create policy "org members read newquip_response_links" on newquip_response_links for select using (is_org_member(org_id) and newquip_quote_scope_ok(org_id));
drop policy if exists "org members read approval_requests" on approval_requests;
create policy "org members read approval_requests" on approval_requests for select using (is_org_member(org_id) and ((doc_type = 'QUOTE' and newquip_quote_scope_ok(org_id)) or (doc_type <> 'QUOTE' and newquip_project_scope_ok(org_id))));
drop policy if exists "org members read approval_events" on approval_events;
create policy "org members read approval_events" on approval_events for select using (is_org_member(org_id) and ((doc_type = 'QUOTE' and newquip_quote_scope_ok(org_id)) or (doc_type <> 'QUOTE' and newquip_project_scope_ok(org_id))));

-- the notification recipient policy keeps its recipient test and gains the scope test
drop policy if exists "recipients read approval_notifications" on approval_notifications;
create policy "recipients read approval_notifications" on approval_notifications for select
  using (is_org_member(org_id) and recipient_email = lower(coalesce((auth.jwt() ->> 'email'), '')) and newquip_project_scope_ok(org_id));

-- Projects and everything hanging off them
drop policy if exists "org members read projects" on projects;
create policy "org members read projects" on projects for select using (is_org_member(org_id) and newquip_project_scope_ok(org_id));
drop policy if exists "org members read project_cin7_links" on project_cin7_links;
create policy "org members read project_cin7_links" on project_cin7_links for select using (is_org_member(org_id) and newquip_project_scope_ok(org_id));
drop policy if exists "org members read project_cin7_sale_creations" on project_cin7_sale_creations;
create policy "org members read project_cin7_sale_creations" on project_cin7_sale_creations for select using (is_org_member(org_id) and newquip_project_scope_ok(org_id));
drop policy if exists "org members read project_cin7_sale_links" on project_cin7_sale_links;
create policy "org members read project_cin7_sale_links" on project_cin7_sale_links for select using (is_org_member(org_id) and newquip_project_scope_ok(org_id));
drop policy if exists "org members read project_claim_cin7_postings" on project_claim_cin7_postings;
create policy "org members read project_claim_cin7_postings" on project_claim_cin7_postings for select using (is_org_member(org_id) and newquip_project_scope_ok(org_id));
drop policy if exists "org members read project_claim_lines" on project_claim_lines;
create policy "org members read project_claim_lines" on project_claim_lines for select using (is_org_member(org_id) and newquip_project_scope_ok(org_id));
drop policy if exists "org members read project_claims" on project_claims;
create policy "org members read project_claims" on project_claims for select using (is_org_member(org_id) and newquip_project_scope_ok(org_id));
drop policy if exists "org members read project_deliveries" on project_deliveries;
create policy "org members read project_deliveries" on project_deliveries for select using (is_org_member(org_id) and newquip_project_scope_ok(org_id));
drop policy if exists "org members read project_delivery_allocations" on project_delivery_allocations;
create policy "org members read project_delivery_allocations" on project_delivery_allocations for select using (is_org_member(org_id) and newquip_project_scope_ok(org_id));
drop policy if exists "org members read project_delivery_events" on project_delivery_events;
create policy "org members read project_delivery_events" on project_delivery_events for select using (is_org_member(org_id) and newquip_project_scope_ok(org_id));
drop policy if exists "org members read project_milestone_confirmations" on project_milestone_confirmations;
create policy "org members read project_milestone_confirmations" on project_milestone_confirmations for select using (is_org_member(org_id) and newquip_project_scope_ok(org_id));
drop policy if exists "org members read project_opening_commitments" on project_opening_commitments;
create policy "org members read project_opening_commitments" on project_opening_commitments for select using (is_org_member(org_id) and newquip_project_scope_ok(org_id));
drop policy if exists "org members read project_progress_events" on project_progress_events;
create policy "org members read project_progress_events" on project_progress_events for select using (is_org_member(org_id) and newquip_project_scope_ok(org_id));
drop policy if exists "org members read project_stage_allocations" on project_stage_allocations;
create policy "org members read project_stage_allocations" on project_stage_allocations for select using (is_org_member(org_id) and newquip_project_scope_ok(org_id));
drop policy if exists "org members read project_stages" on project_stages;
create policy "org members read project_stages" on project_stages for select using (is_org_member(org_id) and newquip_project_scope_ok(org_id));
drop policy if exists "org members read project_variation_schedule_amendments" on project_variation_schedule_amendments;
create policy "org members read project_variation_schedule_amendments" on project_variation_schedule_amendments for select using (is_org_member(org_id) and newquip_project_scope_ok(org_id));
drop policy if exists "org members read project_variation_stages" on project_variation_stages;
create policy "org members read project_variation_stages" on project_variation_stages for select using (is_org_member(org_id) and newquip_project_scope_ok(org_id));
drop policy if exists "org members read project_variations" on project_variations;
create policy "org members read project_variations" on project_variations for select using (is_org_member(org_id) and newquip_project_scope_ok(org_id));

-- activity_log: the Toolbox rows (sync, instance, audit, ...) are unchanged; NewQuip / approvals / projects rows follow the quotation scope
drop policy if exists "org members read activity_log" on activity_log;
create policy "org members read activity_log" on activity_log for select
  using (is_org_member(org_id) and (action !~ '^(newquip|approvals|projects)\.' or newquip_quote_scope_ok(org_id) or (action like 'projects.%' and newquip_project_scope_ok(org_id))));

-- ── access ──────────────────────────────────────────────────────────────────
alter table newquip_access_settings enable row level security;
alter table newquip_access_setting_events enable row level security;
revoke all on newquip_access_settings, newquip_access_setting_events from public, anon, authenticated, service_role;
grant select, insert on newquip_access_settings to service_role;
grant update (rep_isolation_enabled, changed_by_email, changed_at, change_reason) on newquip_access_settings to service_role;
grant select, insert on newquip_access_setting_events to service_role;
revoke all on function newquip_access_setting_events_guard() from public, anon, authenticated;
revoke all on function newquip_set_rep_isolation(uuid, boolean, text, text, jsonb) from public, anon, authenticated;
grant execute on function newquip_set_rep_isolation(uuid, boolean, text, text, jsonb) to service_role;
revoke all on function newquip_isolation_on(uuid), newquip_quote_scope_ok(uuid), newquip_project_scope_ok(uuid) from public, anon, authenticated;
grant execute on function newquip_isolation_on(uuid) to service_role;                                    -- only the definer helpers call it; a client cannot probe any organisation's switch
grant execute on function newquip_quote_scope_ok(uuid), newquip_project_scope_ok(uuid) to authenticated, service_role;   -- evaluated by the read policies; both answer false for a non-member
