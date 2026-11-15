-- Contract test for the REAL newquip_apply_pricing_revision() (migration 0126; NOT a migration). It pins the persistence contract the application's stale-save merge relies on, against a clean
-- `supabase db reset` database: compare-and-set on the expected draft hash AND revision sequence, atomic revision + draft + sign-off withdrawal, only-estimator.pricing-differs, review structure,
-- and the frozen (approved) quotation. The in-memory FakeDb used by the vitest suite is parity-pinned against exactly these cases (src/lib/newquip-quotes/__tests__/pricing-rpc-parity.test.ts).
-- BEGIN/ROLLBACK - leaves no rows. Run by CI with ON_ERROR_STOP.
begin;

create or replace function pg_temp.expect_denied(sql text, label text, must_match text default 'pricing_conflict') returns void language plpgsql as $$
begin
  begin execute sql; exception when others then
    if sqlerrm !~ must_match then raise exception 'WRONG DENIAL for %: got "%", wanted /%/', label, sqlerrm, must_match; end if;
    return;
  end;
  raise exception 'EXPECTED DENIAL but succeeded: %', label;
end $$;

insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000127b1', 'Contract Org');
insert into newquip_quotes (id, org_id, quote_ref, draft, draft_hash) values
  ('00000000-0000-0000-0000-0000000127c1', '00000000-0000-0000-0000-0000000127b1', 'CT-1', '{"estimator":{},"customerName":"Cust"}', 'k0'),
  ('00000000-0000-0000-0000-0000000127c2', '00000000-0000-0000-0000-0000000127b1', 'CT-2', '{"estimator":{},"customerName":"Cust"}', 'f0');
update newquip_quotes set state = 'ESTIMATOR_REVIEW', customer_confirmed_cents = 100000, customer_confirmed_by = 'Farmer', customer_confirmed_at = now(), handoff_by_email = 'rep@x'
  where quote_ref in ('CT-1', 'CT-2');
update newquip_quotes set estimator_signoff_hash = 'k0', estimator_signoff_by_email = 'est@x', estimator_signoff_at = now() where quote_ref = 'CT-1';

-- one apply call: keeps customerName and every other draft key untouched, replaces only estimator.pricing
create or replace function pg_temp.ap(p_quote uuid, p_seq integer, p_hash text, p_new_hash text, p_prev jsonb, p_new jsonb, p_by text default 'a@x', p_reason text default 'Contract test') returns uuid language sql as $$
  select newquip_apply_pricing_revision('00000000-0000-0000-0000-0000000127b1', p_quote, p_seq, p_hash,
    jsonb_build_object('estimator', jsonb_build_object('pricing', p_new), 'customerName', 'Cust'), p_new_hash,
    case when p_prev is null then 'ENABLED' else 'CHANGED' end, p_reason, 'legacy-poc-v1', p_prev, p_new, '[]'::jsonb, repeat('b', 64), p_by)
$$;
create or replace function pg_temp.price(cost integer, by text default 'a@x') returns jsonb language sql as $$
  select jsonb_build_object('skus', jsonb_build_object('X', jsonb_build_object('nativeUnitCostE7', cost, 'currency', 'EUR', 'by', by, 'at', 't')))
$$;

-- 1. A and B both read the quotation at (seq 0, hash k0). B saves first: revision + draft + sign-off withdrawal in ONE call.
select pg_temp.ap('00000000-0000-0000-0000-0000000127c1', 0, 'k0', 'k1', null, pg_temp.price(100, 'b@x'), 'b@x');
do $$ begin
  if (select count(*) from newquip_pricing_revisions where quote_id = '00000000-0000-0000-0000-0000000127c1') <> 1 then raise exception 'one revision expected'; end if;
  if (select draft_hash from newquip_quotes where quote_ref = 'CT-1') <> 'k1' then raise exception 'draft hash must advance'; end if;
  if (select draft #>> '{estimator,pricing,skus,X,nativeUnitCostE7}' from newquip_quotes where quote_ref = 'CT-1') is distinct from '100' then raise exception 'the new draft must be stored'; end if;
  if (select estimator_signoff_hash from newquip_quotes where quote_ref = 'CT-1') is not null then raise exception 'sign-off must be withdrawn in the same transaction'; end if;
  if (select changed_by_email from newquip_pricing_revisions where quote_id = '00000000-0000-0000-0000-0000000127c1') <> 'b@x' then raise exception 'who must be recorded'; end if;
end $$;

-- 2. The racing second save (A) with the OLD hash and old seq is refused and changes nothing (simulated sequentially).
select pg_temp.expect_denied($q$select pg_temp.ap('00000000-0000-0000-0000-0000000127c1', 0, 'k0', 'k2', null, pg_temp.price(110), 'a@x')$q$, 'stale hash and stale seq');
-- 2b. stale expected_draft_hash alone (right seq)
select pg_temp.expect_denied($q$select pg_temp.ap('00000000-0000-0000-0000-0000000127c1', 1, 'k0', 'k2', pg_temp.price(100, 'b@x'), pg_temp.price(110), 'a@x')$q$, 'stale draft hash', 'changed while the pricing was being edited');
-- 2c. stale expected_seq alone (right hash)
select pg_temp.expect_denied($q$select pg_temp.ap('00000000-0000-0000-0000-0000000127c1', 0, 'k1', 'k2', pg_temp.price(100, 'b@x'), pg_temp.price(110), 'a@x')$q$, 'stale seq', 'pricing changed while it was being edited');
do $$ begin
  if (select draft_hash from newquip_quotes where quote_ref = 'CT-1') <> 'k1' then raise exception 'a refused save must leave the quotation untouched'; end if;
  if (select count(*) from newquip_pricing_revisions where quote_id = '00000000-0000-0000-0000-0000000127c1') <> 1 then raise exception 'a refused save must store no revision'; end if;
end $$;
-- 2d. a save based on the CURRENT hash and seq (what the application's merge produces after re-reading) succeeds
select pg_temp.ap('00000000-0000-0000-0000-0000000127c1', 1, 'k1', 'k2', pg_temp.price(100, 'b@x'), pg_temp.price(110, 'a@x'), 'a@x');
do $$ begin
  if (select array_agg(seq order by seq) from newquip_pricing_revisions where quote_id = '00000000-0000-0000-0000-0000000127c1') is distinct from array[1, 2] then raise exception 'seq must be 1 then 2'; end if;
end $$;

-- 3. A non-pricing draft change under a pricing revision is refused (only estimator.pricing may differ)
select pg_temp.expect_denied($q$select newquip_apply_pricing_revision('00000000-0000-0000-0000-0000000127b1', '00000000-0000-0000-0000-0000000127c1', 2, 'k2',
  '{"estimator":{"pricing":{"skus":{}}},"customerName":"HIJACKED"}'::jsonb, 'k3', 'CHANGED', 'Sneaky', 'legacy-poc-v1', pg_temp.price(110, 'a@x'), '{"skus":{}}'::jsonb, '[]'::jsonb, repeat('b', 64), 'a@x')$q$, 'non-pricing draft change', 'may change only estimator.pricing');
-- 3b. the recorded previous pricing must be the stored pricing; the recorded new pricing must be the one written
select pg_temp.expect_denied($q$select pg_temp.ap('00000000-0000-0000-0000-0000000127c1', 2, 'k2', 'k3', pg_temp.price(999, 'a@x'), pg_temp.price(120), 'a@x')$q$, 'wrong previous pricing', 'previous pricing is not the stored pricing');
select pg_temp.expect_denied($q$select newquip_apply_pricing_revision('00000000-0000-0000-0000-0000000127b1', '00000000-0000-0000-0000-0000000127c1', 2, 'k2',
  jsonb_build_object('estimator', jsonb_build_object('pricing', pg_temp.price(120)), 'customerName', 'Cust'), 'k3', 'CHANGED', 'Mismatch', 'legacy-poc-v1', pg_temp.price(110, 'a@x'), pg_temp.price(121), '[]'::jsonb, repeat('b', 64), 'a@x')$q$, 'wrong new pricing', 'new pricing is not the pricing written');

-- 4. Review structure: the reviewer must be the person recording the change, and must not be the entrant; a review cannot ride on a changed cost
select pg_temp.expect_denied($q$select pg_temp.ap('00000000-0000-0000-0000-0000000127c1', 2, 'k2', 'k3', pg_temp.price(110, 'a@x'),
  '{"skus":{"X":{"nativeUnitCostE7":110,"currency":"EUR","by":"a@x","at":"t","review":{"by":"a@x","at":"t","evidence":"e","inputHash":"h"}}}}'::jsonb, 'a@x')$q$, 'reviewer == entrant', 'cannot be verified by the person who entered it');
select pg_temp.expect_denied($q$select pg_temp.ap('00000000-0000-0000-0000-0000000127c1', 2, 'k2', 'k3', pg_temp.price(110, 'a@x'),
  '{"skus":{"X":{"nativeUnitCostE7":110,"currency":"EUR","by":"a@x","at":"t","review":{"by":"m@x","at":"t","evidence":"e","inputHash":"h"}}}}'::jsonb, 'someone.else@x')$q$, 'reviewer != the person recording', 'must be recorded by the reviewer');
select pg_temp.expect_denied($q$select pg_temp.ap('00000000-0000-0000-0000-0000000127c1', 2, 'k2', 'k3', pg_temp.price(110, 'a@x'),
  '{"skus":{"X":{"nativeUnitCostE7":111,"currency":"EUR","by":"a@x","at":"t","review":{"by":"m@x","at":"t","evidence":"e","inputHash":"h"}}}}'::jsonb, 'm@x')$q$, 'review on a changed cost', 'review cannot be recorded together with a change|a changed cost cannot carry a review');
-- a review for a NEW cost, and a review recorded together with a change to the entrant of the cost, are refused
select pg_temp.expect_denied($q$select pg_temp.ap('00000000-0000-0000-0000-0000000127c1', 2, 'k2', 'k3', pg_temp.price(110, 'a@x'),
  '{"skus":{"X":{"nativeUnitCostE7":110,"currency":"EUR","by":"a@x","at":"t"},"Z":{"nativeUnitCostE7":5,"currency":"EUR","by":"a@x","at":"t","review":{"by":"m@x","at":"t","evidence":"e","inputHash":"h"}}}}'::jsonb, 'm@x')$q$, 'review for a new cost', 'review cannot be recorded for a new cost');
select pg_temp.expect_denied($q$select pg_temp.ap('00000000-0000-0000-0000-0000000127c1', 2, 'k2', 'k3', pg_temp.price(110, 'a@x'),
  '{"skus":{"X":{"nativeUnitCostE7":110,"currency":"EUR","by":"c@x","at":"t","review":{"by":"m@x","at":"t","evidence":"e","inputHash":"h"}}}}'::jsonb, 'm@x')$q$, 'review together with a change to the cost entrant', 'review cannot be recorded together with a change to the cost');
-- a genuine independent review of the unchanged entry is accepted; a LATER change of that cost (a merged save that touched it) must drop the review
select pg_temp.ap('00000000-0000-0000-0000-0000000127c1', 2, 'k2', 'k3', pg_temp.price(110, 'a@x'),
  '{"skus":{"X":{"nativeUnitCostE7":110,"currency":"EUR","by":"a@x","at":"t","review":{"by":"m@x","at":"t","evidence":"e","inputHash":"h"}}}}'::jsonb, 'm@x');
select pg_temp.expect_denied($q$select pg_temp.ap('00000000-0000-0000-0000-0000000127c1', 3, 'k3', 'k4',
  '{"skus":{"X":{"nativeUnitCostE7":110,"currency":"EUR","by":"a@x","at":"t","review":{"by":"m@x","at":"t","evidence":"e","inputHash":"h"}}}}'::jsonb,
  '{"skus":{"X":{"nativeUnitCostE7":110,"currency":"USD","by":"a@x","at":"t","review":{"by":"m@x","at":"t","evidence":"e","inputHash":"h"}}}}'::jsonb, 'a@x')$q$, 'changed currency keeping the cost review', 'a changed cost cannot carry a review');
do $$ begin
  if (select count(*) from newquip_pricing_revisions where quote_id = '00000000-0000-0000-0000-0000000127c1') <> 3 then raise exception 'only the accepted revisions may exist'; end if;
end $$;

-- 5. An approved / final quotation is refused (CT-2 is built to satisfy the frozen-baseline CHECK)
update newquip_quotes set estimator_signoff_hash = 'f0', estimator_signoff_by_email = 'est@x', estimator_signoff_at = now() where quote_ref = 'CT-2';
update newquip_quotes set state = 'MANAGER_APPROVED_FINAL', approved_by_email = 'm@x', approved_at = now(), accepted_baseline = '{"total":100000}', baseline_hash = 'b', contract_cents = 100000 where quote_ref = 'CT-2';
select pg_temp.expect_denied($q$select pg_temp.ap('00000000-0000-0000-0000-0000000127c2', 0, 'f0', 'f1', null, pg_temp.price(100), 'a@x')$q$, 'approved quotation', 'can no longer be edited');
do $$ begin
  if (select draft_hash from newquip_quotes where quote_ref = 'CT-2') <> 'f0' then raise exception 'an approved quotation must be untouched'; end if;
  if exists (select 1 from newquip_pricing_revisions where quote_id = '00000000-0000-0000-0000-0000000127c2') then raise exception 'no revision for an approved quotation'; end if;
end $$;

rollback;
