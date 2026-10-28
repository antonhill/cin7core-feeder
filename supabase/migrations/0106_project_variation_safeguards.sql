-- Variation safeguards (additive; applies after 0105).
--
--  1. A project cannot leave ACTIVE (COMPLETED / CLOSED / CANCELLED) while it, or any of its variation billing scopes, still has an unresolved
--     claim, Cin7 invoice posting, Sale creation or open child scope. A parent cannot close before every child scope is itself terminal.
--  2. Opening commitments (value committed before the Toolbox claim workflow) cannot exist on a variation billing project.
--  3. (No schema change) Negative variations stay unsupported: project_variations.amount_cents > 0 (0102) is the database rule, and the
--     application refuses a negative amount with an explicit message. No credit note or negative Sale is ever generated.
--
-- Nothing here calls Cin7 and no existing row is modified. V001 and all historical claims are untouched. NOT applied to hosted Supabase.

-- What is still owed or unresolved on ONE project (read-only helper). Empty array = nothing outstanding.
create or replace function project_unresolved_obligations(p_project uuid)
returns text[] language sql stable set search_path = public as $$
  select coalesce(array_agg(x order by x), '{}') from (
    -- claims that are not finished
    select format('claim %s is %s', claim_number, status) x from project_claims
      where project_id = p_project and status in ('DRAFT', 'READY_FOR_APPROVAL', 'CIN7_PENDING', 'FAILED_UNCERTAIN')
    union all
    -- an approved claim whose Cin7 invoice does not exist
    select format('approved claim %s has no Cin7 invoice', c.claim_number) from project_claims c
      where c.project_id = p_project and c.status = 'APPROVED'
        and not exists (select 1 from project_claim_cin7_postings p where p.claim_id = c.id and p.posting_state in ('CREATED', 'RECONCILED'))
    union all
    -- an invoice posting that is not reconciled, uncertain, or carries a mismatch
    select format('Cin7 posting %s is %s%s', coalesce(cin7_invoice_number, memo), posting_state,
                  case when last_error_code = 'AMOUNT_MISMATCH' then ' with an amount mismatch' else '' end) from project_claim_cin7_postings
      where project_id = p_project and (posting_state in ('PENDING', 'FAILED_UNCERTAIN', 'CREATED') or last_error_code = 'AMOUNT_MISMATCH')
    union all
    -- a Sale creation that is in flight, uncertain or unverified
    select format('Cin7 Sale creation is %s', creation_state) from project_cin7_sale_creations
      where project_id = p_project and creation_state in ('PENDING', 'CREATED', 'FAILED_UNCERTAIN')
  ) s;
$$;

create or replace function projects_closure_guard() returns trigger language plpgsql set search_path = public as $$
declare
  v_terminal text[] := array['COMPLETED', 'CLOSED', 'CANCELLED'];
  v_open text; v_obl text[]; v_child record;
begin
  if not (new.status = any (v_terminal)) or old.status = any (v_terminal) then return new; end if;

  -- a parent: every variation billing scope must already be finished
  select string_agg(project_reference || ' (' || status || ')', ', ') into v_open from projects
    where parent_project_id = old.id and org_id = old.org_id and not (status = any (v_terminal));
  if v_open is not null then
    raise exception 'projects %: cannot become % while variation billing scopes are still open: %', old.id, new.status, v_open;
  end if;
  -- ...and none may be left with anything unresolved (belt and braces: a finished child cannot hide obligations)
  for v_child in select id, project_reference from projects where parent_project_id = old.id and org_id = old.org_id loop
    v_obl := project_unresolved_obligations(v_child.id);
    if array_length(v_obl, 1) is not null then
      raise exception 'projects %: cannot become % because variation scope % has unresolved items: %', old.id, new.status, v_child.project_reference, array_to_string(v_obl, '; ');
    end if;
  end loop;

  -- a variation billing scope itself: nothing outstanding on it
  if old.billing_scope = 'VARIATION' then
    v_obl := project_unresolved_obligations(old.id);
    if array_length(v_obl, 1) is not null then
      raise exception 'projects %: cannot become % while it has unresolved items: %', old.id, new.status, array_to_string(v_obl, '; ');
    end if;
  end if;
  return new;
end;
$$;
create trigger projects_closure_guard_trg before update of status on projects
  for each row execute function projects_closure_guard();

create or replace function project_opening_commitments_scope_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if exists (select 1 from projects where id = new.project_id and org_id = new.org_id and billing_scope = 'VARIATION') then
    raise exception 'project_opening_commitments: a variation billing project cannot carry opening commitments (its value starts uncommitted)';
  end if;
  return new;
end;
$$;
create trigger project_opening_commitments_scope_guard_trg before insert or update on project_opening_commitments
  for each row execute function project_opening_commitments_scope_guard();

revoke all on function project_unresolved_obligations(uuid) from public, anon;
grant execute on function project_unresolved_obligations(uuid) to authenticated, service_role;
