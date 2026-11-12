-- NewQuip NQ-008B Phase 2: IMMUTABLE ESTIMATOR PRICING REVISIONS (additive; applies after 0125). NOT applied to hosted Supabase; NO migration is authorised until the owner says so.
--
-- Migration ownership: this is the ONLY migration stream for NQ-008B pricing persistence (branch feature/newquip-nq008b-p2b-pricing-revisions). The number 0126 was verified free on
-- 2026-11-12 against the shared ledger (last applied: 0125 purchase_refresh_queue_and_guarded_replace) and every origin branch / open PR (unapplied elsewhere: 0114, 0118, 0119,
-- 0120, 0122). It MUST be re-verified immediately before it is applied; if anything has claimed 0126 this file is renumbered, never merged on top.
--
--   newquip_pricing_revisions        append-only. One row per authorised change to a quotation's Estimator pricing inputs: who, when, why, the rule version, the previous and the new
--                                    inputs and the list of changed values. CONFIDENTIAL (it holds supplier costs and rates): NO member read policy and NO anon/authenticated
--                                    privilege; only the service-role Server Actions read it, and they release it to cost-entitled viewers only (the same rule as every cost field).
--   newquip_apply_pricing_revision() ONE transaction: lock the quotation, check it is still editable, with exactly the draft hash and revision sequence the caller evaluated,
--                                    insert the revision, write the new draft (withdrawing any Estimator sign-off). A change therefore either records its revision or does not happen.
--
-- Nothing here talks to Cin7 or Xero. Older application code ignores all of it. Rollback / recovery (every object is new and unreferenced by older code):
--   drop function newquip_apply_pricing_revision(uuid, uuid, integer, text, jsonb, text, text, text, text, text, jsonb, jsonb, jsonb, text, text);
--   drop table newquip_pricing_revisions cascade;   -- (the guard permits deleting rows only when the organisation itself is deleted)

create table if not exists newquip_pricing_revisions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  quote_id    uuid not null,
  -- 1, 2, ... per quotation, assigned by newquip_apply_pricing_revision under the quotation row lock.
  seq         integer not null check (seq > 0),
  -- The quotation's own revision (the Rep round) the change was made in.
  quote_revision integer not null check (quote_revision > 0),
  kind        text not null check (kind in ('ENABLED', 'CHANGED', 'DISABLED')),
  rule_version text not null check (length(btrim(rule_version)) > 0),
  reason      text not null check (length(btrim(reason)) >= 3),
  -- null previous = first revision (ENABLED); null new = DISABLED.
  previous_pricing jsonb check (previous_pricing is null or jsonb_typeof(previous_pricing) = 'object'),
  new_pricing jsonb check (new_pricing is null or jsonb_typeof(new_pricing) = 'object'),
  -- [{ "path": "skus.PNQ082.nativeUnitCostMicro", "previous": ..., "new": ... }, ...]
  changes     jsonb not null check (jsonb_typeof(changes) = 'array'),
  new_pricing_hash text not null check (length(new_pricing_hash) = 64),
  draft_hash_after text not null check (length(btrim(draft_hash_after)) > 0),
  changed_by_email text not null check (length(btrim(changed_by_email)) > 0),
  created_at  timestamptz not null default clock_timestamp(),
  check ((kind = 'ENABLED' and previous_pricing is null and new_pricing is not null)
      or (kind = 'CHANGED' and previous_pricing is not null and new_pricing is not null)
      or (kind = 'DISABLED' and previous_pricing is not null and new_pricing is null)),
  foreign key (quote_id, org_id) references newquip_quotes (id, org_id) on delete cascade,
  unique (quote_id, seq),
  unique (id, org_id)
);
create index if not exists newquip_pricing_revisions_quote_idx on newquip_pricing_revisions (org_id, quote_id, seq desc);

comment on table newquip_pricing_revisions is
  'Immutable log of Estimator pricing changes (who, when, why, rule version, previous and new values). Holds supplier costs: service role only (no member read policy, no anon/authenticated privilege).';

-- Append-only, mirroring 0123: an update or delete is refused unless the whole organisation is being deleted (the cascade). Insert only for an editable quotation of the same organisation.
create or replace function newquip_pricing_revisions_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    if exists (select 1 from organizations where id = old.org_id) then
      raise exception 'newquip_pricing_revisions: a pricing revision is an audit record and is never updated or deleted';
    end if;
    return old;
  end if;
  if not exists (select 1 from newquip_quotes q where q.id = new.quote_id and q.org_id = new.org_id and q.state in ('REP_DRAFT', 'ESTIMATOR_REVIEW')) then
    raise exception 'newquip_pricing_revisions: a revision can only be recorded for an editable quotation of this organisation';
  end if;
  return new;
end;
$$;
drop trigger if exists newquip_pricing_revisions_guard_trg on newquip_pricing_revisions;
create trigger newquip_pricing_revisions_guard_trg before insert or update or delete on newquip_pricing_revisions
  for each row execute function newquip_pricing_revisions_guard();

-- Privileges: as narrow as 0123. Members get no SELECT at all (RLS on, no policy); the service role gets SELECT + INSERT only.
alter table newquip_pricing_revisions enable row level security;
revoke all on newquip_pricing_revisions from public, anon, authenticated, service_role;
grant select, insert on newquip_pricing_revisions to service_role;
revoke all on function newquip_pricing_revisions_guard() from public, anon, authenticated;

-- ── Atomic apply ─────────────────────────────────────────────────────────────
-- Raises 'pricing_conflict: ...' when the quotation is not editable, or is not at exactly the draft hash / revision sequence the caller evaluated (a concurrent edit or a
-- double submit). Everything about WHAT may change (roles, cost visibility, validation, reasons) is decided by the caller before this is called; this function only
-- makes the revision and the draft change one transaction. Estimator sign-off is withdrawn (the content it covered changed). The customer's confirmation is withdrawn by the
-- caller through the existing amount-change workflow, in the same request.
create or replace function newquip_apply_pricing_revision(
  p_org uuid, p_quote uuid, p_expected_seq integer, p_expected_draft_hash text,
  p_new_draft jsonb, p_new_draft_hash text,
  p_kind text, p_reason text, p_rule_version text,
  p_previous_pricing jsonb, p_new_pricing jsonb, p_changes jsonb,
  p_new_pricing_hash text, p_changed_by text
) returns uuid language plpgsql set search_path = public as $$
declare q newquip_quotes%rowtype; v_id uuid; v_seq integer; k text; n jsonb; o jsonb;
begin
  select * into q from newquip_quotes where id = p_quote and org_id = p_org for update;
  if not found then raise exception 'pricing_conflict: the quotation was not found'; end if;
  if q.state not in ('REP_DRAFT', 'ESTIMATOR_REVIEW') then raise exception 'pricing_conflict: the quotation can no longer be edited'; end if;
  if q.draft_hash <> p_expected_draft_hash then raise exception 'pricing_conflict: the quotation changed while the pricing was being edited'; end if;
  select coalesce(max(seq), 0) into v_seq from newquip_pricing_revisions where quote_id = p_quote and org_id = p_org;
  if v_seq <> p_expected_seq then raise exception 'pricing_conflict: the pricing changed while it was being edited'; end if;

  -- The function writes a WHOLE draft, so it proves that ONLY estimator.pricing differs (a bug or another service-role caller can never rewrite anything else under a
  -- pricing revision), that the recorded previous / new pricing are exactly the stored / written ones, and that the kind says what happened. JSON null and SQL null are the same here.
  if (p_new_draft #- '{estimator,pricing}') is distinct from (q.draft #- '{estimator,pricing}') then raise exception 'pricing_conflict: a pricing revision may change only estimator.pricing'; end if;
  if nullif(p_previous_pricing, 'null'::jsonb) is distinct from nullif(q.draft #> '{estimator,pricing}', 'null'::jsonb) then raise exception 'pricing_conflict: the recorded previous pricing is not the stored pricing'; end if;
  if nullif(p_new_pricing, 'null'::jsonb) is distinct from nullif(p_new_draft #> '{estimator,pricing}', 'null'::jsonb) then raise exception 'pricing_conflict: the recorded new pricing is not the pricing written to the draft'; end if;

  -- INDEPENDENT COST VERIFICATION, enforced here as well as in the application (defence in depth for any other service-role caller). A review may be recorded only (a) for a cost
  -- that already exists and is unchanged, (b) by the person recorded as making this change, and (c) by someone other than whoever entered / last changed that cost. A cost
  -- that changed in this revision cannot carry a review. (The application additionally binds each review to a hash of the exact cost; this check is structural.)
  for k in select jsonb_object_keys(coalesce(p_new_draft #> '{estimator,pricing,skus}', '{}'::jsonb)) loop
    n := p_new_draft #> array['estimator', 'pricing', 'skus', k];
    o := q.draft #> array['estimator', 'pricing', 'skus', k];
    if jsonb_typeof(n) = 'object' and (n -> 'review') is not null and jsonb_typeof(n -> 'review') = 'object' then
      if (n -> 'review') is distinct from (o -> 'review') then
        if o is null then raise exception 'pricing_conflict: a review cannot be recorded for a new cost'; end if;
        if (n ->> 'by') is distinct from (o ->> 'by') then raise exception 'pricing_conflict: a review cannot be recorded together with a change to the cost'; end if;
        if lower(btrim(coalesce(n #>> '{review,by}', ''))) is distinct from lower(btrim(coalesce(p_changed_by, ''))) then raise exception 'pricing_conflict: a review must be recorded by the reviewer'; end if;
        if lower(btrim(coalesce(n #>> '{review,by}', ''))) = lower(btrim(coalesce(n ->> 'by', ''))) then raise exception 'pricing_conflict: a cost cannot be verified by the person who entered it'; end if;
      end if;
      if o is not null and (n - 'review' - 'by' - 'at') is distinct from (o - 'review' - 'by' - 'at') then raise exception 'pricing_conflict: a changed cost cannot carry a review'; end if;
    end if;
  end loop;

  insert into newquip_pricing_revisions (
    org_id, quote_id, seq, quote_revision, kind, rule_version, reason, previous_pricing, new_pricing, changes, new_pricing_hash, draft_hash_after, changed_by_email
  ) values (
    p_org, p_quote, v_seq + 1, q.revision, p_kind, p_rule_version, p_reason, p_previous_pricing, p_new_pricing, p_changes, p_new_pricing_hash, p_new_draft_hash, p_changed_by
  ) returning id into v_id;

  update newquip_quotes set
    draft = p_new_draft, draft_hash = p_new_draft_hash,
    estimator_signoff_hash = null, estimator_signoff_by_email = null, estimator_signoff_at = null
  where id = p_quote and org_id = p_org;
  return v_id;
end;
$$;
revoke all on function newquip_apply_pricing_revision(uuid, uuid, integer, text, jsonb, text, text, text, text, jsonb, jsonb, jsonb, text, text) from public, anon, authenticated;
grant execute on function newquip_apply_pricing_revision(uuid, uuid, integer, text, jsonb, text, text, text, text, jsonb, jsonb, jsonb, text, text) to service_role;
