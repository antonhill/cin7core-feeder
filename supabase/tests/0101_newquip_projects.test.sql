-- Transactional test for migration 0101 (Projects POC). BEGIN/ROLLBACK — leaves no rows.
-- Covers: RLS (member read / cross-org denial / no member writes), composite-FK org integrity,
-- baseline + stage freeze after approval, claim status machine, "release needs no-write evidence",
-- FAILED_UNCERTAIN stays reserved, frozen approved claim, append-only progress history, uniqueness /
-- idempotency, org-delete cascade. Expect it to print "ALL 0101 ... PASSED".
begin;

grant select, insert, update, delete on projects, project_stages, project_stage_allocations,
  project_progress_events, project_claims, project_claim_lines, project_cin7_links to authenticated, anon;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.reset_role() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); end $$;
-- expect a statement to RAISE (trigger/constraint/RLS) — fails the test if it succeeds
create or replace function pg_temp.expect_denied(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then return; end;
  raise exception 'EXPECTED DENIAL but succeeded: %', label;
end $$;

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000a2');
insert into organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000b1', 'Proj Org A'),
  ('00000000-0000-0000-0000-0000000000b2', 'Proj Org B');
insert into org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'member'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2', 'member');

insert into projects (id, org_id, project_reference, name, customer_name, original_contract_cents, tax_rate_bps, status)
values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1', 'P-001', 'Golden', 'Cust', 1000000000, 1500, 'DRAFT'),
       ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000b2', 'P-001', 'Other org', 'Cust', 100, 0, 'DRAFT');

insert into project_stages (id, org_id, project_id, sort_order, name, value_cents) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', 1, 'Deposit', 100000000),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', 2, 'Manufacturing', 300000000),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', 3, 'Delivery', 200000000);

-- ── activation requires a balanced schedule (stages sum 6m != 10m) ───────────
select pg_temp.expect_denied($q$update projects set status = 'ACTIVE' where id = '00000000-0000-0000-0000-0000000000c1'$q$, 'activate unbalanced project');
select pg_temp.expect_denied($q$insert into project_claims (org_id, project_id, claim_seq, claim_number, claim_date, tax_rate_bps, subtotal_cents, tax_cents, total_cents, snapshot_hash, baseline_hash, idempotency_key, author_email)
  values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',1,'C-1',current_date,1500,0,0,0,'h','b','k0','a@x')$q$, 'claim on non-ACTIVE project');

insert into project_stages (id, org_id, project_id, sort_order, name, value_cents) values
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', 4, 'Rest', 400000000);
update projects set status = 'ACTIVE' where id = '00000000-0000-0000-0000-0000000000c1';

-- ── composite FK: child cannot carry a different org than its parent ─────────
select pg_temp.expect_denied($q$insert into project_stages (org_id, project_id, sort_order, name, value_cents)
  values ('00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000c1',9,'Wrong org',1)$q$, 'stage with mismatched org');

-- ── RLS: member reads own org only; cross-org denied; members cannot write ───
do $$ begin
  perform pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
  if (select count(*) from projects) <> 1 or (select count(*) from project_stages) <> 4 then
    raise exception 'org A member should see exactly its own project + 4 stages';
  end if;
  if exists (select 1 from projects where org_id = '00000000-0000-0000-0000-0000000000b2') then
    raise exception 'cross-org read leaked';
  end if;
  perform pg_temp.reset_role();
end $$;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect_denied($q$insert into projects (org_id, project_reference, name, customer_name, original_contract_cents) values ('00000000-0000-0000-0000-0000000000b1','P-X','x','c',1)$q$, 'member insert project');
update projects set name = 'hacked' where id = '00000000-0000-0000-0000-0000000000c1'; -- RLS: no UPDATE policy => 0 rows, no error; verified below
select pg_temp.reset_role();
do $$ begin
  if (select name from projects where id = '00000000-0000-0000-0000-0000000000c1') = 'hacked' then raise exception 'member write succeeded'; end if;
end $$;

-- ── progress history is append-only ─────────────────────────────────────────
insert into project_progress_events (org_id, project_id, stage_id, reported_bps, approved_bps, previous_reported_bps, previous_approved_bps, comment, recorded_by_email)
values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000d2',7500,6500,0,0,'first','pm@x');
select pg_temp.expect_denied($q$update project_progress_events set approved_bps = 1$q$, 'update progress event');
select pg_temp.expect_denied($q$delete from project_progress_events$q$, 'delete progress event');
select pg_temp.expect_denied($q$insert into project_progress_events (org_id, project_id, stage_id, reported_bps, approved_bps, recorded_by_email)
  values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000d2',10001,0,'x')$q$, '>100% completion');

-- ── claims: draft -> lines -> approve -> frozen ─────────────────────────────
insert into project_claims (id, org_id, project_id, claim_seq, claim_number, claim_date, tax_rate_bps, subtotal_cents, tax_cents, total_cents, snapshot_hash, baseline_hash, idempotency_key, author_email)
values ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',1,'PRJ-001-C1',current_date,1500,45000000,6750000,51750000,'snap1','base1','idem-1','a@x');
insert into project_claim_lines (org_id, project_id, claim_id, stage_id, stage_name, stage_value_cents, approved_bps, earned_to_date_cents, previously_committed_cents, current_claim_cents, tax_cents)
values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000d2','Manufacturing',300000000,1500,45000000,0,45000000,6750000);

-- line arithmetic is checked by the DB itself
select pg_temp.expect_denied($q$insert into project_claim_lines (org_id, project_id, claim_id, stage_id, stage_name, stage_value_cents, approved_bps, earned_to_date_cents, previously_committed_cents, current_claim_cents, tax_cents)
  values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000d3','Delivery',200000000,2500,50000000,0,49999999,0)$q$, 'line arithmetic mismatch');
-- duplicate idempotency key / claim number rejected
select pg_temp.expect_denied($q$insert into project_claims (org_id, project_id, claim_seq, claim_number, claim_date, tax_rate_bps, subtotal_cents, tax_cents, total_cents, snapshot_hash, baseline_hash, idempotency_key, author_email)
  values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',2,'PRJ-001-C2',current_date,1500,0,0,0,'h','b','idem-1','a@x')$q$, 'duplicate idempotency key');
-- approval requires an approver
select pg_temp.expect_denied($q$update project_claims set status = 'APPROVED' where id = '00000000-0000-0000-0000-0000000000e1'$q$, 'approve skipping READY / no approver');
update project_claims set status = 'READY_FOR_APPROVAL' where id = '00000000-0000-0000-0000-0000000000e1';
update project_claims set status = 'APPROVED', approver_email = 'mgr@x', approved_at = now() where id = '00000000-0000-0000-0000-0000000000e1';

-- frozen: lines, financials, baseline, stages
select pg_temp.expect_denied($q$update project_claim_lines set current_claim_cents = 1, earned_to_date_cents = 1 where claim_id = '00000000-0000-0000-0000-0000000000e1'$q$, 'edit approved claim line');
select pg_temp.expect_denied($q$delete from project_claim_lines where claim_id = '00000000-0000-0000-0000-0000000000e1'$q$, 'delete approved claim line');
select pg_temp.expect_denied($q$update project_claims set subtotal_cents = 1, tax_cents = 0, total_cents = 1 where id = '00000000-0000-0000-0000-0000000000e1'$q$, 'edit approved claim totals');
select pg_temp.expect_denied($q$update projects set original_contract_cents = 1 where id = '00000000-0000-0000-0000-0000000000c1'$q$, 'change contract after approval');
select pg_temp.expect_denied($q$update projects set customer_name = 'Someone else' where id = '00000000-0000-0000-0000-0000000000c1'$q$, 'change customer after approval');
select pg_temp.expect_denied($q$update projects set tax_rate_bps = 0 where id = '00000000-0000-0000-0000-0000000000c1'$q$, 'change tax after approval');
select pg_temp.expect_denied($q$update project_stages set value_cents = value_cents + 1 where id = '00000000-0000-0000-0000-0000000000d2'$q$, 'rewrite stage value after approval');
select pg_temp.expect_denied($q$delete from project_stages where id = '00000000-0000-0000-0000-0000000000d4'$q$, 'delete stage after approval');
select pg_temp.expect_denied($q$delete from project_claims where id = '00000000-0000-0000-0000-0000000000e1'$q$, 'delete a claim');
-- allowed: non-baseline metadata
update projects set project_manager = 'New PM' where id = '00000000-0000-0000-0000-0000000000c1';

-- ── status machine + ambiguous failure never auto-releases ──────────────────
select pg_temp.expect_denied($q$update project_claims set status = 'DRAFT' where id = '00000000-0000-0000-0000-0000000000e1'$q$, 'APPROVED -> DRAFT');
select pg_temp.expect_denied($q$update project_claims set status = 'CANCELLED_BEFORE_WRITE' where id = '00000000-0000-0000-0000-0000000000e1'$q$, 'release APPROVED without evidence');
update project_claims set status = 'CIN7_PENDING' where id = '00000000-0000-0000-0000-0000000000e1';
update project_claims set status = 'FAILED_UNCERTAIN' where id = '00000000-0000-0000-0000-0000000000e1';
select pg_temp.expect_denied($q$update project_claims set status = 'FAILED_CONFIRMED_NO_WRITE' where id = '00000000-0000-0000-0000-0000000000e1'$q$, 'release FAILED_UNCERTAIN without evidence');
select pg_temp.expect_denied($q$update project_claims set status = 'DRAFT' where id = '00000000-0000-0000-0000-0000000000e1'$q$, 'FAILED_UNCERTAIN -> DRAFT');
do $$ begin
  if not project_has_committed_claim('00000000-0000-0000-0000-0000000000c1') then
    raise exception 'FAILED_UNCERTAIN must keep the project committed/reserved';
  end if;
end $$;
update project_claims set status = 'FAILED_CONFIRMED_NO_WRITE',
  no_write_evidence = '{"method":"EXTERNAL_ID_LOOKUP_EMPTY","detail":"no sale carries ExternalID"}'::jsonb
  where id = '00000000-0000-0000-0000-0000000000e1';
select pg_temp.expect_denied($q$update project_claims set status = 'APPROVED' where id = '00000000-0000-0000-0000-0000000000e1'$q$, 'resurrect a released claim');
do $$ begin
  if project_has_committed_claim('00000000-0000-0000-0000-0000000000c1') then
    raise exception 'a positively-proven no-write claim should release the baseline lock';
  end if;
end $$;

-- ── stale-draft lineage: a superseding draft references its predecessor ────
insert into project_claims (id, org_id, project_id, claim_seq, claim_number, claim_date, tax_rate_bps, subtotal_cents, tax_cents, total_cents, snapshot_hash, baseline_hash, idempotency_key, author_email, supersedes_claim_id)
values ('00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',2,'PRJ-001-C2',current_date,1500,0,0,0,'snap2','base1','idem-2','a@x','00000000-0000-0000-0000-0000000000e1');
select pg_temp.expect_denied($q$insert into project_claims (org_id, project_id, claim_seq, claim_number, claim_date, tax_rate_bps, subtotal_cents, tax_cents, total_cents, snapshot_hash, baseline_hash, idempotency_key, author_email, supersedes_claim_id)
  values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1',3,'PRJ-001-C3',current_date,1500,0,0,0,'s','b','idem-3','a@x','00000000-0000-0000-0000-0000000000ff')$q$, 'supersedes a claim that does not exist / other project');
-- the superseded (released) claim keeps its lines untouched and stays final
do $$ begin
  if (select count(*) from project_claim_lines where claim_id = '00000000-0000-0000-0000-0000000000e1') <> 1 then
    raise exception 'superseded claim must keep its original lines';
  end if;
end $$;

-- ── one Cin7 link per claim ─────────────────────────────────────────────────
insert into project_cin7_links (org_id, project_id, claim_id, external_id)
values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000e1','PRJ-001-C1');
select pg_temp.expect_denied($q$insert into project_cin7_links (org_id, project_id, claim_id, external_id)
  values ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000e1','PRJ-001-C1-DUP')$q$, 'second Cin7 link for one claim');

-- ── deleting the organization cascades cleanly through every guard ──────────
delete from organizations where id = '00000000-0000-0000-0000-0000000000b1';
do $$ begin
  if exists (select 1 from projects where org_id = '00000000-0000-0000-0000-0000000000b1')
     or exists (select 1 from project_claims) or exists (select 1 from project_progress_events) then
    raise exception 'org delete did not cascade';
  end if;
  raise notice 'ALL 0101 projects tests PASSED';
end $$;

rollback;
