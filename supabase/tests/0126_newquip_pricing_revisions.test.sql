-- Transactional test for migration 0126 (immutable Estimator pricing revisions + the atomic apply function). BEGIN/ROLLBACK - leaves no rows.
begin;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.reset_role() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); end $$;
create or replace function pg_temp.expect_denied(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then return; end;
  raise exception 'EXPECTED DENIAL but succeeded: %', label;
end $$;

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000126a1');
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000126b1', 'PR Org A'), ('00000000-0000-0000-0000-0000000126b2', 'PR Org B');
insert into org_members (org_id, user_id, role) values ('00000000-0000-0000-0000-0000000126b1', '00000000-0000-0000-0000-0000000126a1', 'member');
insert into newquip_quotes (id, org_id, quote_ref, draft, draft_hash) values
  ('00000000-0000-0000-0000-0000000126c1', '00000000-0000-0000-0000-0000000126b1', 'PR-1', '{"estimator":{}}', 'h1'),
  ('00000000-0000-0000-0000-0000000126c2', '00000000-0000-0000-0000-0000000126b1', 'PR-2', '{"estimator":{}}', 'h2'),
  ('00000000-0000-0000-0000-0000000126c3', '00000000-0000-0000-0000-0000000126b1', 'PR-3', '{"estimator":{}}', 'h3');
-- PR-1 is in estimator review with a recorded sign-off (a quotation is always created as REP_DRAFT)
update newquip_quotes set state = 'ESTIMATOR_REVIEW', customer_confirmed_cents = 100000, customer_confirmed_by = 'Farmer', customer_confirmed_at = now(), handoff_by_email = 'rep@x' where quote_ref = 'PR-1';
update newquip_quotes set estimator_signoff_hash = 'h1', estimator_signoff_by_email = 'est@x', estimator_signoff_at = now() where quote_ref = 'PR-1';

create or replace function pg_temp.apply_rev_x(p_org uuid, p_quote uuid, p_seq integer, p_hash text, p_new_draft jsonb, p_prev jsonb, p_new jsonb, p_kind text) returns uuid language sql as $$
  select newquip_apply_pricing_revision(p_org, p_quote, p_seq, p_hash, p_new_draft, 'hx', p_kind, 'Cross-check test', 'legacy-poc-v1', p_prev, p_new, '[]'::jsonb, repeat('a', 64), 'est@x')
$$;
create or replace function pg_temp.apply_rev(p_org uuid, p_quote uuid, p_seq integer, p_hash text, p_new_hash text, p_kind text default 'ENABLED', p_reason text default 'Initial supplier pricing') returns uuid language sql as $$
  select newquip_apply_pricing_revision(p_org, p_quote, p_seq, p_hash,
    '{"estimator":{"pricing":{"revision":1,"secret":"cost"}}}'::jsonb, p_new_hash, p_kind, p_reason, 'legacy-poc-v1',
    case when p_kind = 'ENABLED' then null else '{"revision":1,"secret":"cost"}'::jsonb end,
    case when p_kind = 'DISABLED' then null else '{"revision":1,"secret":"cost"}'::jsonb end,
    '[{"path":"skus.X.nativeUnitCostMicro","previous":1,"new":2}]'::jsonb, repeat('a', 64), 'est@x')
$$;

-- 1. happy path: ONE call stores the revision AND writes the draft, and withdraws the Estimator sign-off
select pg_temp.apply_rev('00000000-0000-0000-0000-0000000126b1', '00000000-0000-0000-0000-0000000126c1', 0, 'h1', 'h1b');
do $$ begin
  if (select count(*) from newquip_pricing_revisions where quote_id = '00000000-0000-0000-0000-0000000126c1') <> 1 then raise exception 'exactly one revision expected'; end if;
  if (select seq from newquip_pricing_revisions where quote_id = '00000000-0000-0000-0000-0000000126c1') <> 1 then raise exception 'first revision must be seq 1'; end if;
  if (select draft_hash from newquip_quotes where quote_ref = 'PR-1') <> 'h1b' then raise exception 'draft hash must be the new one'; end if;
  if (select draft -> 'estimator' -> 'pricing' ->> 'secret' from newquip_quotes where quote_ref = 'PR-1') <> 'cost' then raise exception 'the new draft must be stored'; end if;
  if (select estimator_signoff_hash from newquip_quotes where quote_ref = 'PR-1') is not null then raise exception 'sign-off must be withdrawn'; end if;
  if (select quote_revision from newquip_pricing_revisions where quote_id = '00000000-0000-0000-0000-0000000126c1') <> 1 then raise exception 'revision must come from the quotation'; end if;
end $$;

-- 2. a stale draft hash, a stale sequence (double submit) and another organisation change NOTHING
select pg_temp.expect_denied($q$select pg_temp.apply_rev('00000000-0000-0000-0000-0000000126b1', '00000000-0000-0000-0000-0000000126c1', 0, 'h1b', 'h1c', 'CHANGED')$q$, 'stale sequence');
select pg_temp.expect_denied($q$select pg_temp.apply_rev('00000000-0000-0000-0000-0000000126b1', '00000000-0000-0000-0000-0000000126c2', 0, 'STALE', 'x')$q$, 'stale draft hash');
select pg_temp.expect_denied($q$select pg_temp.apply_rev('00000000-0000-0000-0000-0000000126b2', '00000000-0000-0000-0000-0000000126c2', 0, 'h2', 'x')$q$, 'cross-organisation');
do $$ begin
  if (select draft_hash from newquip_quotes where quote_ref = 'PR-2') <> 'h2' then raise exception 'a refused change must leave the quotation untouched'; end if;
  if (select count(*) from newquip_pricing_revisions) <> 1 then raise exception 'a refused change must store no revision'; end if;
end $$;

-- 2b. CROSS-CHECKS: a pricing revision cannot rewrite anything but estimator.pricing, and the recorded previous / new pricing must be the real ones
select pg_temp.expect_denied($q$select pg_temp.apply_rev_x('00000000-0000-0000-0000-0000000126b1', '00000000-0000-0000-0000-0000000126c2', 0, 'h2', '{"estimator":{"pricing":{"revision":1}},"customerName":"HIJACKED"}'::jsonb, null, '{"revision":1}'::jsonb, 'ENABLED')$q$, 'revision that changes another part of the draft');
select pg_temp.expect_denied($q$select pg_temp.apply_rev_x('00000000-0000-0000-0000-0000000126b1', '00000000-0000-0000-0000-0000000126c2', 0, 'h2', '{"estimator":{"pricing":{"revision":1}}}'::jsonb, null, '{"revision":99}'::jsonb, 'ENABLED')$q$, 'recorded new pricing differs from the written pricing');
select pg_temp.expect_denied($q$select pg_temp.apply_rev_x('00000000-0000-0000-0000-0000000126b1', '00000000-0000-0000-0000-0000000126c2', 0, 'h2', '{"estimator":{"pricing":{"revision":1}}}'::jsonb, '{"revision":7}'::jsonb, '{"revision":1}'::jsonb, 'CHANGED')$q$, 'recorded previous pricing is not the stored pricing');
do $$ begin
  if (select draft_hash from newquip_quotes where quote_ref = 'PR-2') <> 'h2' then raise exception 'a rejected cross-check must change nothing'; end if;
end $$;


-- 2c. INDEPENDENT COST VERIFICATION is enforced by the function too (PR-3): structural rules, whatever the caller claims
create or replace function pg_temp.rv(p_seq integer, p_hash text, p_new_hash text, p_draft jsonb, p_prev jsonb, p_by text) returns uuid language sql as $$
  select newquip_apply_pricing_revision('00000000-0000-0000-0000-0000000126b1', '00000000-0000-0000-0000-0000000126c3', p_seq, p_hash, p_draft, p_new_hash,
    case when p_prev is null then 'ENABLED' else 'CHANGED' end, 'Verification rule test', 'legacy-poc-v1', p_prev, p_draft #> '{estimator,pricing}', '[]'::jsonb, repeat('a', 64), p_by)
$$;
select pg_temp.rv(0, 'h3', 'h3a', '{"estimator":{"pricing":{"skus":{"A":{"nativeUnitCostMicro":5,"by":"est@x","at":"t"}}}}}'::jsonb, null, 'est@x');
-- a review for a NEW cost, in the same revision that creates it, is refused
select pg_temp.expect_denied($q$select pg_temp.rv(1, 'h3a', 'h3b', '{"estimator":{"pricing":{"skus":{"A":{"nativeUnitCostMicro":5,"by":"est@x","at":"t"},"B":{"nativeUnitCostMicro":7,"by":"est@x","at":"t","review":{"by":"rev@x","at":"t","evidence":"e","inputHash":"h"}}}}}}'::jsonb, '{"skus":{"A":{"nativeUnitCostMicro":5,"by":"est@x","at":"t"}}}'::jsonb, 'rev@x')$q$, 'review for a new cost');
-- the person who entered the cost cannot verify it (even if they record the revision themselves)
select pg_temp.expect_denied($q$select pg_temp.rv(1, 'h3a', 'h3b', '{"estimator":{"pricing":{"skus":{"A":{"nativeUnitCostMicro":5,"by":"est@x","at":"t","review":{"by":"est@x","at":"t","evidence":"e","inputHash":"h"}}}}}}'::jsonb, '{"skus":{"A":{"nativeUnitCostMicro":5,"by":"est@x","at":"t"}}}'::jsonb, 'est@x')$q$, 'self verification');
select pg_temp.expect_denied($q$select pg_temp.rv(1, 'h3a', 'h3b', '{"estimator":{"pricing":{"skus":{"A":{"nativeUnitCostMicro":5,"by":"est@x","at":"t","review":{"by":" EST@X ","at":"t","evidence":"e","inputHash":"h"}}}}}}'::jsonb, '{"skus":{"A":{"nativeUnitCostMicro":5,"by":"est@x","at":"t"}}}'::jsonb, ' est@x')$q$, 'self verification, case and spaces');
-- a review attributed to someone other than the person recording the revision is refused
select pg_temp.expect_denied($q$select pg_temp.rv(1, 'h3a', 'h3b', '{"estimator":{"pricing":{"skus":{"A":{"nativeUnitCostMicro":5,"by":"est@x","at":"t","review":{"by":"rev@x","at":"t","evidence":"e","inputHash":"h"}}}}}}'::jsonb, '{"skus":{"A":{"nativeUnitCostMicro":5,"by":"est@x","at":"t"}}}'::jsonb, 'someone.else@x')$q$, 'review attributed to another person');
-- a review recorded together with a change to the cost (value or attribution) is refused
select pg_temp.expect_denied($q$select pg_temp.rv(1, 'h3a', 'h3b', '{"estimator":{"pricing":{"skus":{"A":{"nativeUnitCostMicro":6,"by":"est@x","at":"t","review":{"by":"rev@x","at":"t","evidence":"e","inputHash":"h"}}}}}}'::jsonb, '{"skus":{"A":{"nativeUnitCostMicro":5,"by":"est@x","at":"t"}}}'::jsonb, 'rev@x')$q$, 'review with a cost change');
select pg_temp.expect_denied($q$select pg_temp.rv(1, 'h3a', 'h3b', '{"estimator":{"pricing":{"skus":{"A":{"nativeUnitCostMicro":5,"by":"rev@x","at":"t","review":{"by":"rev@x","at":"t","evidence":"e","inputHash":"h"}}}}}}'::jsonb, '{"skus":{"A":{"nativeUnitCostMicro":5,"by":"est@x","at":"t"}}}'::jsonb, 'rev@x')$q$, 'review with re-attributed entry');
do $$ begin
  if (select draft_hash from newquip_quotes where quote_ref = 'PR-3') <> 'h3a' then raise exception 'a refused verification must change nothing'; end if;
end $$;
-- a genuine independent review of an unchanged cost, recorded by the reviewer (case-insensitive), is accepted
select pg_temp.rv(1, 'h3a', 'h3b', '{"estimator":{"pricing":{"skus":{"A":{"nativeUnitCostMicro":5,"by":"est@x","at":"t","review":{"by":"Rev@X","at":"t","evidence":"e","inputHash":"h"}}}}}}'::jsonb, '{"skus":{"A":{"nativeUnitCostMicro":5,"by":"est@x","at":"t"}}}'::jsonb, 'rev@x');
do $$ begin
  if (select count(*) from newquip_pricing_revisions where quote_id = '00000000-0000-0000-0000-0000000126c3') <> 2 then raise exception 'the independent review must be recorded'; end if;
end $$;
-- once reviewed, a changed cost that still carries the review is refused
select pg_temp.expect_denied($q$select pg_temp.rv(2, 'h3b', 'h3c', '{"estimator":{"pricing":{"skus":{"A":{"nativeUnitCostMicro":9,"by":"est@x","at":"t","review":{"by":"Rev@X","at":"t","evidence":"e","inputHash":"h"}}}}}}'::jsonb, '{"skus":{"A":{"nativeUnitCostMicro":5,"by":"est@x","at":"t","review":{"by":"Rev@X","at":"t","evidence":"e","inputHash":"h"}}}}'::jsonb, 'est@x')$q$, 'changed cost keeping a review');
-- ...but re-saving an unchanged reviewed cost (the review is carried over) is fine, and a changed cost WITHOUT a review is fine
select pg_temp.rv(2, 'h3b', 'h3c', '{"estimator":{"pricing":{"skus":{"A":{"nativeUnitCostMicro":5,"by":"est@x","at":"t","review":{"by":"Rev@X","at":"t","evidence":"e","inputHash":"h"}},"projectNote":1}}}}'::jsonb, '{"skus":{"A":{"nativeUnitCostMicro":5,"by":"est@x","at":"t","review":{"by":"Rev@X","at":"t","evidence":"e","inputHash":"h"}}}}'::jsonb, 'est@x');
select pg_temp.rv(3, 'h3c', 'h3d', '{"estimator":{"pricing":{"skus":{"A":{"nativeUnitCostMicro":9,"by":"est2@x","at":"t2"},"projectNote":1}}}}'::jsonb, '{"skus":{"A":{"nativeUnitCostMicro":5,"by":"est@x","at":"t","review":{"by":"Rev@X","at":"t","evidence":"e","inputHash":"h"}},"projectNote":1}}'::jsonb, 'est2@x');

-- 2d. FORWARD-COVER ATTESTATION (P2-E) + "who entered it" can never be rewritten while an independent review is kept (PR-4). Same structural rules as 2c, for rates.
insert into newquip_quotes (id, org_id, quote_ref, draft, draft_hash) values ('00000000-0000-0000-0000-0000000126c4', '00000000-0000-0000-0000-0000000126b1', 'PR-4', '{"estimator":{}}', 'h4');
create or replace function pg_temp.p4(variant text) returns jsonb language sql as $$
  select case variant
    when 'base'        then '{"skus":{"A":{"nativeUnitCostMicro":5,"by":"est@x","at":"t"}},"forwardCover":{"EUR":{"rateMicro":19000000,"by":"est@x","at":"t"}}}'
    when 'reviewed'    then '{"skus":{"A":{"nativeUnitCostMicro":5,"by":"est@x","at":"t","review":{"by":"Rev@X","at":"t","evidence":"e","inputHash":"h"}}},"forwardCover":{"EUR":{"rateMicro":19000000,"by":"est@x","at":"t","review":{"by":"Rev@X","at":"t","evidence":"fec","inputHash":"h"}}}}'
    when 'self_rate'   then '{"skus":{"A":{"nativeUnitCostMicro":5,"by":"est@x","at":"t"}},"forwardCover":{"EUR":{"rateMicro":19000000,"by":"est@x","at":"t","review":{"by":"est@x","at":"t","evidence":"fec","inputHash":"h"}}}}'
    when 'rate_changed' then '{"skus":{"A":{"nativeUnitCostMicro":5,"by":"est@x","at":"t"}},"forwardCover":{"EUR":{"rateMicro":20000000,"by":"est@x","at":"t","review":{"by":"Rev@X","at":"t","evidence":"fec","inputHash":"h"}}}}'
    when 'new_usd'     then '{"skus":{"A":{"nativeUnitCostMicro":5,"by":"est@x","at":"t"}},"forwardCover":{"EUR":{"rateMicro":19000000,"by":"est@x","at":"t"},"USD":{"rateMicro":18000000,"by":"est@x","at":"t","review":{"by":"Rev@X","at":"t","evidence":"fec","inputHash":"h"}}}}'
    when 'launder_rate' then '{"skus":{"A":{"nativeUnitCostMicro":5,"by":"est@x","at":"t","review":{"by":"Rev@X","at":"t","evidence":"e","inputHash":"h"}}},"forwardCover":{"EUR":{"rateMicro":19000000,"by":"third@x","at":"t","review":{"by":"Rev@X","at":"t","evidence":"fec","inputHash":"h"}}}}'
    when 'launder_cost' then '{"skus":{"A":{"nativeUnitCostMicro":5,"by":"third@x","at":"t","review":{"by":"Rev@X","at":"t","evidence":"e","inputHash":"h"}}},"forwardCover":{"EUR":{"rateMicro":19000000,"by":"est@x","at":"t","review":{"by":"Rev@X","at":"t","evidence":"fec","inputHash":"h"}}}}'
    when 'null_fc'     then '{"skus":{"A":{"nativeUnitCostMicro":5,"by":"est@x","at":"t"}},"forwardCover":null}'
    when 'scalar_skus' then '{"skus":7,"forwardCover":"x"}'
  end::jsonb
$$;
create or replace function pg_temp.go4(p_seq integer, p_hash text, p_new_hash text, p_prev text, p_new text, p_by text) returns uuid language sql as $$
  select newquip_apply_pricing_revision('00000000-0000-0000-0000-0000000126b1', '00000000-0000-0000-0000-0000000126c4', p_seq, p_hash,
    jsonb_build_object('estimator', jsonb_build_object('pricing', pg_temp.p4(p_new))), p_new_hash,
    case when p_prev is null then 'ENABLED' else 'CHANGED' end, 'Attestation rule test', 'legacy-poc-v1',
    case when p_prev is null then null else pg_temp.p4(p_prev) end, pg_temp.p4(p_new), '[]'::jsonb, repeat('a', 64), p_by)
$$;
select pg_temp.go4(0, 'h4', 'h4a', null, 'base', 'est@x');
-- a rate attested by the person who entered it is refused
select pg_temp.expect_denied($q$select pg_temp.go4(1, 'h4a', 'h4b', 'base', 'self_rate', 'est@x')$q$, 'self-attested rate');
-- an attestation attributed to someone other than the person recording the revision is refused
select pg_temp.expect_denied($q$select pg_temp.go4(1, 'h4a', 'h4b', 'base', 'reviewed', 'est@x')$q$, 'attestation recorded by a different person');
-- an attestation recorded together with a change to the rate is refused
select pg_temp.expect_denied($q$select pg_temp.go4(1, 'h4a', 'h4b', 'base', 'rate_changed', 'rev@x')$q$, 'attestation with a changed rate');
-- an attestation for a rate that is new in this revision is refused
select pg_temp.expect_denied($q$select pg_temp.go4(1, 'h4a', 'h4b', 'base', 'new_usd', 'rev@x')$q$, 'attestation for a new rate');
-- nothing was recorded by the refused attempts
do $$ begin if (select count(*) from newquip_pricing_revisions where quote_id = '00000000-0000-0000-0000-0000000126c4') <> 1 then raise exception 'refused attestations must record nothing'; end if; end $$;
-- a genuine independent attestation (and cost review) of unchanged entries, recorded by the reviewer (case-insensitive), is accepted
select pg_temp.go4(1, 'h4a', 'h4b', 'base', 'reviewed', 'rev@x');
do $$ begin if (select count(*) from newquip_pricing_revisions where quote_id = '00000000-0000-0000-0000-0000000126c4') <> 2 then raise exception 'the independent attestation must be recorded'; end if; end $$;
-- LAUNDERING: while the review is KEPT, who entered the rate / cost cannot be rewritten to a third person (a self-attested entry would otherwise read as independent)
select pg_temp.expect_denied($q$select pg_temp.go4(2, 'h4b', 'h4c', 'reviewed', 'launder_rate', 'est@x')$q$, 'rewriting the author of an attested rate');
select pg_temp.expect_denied($q$select pg_temp.go4(2, 'h4b', 'h4c', 'reviewed', 'launder_rate', 'third@x')$q$, 'rewriting the author of an attested rate (as the new author)');
select pg_temp.expect_denied($q$select pg_temp.go4(2, 'h4b', 'h4c', 'reviewed', 'launder_cost', 'est@x')$q$, 'rewriting the author of a verified cost');
select pg_temp.expect_denied($q$select pg_temp.go4(2, 'h4b', 'h4c', 'reviewed', 'launder_cost', 'third@x')$q$, 'rewriting the author of a verified cost (as the new author)');
do $$ begin if (select count(*) from newquip_pricing_revisions where quote_id = '00000000-0000-0000-0000-0000000126c4') <> 2 then raise exception 'refused laundering must record nothing'; end if; end $$;
-- a changed rate WITHOUT a review (the application drops it) is fine
select pg_temp.go4(2, 'h4b', 'h4c', 'reviewed', 'base', 'est@x');
-- robustness: a JSON null / scalar where an object is expected does not crash the function (it never raises an unrelated error)
select pg_temp.go4(3, 'h4c', 'h4d', 'base', 'null_fc', 'est@x');
select pg_temp.go4(4, 'h4d', 'h4e', 'null_fc', 'scalar_skus', 'est@x');

-- 3. ATOMIC: a reason that violates the CHECK after the lock rolls the whole call back, the draft write included
select pg_temp.expect_denied($q$select pg_temp.apply_rev('00000000-0000-0000-0000-0000000126b1', '00000000-0000-0000-0000-0000000126c2', 0, 'h2', 'h2b', 'ENABLED', 'x')$q$, 'reason too short');
do $$ begin
  if (select draft_hash from newquip_quotes where quote_ref = 'PR-2') <> 'h2' then raise exception 'ATOMICITY: the draft changed although the revision could not be stored'; end if;
end $$;

-- 4. kinds are consistent with their values; a second revision is seq 2 and the first is kept
select pg_temp.apply_rev('00000000-0000-0000-0000-0000000126b1', '00000000-0000-0000-0000-0000000126c1', 1, 'h1b', 'h1c', 'CHANGED', 'Forward cover booked');
do $$ begin
  if (select array_agg(seq order by seq) from newquip_pricing_revisions where quote_id = '00000000-0000-0000-0000-0000000126c1') <> array[1, 2] then raise exception 'seq must be 1 then 2'; end if;
end $$;
-- a kind that contradicts its values (ENABLED with a previous pricing) violates the table CHECK and changes nothing
select pg_temp.expect_denied($q$select newquip_apply_pricing_revision('00000000-0000-0000-0000-0000000126b1', '00000000-0000-0000-0000-0000000126c1', 2, 'h1c', '{"estimator":{}}'::jsonb, 'h1d', 'ENABLED', 'Bad kind', 'legacy-poc-v1', '{"revision":1}'::jsonb, '{"revision":2}'::jsonb, '[]'::jsonb, repeat('a', 64), 'est@x')$q$, 'kind/values mismatch');
do $$ begin
  if (select draft_hash from newquip_quotes where quote_ref = 'PR-1') <> 'h1c' then raise exception 'ATOMICITY: a rejected revision changed the draft'; end if;
end $$;

-- 5. append-only: no update, no delete
select pg_temp.expect_denied($q$update newquip_pricing_revisions set reason = 'edited reason'$q$, 'revision update');
select pg_temp.expect_denied($q$update newquip_pricing_revisions set new_pricing = '{}'$q$, 'revision rewrite');
select pg_temp.expect_denied($q$delete from newquip_pricing_revisions$q$, 'revision delete');

-- 6. CONFIDENTIAL (an APPROVED quotation is refused by the function and proved at application level, where its CHECKed baseline can be built): a member of the owning organisation can read nothing and cannot call the function or write
select pg_temp.act_as('00000000-0000-0000-0000-0000000126a1');
select pg_temp.expect_denied($q$select count(*) from newquip_pricing_revisions$q$, 'member select');
select pg_temp.expect_denied($q$select pg_temp.apply_rev('00000000-0000-0000-0000-0000000126b1', '00000000-0000-0000-0000-0000000126c1', 2, 'h1c', 'h1d', 'CHANGED')$q$, 'member calling the function');
select pg_temp.expect_denied($q$delete from newquip_pricing_revisions$q$, 'member delete');
select pg_temp.expect_denied($q$truncate newquip_pricing_revisions$q$, 'member truncate');
select pg_temp.reset_role();

do $$ begin
  if not (has_table_privilege('service_role', 'newquip_pricing_revisions', 'SELECT') and has_table_privilege('service_role', 'newquip_pricing_revisions', 'INSERT')) then raise exception 'service_role must be able to read and insert revisions'; end if;
  if has_table_privilege('service_role', 'newquip_pricing_revisions', 'UPDATE') or has_table_privilege('service_role', 'newquip_pricing_revisions', 'DELETE')
     or has_table_privilege('service_role', 'newquip_pricing_revisions', 'TRUNCATE') then raise exception 'service_role must NOT hold UPDATE / DELETE / TRUNCATE'; end if;
  if has_table_privilege('authenticated', 'newquip_pricing_revisions', 'SELECT') or has_table_privilege('anon', 'newquip_pricing_revisions', 'SELECT') then raise exception 'members and anon must have no privilege'; end if;
end $$;

-- 7. deleting the organisation (the cascade) is the ONLY way rows go
-- (a quotation that HAS revisions cannot be deleted on its own: the append-only guard refuses the cascade; PR-2 has none)
delete from newquip_quotes where quote_ref = 'PR-2';
delete from organizations where id = '00000000-0000-0000-0000-0000000126b1';
do $$ begin
  if exists (select 1 from newquip_pricing_revisions) then raise exception 'organisation deletion must cascade to its revisions'; end if;
end $$;

rollback;
