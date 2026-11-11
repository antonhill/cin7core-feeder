-- NewQuip NQ-008A: immutable INDICATIVE PRICE snapshot captured at the Rep -> Estimator handoff (additive; applies after 0120). NOT applied to hosted Supabase.
--
-- Why a new table (and not activity_log): activity_log is member-readable, has no immutability guard, is written best-effort (errors are swallowed) in a
-- separate statement from the state change, and its `detail` is passed through a redactor. A commercial snapshot needs the opposite on every point.
--
--   newquip_indicative_price_snapshots   append-only. One row per handoff of a quotation (seq 1, 2, ... because a returned quotation is handed off again).
--       snapshot  = { customerSafe: what the Rep saw (selling prices, completeness, totals), internal: the calculation basis (rule set + version, price source
--                     descriptor, cost per line) }.  `internal` is confidential: this table has NO member read policy and NO anon/authenticated privilege at all.
--                     Only the service-role Server Actions read it, and they release cost only to a cost-entitled viewer (the same rule as every other cost field).
--   newquip_handoff_with_snapshot(...)   ONE transaction: lock the quotation, check state + draft hash, insert the snapshot, move to ESTIMATOR_REVIEW. A handoff
--       therefore either records its indicative basis or does not happen; there is no "handed off but not captured" state once this migration is applied.
--
-- Nothing here talks to Cin7 or Xero. Rollback / recovery: every object is new and unreferenced by older code:
--   drop function newquip_handoff_with_snapshot(uuid, uuid, text, bigint, text, text, jsonb, text, bigint, text, text, text, text, text, text);
--   drop table newquip_indicative_price_snapshots cascade;   -- (the guard permits deleting rows only when the organisation itself is deleted)
-- Older application code ignores all of it. Single stream owner: feature/newquip-nq008a-indicative-capture.

create table if not exists newquip_indicative_price_snapshots (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  quote_id    uuid not null,
  -- 1, 2, ... per quotation, assigned by newquip_handoff_with_snapshot under the quotation row lock.
  seq         integer not null check (seq > 0),
  -- The quotation revision and draft hash this snapshot was taken from.
  revision    integer not null check (revision > 0),
  draft_hash  text not null check (length(btrim(draft_hash)) > 0),
  -- Indexed facts, so the pricing source and rule version can be reconstructed and queried without opening the jsonb.
  ruleset_id        text not null check (length(btrim(ruleset_id)) > 0),
  ruleset_version   text not null check (length(btrim(ruleset_version)) > 0),
  price_source_id   text not null check (length(btrim(price_source_id)) > 0),
  price_source_fingerprint text not null check (length(btrim(price_source_fingerprint)) > 0),
  total_ex_vat_cents bigint not null check (total_ex_vat_cents >= 0),
  completeness text not null check (completeness in ('complete', 'provisional', 'not_priced')),
  snapshot    jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  snapshot_hash text not null check (length(snapshot_hash) = 64),
  captured_by_email text not null check (length(btrim(captured_by_email)) > 0),
  created_at  timestamptz not null default clock_timestamp(),
  foreign key (quote_id, org_id) references newquip_quotes (id, org_id) on delete cascade,
  unique (quote_id, seq),
  unique (id, org_id)
);
create index if not exists newquip_indicative_price_snapshots_quote_idx on newquip_indicative_price_snapshots (org_id, quote_id, seq desc);

comment on table newquip_indicative_price_snapshots is
  'Immutable indicative price captured at handoff. snapshot.internal holds the confidential calculation basis: service role only (no member read policy, no anon/authenticated privilege).';

-- Append-only, mirroring 0115: an update or delete is refused unless the whole organisation is being deleted (the cascade).
create or replace function newquip_indicative_price_snapshots_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    if exists (select 1 from organizations where id = old.org_id) then
      raise exception 'newquip_indicative_price_snapshots: an indicative snapshot is an audit record and is never updated or deleted';
    end if;
    return old;
  end if;
  -- insert: only for a quotation of the same organisation that is still being prepared or reviewed; an approved quotation has its sealed baseline instead.
  if not exists (select 1 from newquip_quotes q where q.id = new.quote_id and q.org_id = new.org_id and q.state in ('REP_DRAFT', 'ESTIMATOR_REVIEW')) then
    raise exception 'newquip_indicative_price_snapshots: a snapshot can only be captured for an editable quotation of this organisation';
  end if;
  return new;
end;
$$;
drop trigger if exists newquip_indicative_price_snapshots_guard_trg on newquip_indicative_price_snapshots;
create trigger newquip_indicative_price_snapshots_guard_trg before insert or update or delete on newquip_indicative_price_snapshots
  for each row execute function newquip_indicative_price_snapshots_guard();

-- Privileges: deliberately NARROWER than 0116's pattern. The snapshot contains cost basis, so members get no SELECT at all (RLS on, no policy), and the service role
-- gets SELECT + INSERT only (no UPDATE / DELETE / TRUNCATE privilege), on top of the guard trigger.
alter table newquip_indicative_price_snapshots enable row level security;
revoke all on newquip_indicative_price_snapshots from public, anon, authenticated;
grant select, insert on newquip_indicative_price_snapshots to service_role;
revoke all on function newquip_indicative_price_snapshots_guard() from public, anon, authenticated;

-- ── Atomic handoff + capture ─────────────────────────────────────────────────
-- Raises 'handoff_conflict: ...' when the quotation is not a REP_DRAFT with exactly the draft hash the caller evaluated (a double submit, or an edit that committed
-- meanwhile); the Server Action turns that into its usual "changed while sending" message. Everything else (the confirmed-amount rules) is decided by the caller
-- before this is called, exactly as before; this function only makes the state change and the capture one transaction.
create or replace function newquip_handoff_with_snapshot(
  p_org uuid, p_quote uuid, p_draft_hash text,
  p_confirmed_cents bigint, p_confirmed_by text, p_handoff_by text,
  p_snapshot jsonb, p_snapshot_hash text, p_total_cents bigint, p_completeness text,
  p_ruleset_id text, p_ruleset_version text, p_price_source_id text, p_price_source_fingerprint text,
  p_captured_by text
) returns uuid language plpgsql set search_path = public as $$
declare q newquip_quotes%rowtype; v_id uuid; v_seq integer;
begin
  select * into q from newquip_quotes where id = p_quote and org_id = p_org for update;
  if not found then raise exception 'handoff_conflict: the quotation was not found'; end if;
  if q.state <> 'REP_DRAFT' or q.draft_hash <> p_draft_hash then raise exception 'handoff_conflict: the quotation changed while sending'; end if;

  select coalesce(max(seq), 0) + 1 into v_seq from newquip_indicative_price_snapshots where quote_id = p_quote and org_id = p_org;
  insert into newquip_indicative_price_snapshots (
    org_id, quote_id, seq, revision, draft_hash, ruleset_id, ruleset_version, price_source_id, price_source_fingerprint,
    total_ex_vat_cents, completeness, snapshot, snapshot_hash, captured_by_email
  ) values (
    p_org, p_quote, v_seq, q.revision, q.draft_hash, p_ruleset_id, p_ruleset_version, p_price_source_id, p_price_source_fingerprint,
    p_total_cents, p_completeness, p_snapshot, p_snapshot_hash, p_captured_by
  ) returning id into v_id;

  update newquip_quotes set
    state = 'ESTIMATOR_REVIEW', customer_confirmed_cents = p_confirmed_cents, customer_confirmed_by = btrim(p_confirmed_by),
    customer_confirmed_at = clock_timestamp(), handoff_by_email = p_handoff_by,
    estimator_signoff_hash = null, estimator_signoff_by_email = null, estimator_signoff_at = null
  where id = p_quote and org_id = p_org;
  return v_id;
end;
$$;
revoke all on function newquip_handoff_with_snapshot(uuid, uuid, text, bigint, text, text, jsonb, text, bigint, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function newquip_handoff_with_snapshot(uuid, uuid, text, bigint, text, text, jsonb, text, bigint, text, text, text, text, text, text) to service_role;
