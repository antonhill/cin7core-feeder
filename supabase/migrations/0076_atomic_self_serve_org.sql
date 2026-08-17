-- Security re-audit P1-8: atomic self-serve org + owner-membership creation.
--
-- createSelfServeOrgAction (signup/actions.ts) used to insert `organizations`
-- then `org_members` as two separate, sequential Supabase calls. If the
-- second insert failed after the first succeeded, the result was an orphaned
-- org with no owner — the user would be stuck: signed in, but with no
-- membership row for requireCurrentOrg() to find, and no way to retry
-- (re-visiting /signup would create a SECOND orphaned org, since the
-- existing-membership check finds nothing).
--
-- One plpgsql function = one implicit transaction, same pattern already
-- established for the idempotency-claim RPCs (po_creation_claim,
-- stock_transfer_creation_claim) and the atomic snapshot-replace RPCs
-- (migration 0074).

create or replace function create_self_serve_org(p_org_name text, p_user_id uuid)
returns uuid
language plpgsql
as $$
declare
  v_org_id uuid;
begin
  insert into organizations (name) values (p_org_name) returning id into v_org_id;
  insert into org_members (org_id, user_id, role) values (v_org_id, p_user_id, 'owner');
  return v_org_id;
end;
$$;

revoke all on function create_self_serve_org(text, uuid) from public;
revoke all on function create_self_serve_org(text, uuid) from anon, authenticated;
