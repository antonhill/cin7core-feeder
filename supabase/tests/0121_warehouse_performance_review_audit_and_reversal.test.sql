-- Transactional test for migration 0121 (audited Undo Finalisation + a Final review must have a score).
-- BEGIN/ROLLBACK: safe against any DB with 0092 and 0121 applied, leaves no rows.
-- Expect it to print "ALL 0121 ... PASSED". Run as a superuser/postgres (like the other files in this folder).
-- Concurrency (row-lock) behaviour needs real separate connections and is exercised outside this file;
-- everything below is the single-session contract.

begin;

insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000121a1', 'Audit Test Org');

-- --- Posture of the audit table ---------------------------------------------
do $$
declare n integer;
begin
  select count(*) into n from pg_tables where schemaname = 'public' and tablename = 'scorecard_review_events' and rowsecurity;
  if n <> 1 then raise exception 'RLS must be enabled on scorecard_review_events'; end if;
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'scorecard_review_events';
  if n <> 1 then raise exception 'scorecard_review_events should have exactly 1 policy, got %', n; end if;
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'scorecard_review_events' and cmd = 'SELECT';
  if n <> 1 then raise exception 'scorecard_review_events policy must be SELECT-only'; end if;
  -- Browser roles are read-only (no write, no TRUNCATE); anon has nothing.
  select count(*) into n from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'scorecard_review_events' and grantee = 'authenticated' and privilege_type <> 'SELECT';
  if n <> 0 then raise exception 'authenticated must only have SELECT on scorecard_review_events, found % other privileges', n; end if;
  select count(*) into n from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'scorecard_review_events' and grantee = 'anon';
  if n <> 0 then raise exception 'anon must have no privileges on scorecard_review_events'; end if;
  -- The two functions are callable by service_role only.
  select count(*) into n from pg_proc p, aclexplode(p.proacl) a
    where p.proname in ('scorecard_finalise_review', 'scorecard_reverse_finalisation')
      and a.privilege_type = 'EXECUTE' and a.grantee in (0, (select oid from pg_roles where rolname in ('anon')), (select oid from pg_roles where rolname = 'authenticated'));
  if n <> 0 then raise exception 'scorecard_finalise_review / scorecard_reverse_finalisation must not be executable by public/anon/authenticated'; end if;
end $$;

-- --- Fixture ------------------------------------------------------------------
do $$
declare
  def_id uuid; s1 uuid; s2 uuid; m1 uuid; m2 uuid; m3 uuid;
  org uuid := '00000000-0000-0000-0000-0000000121a1';
  actor uuid := '00000000-0000-0000-0000-0000000121b1';
  other uuid := '00000000-0000-0000-0000-0000000121b2';
  r uuid; n int; ev int; msg text;
begin
  insert into scorecard_definitions (name) values ('0121 Test Scorecard') returning id into def_id;
  insert into scorecard_sections (scorecard_definition_id, name, weight, display_order) values (def_id, 'S1', 0.5, 1), (def_id, 'S2', 0.5, 2);
  select id into s1 from scorecard_sections where scorecard_definition_id = def_id and name = 'S1';
  select id into s2 from scorecard_sections where scorecard_definition_id = def_id and name = 'S2';
  insert into scorecard_metric_definitions (scorecard_section_id, category, name, evidence_source, scoring_method, metric_direction, display_order) values (s1, 't', 'K1', 'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 1) returning id into m1;
  insert into scorecard_metric_definitions (scorecard_section_id, category, name, evidence_source, scoring_method, metric_direction, display_order) values (s1, 't', 'K2', 'MANUAL', 'REVIEWER', 'REVIEW_ONLY', 2) returning id into m2;
  insert into scorecard_metric_definitions (scorecard_section_id, category, name, evidence_source, scoring_method, metric_direction, display_order) values (s2, 't', 'K3', 'MANUAL', 'REVIEWER', 'HIGHER_IS_BETTER', 1) returning id into m3;

  insert into scorecard_reviews (organization_id, scorecard_definition_id, review_period, status) values (org, def_id, '2026-11-01', 'draft') returning id into r;

  -- A Final review must have a score (the November 2026 defect), enforced by the database itself.
  begin
    update scorecard_reviews set status = 'final', overall_score = null, definition_snapshot = '{"x":1}', finalised_at = now() where id = r;
    raise exception 'expected a Final review with no score to be rejected';
  exception when check_violation then null; end;

  -- finalise: empty review refused (3 of 3 missing)
  begin perform scorecard_finalise_review(r, org, actor, 5, '{"x":1}'); raise exception 'expected finalising an empty review to be rejected';
  exception when others then if sqlerrm not like '%3 of 3 KPIs are missing a valid score%' then raise; end if; end;

  -- one NULL (not zero) still refused
  insert into scorecard_metric_results (review_id, metric_definition_id, score, status) values (r, m1, 0, 'critical'), (r, m2, null, 'not_scored'), (r, m3, 0, 'critical');
  begin perform scorecard_finalise_review(r, org, actor, 0, '{"x":1}'); raise exception 'expected a NULL score to block finalisation';
  exception when others then if sqlerrm not like '%1 of 3 KPIs are missing a valid score%' then raise; end if; end;

  -- null overall score refused; wrong org refused
  update scorecard_metric_results set score = 0, status = 'critical' where review_id = r and metric_definition_id = m2;
  begin perform scorecard_finalise_review(r, org, actor, null, '{"x":1}'); raise exception 'expected a NULL overall score to be rejected';
  exception when others then if sqlerrm not like '%overall score is required%' then raise; end if; end;
  begin perform scorecard_finalise_review(r, '00000000-0000-0000-0000-0000000121ff', actor, 0, '{"x":1}'); raise exception 'expected another org to be refused';
  exception when others then if sqlerrm not like '%review not found%' then raise; end if; end;

  -- all-zero scores are COMPLETE: a genuine zero is not missing data
  perform scorecard_finalise_review(r, org, actor, 0, '{"x":1}');
  if (select status::text from scorecard_reviews where id = r) <> 'final' then raise exception 'all-zero review should finalise'; end if;
  if (select overall_score from scorecard_reviews where id = r) <> 0 then raise exception 'overall score 0 must be stored as 0, not NULL'; end if;
  select count(*) into ev from scorecard_review_events where review_id = r and event_type = 'finalised' and actor_user_id = actor;
  if ev <> 1 then raise exception 'finalisation must be recorded once in the audit trail, got %', ev; end if;

  -- second finalise refused; direct Final->Draft refused (immutability unchanged)
  begin perform scorecard_finalise_review(r, org, actor, 0, '{"x":1}'); raise exception 'expected double finalise to be rejected';
  exception when others then if sqlerrm not like '%not a draft%' then raise; end if; end;
  begin update scorecard_reviews set status = 'draft' where id = r; raise exception 'expected a direct Final->Draft update to be rejected';
  exception when others then if sqlerrm not like '%finalised review is immutable%' then raise; end if; end;

  -- reversal: reason mandatory; wrong org refused
  begin perform scorecard_reverse_finalisation(r, org, other, '   '); raise exception 'expected a blank reason to be rejected';
  exception when others then if sqlerrm not like '%reason of at least 5 characters%' then raise; end if; end;
  begin perform scorecard_reverse_finalisation(r, '00000000-0000-0000-0000-0000000121ff', other, 'cross tenant attempt'); raise exception 'expected another org to be refused';
  exception when others then if sqlerrm not like '%review not found%' then raise; end if; end;

  perform scorecard_reverse_finalisation(r, org, other, 'Finalised in error');
  if (select status::text from scorecard_reviews where id = r) <> 'draft' then raise exception 'review should be Draft after reversal'; end if;
  select count(*) into n from scorecard_metric_results where review_id = r;
  if n <> 3 then raise exception 'KPI values must be preserved by a reversal, got % rows', n; end if;
  select count(*) into ev from scorecard_review_events where review_id = r and event_type = 'finalisation_reversed' and actor_user_id = other
     and original_finalised_by = actor and original_finalised_at is not null and reason = 'Finalised in error' and overall_score = 0;
  if ev <> 1 then raise exception 'reversal must record who/when/what was reversed and why, got % matching rows', ev; end if;

  -- repeat reversal refused and writes nothing
  begin perform scorecard_reverse_finalisation(r, org, other, 'again'); raise exception 'expected a repeat reversal to be rejected';
  exception when others then if sqlerrm not like '%not finalised%' then raise; end if; end;
  select count(*) into ev from scorecard_review_events where review_id = r and event_type = 'finalisation_reversed';
  if ev <> 1 then raise exception 'a refused reversal must not add an audit row'; end if;

  -- resubmission is recorded after the reversal
  perform scorecard_finalise_review(r, org, actor, 0, '{"x":2}');
  select count(*) into ev from scorecard_review_events where review_id = r;
  if ev <> 3 then raise exception 'expected finalised > reversed > finalised (3 events), got %', ev; end if;

  -- the audit trail is append-only
  begin update scorecard_review_events set reason = 'tampered' where review_id = r; raise exception 'expected audit UPDATE to be rejected';
  exception when others then if sqlerrm not like '%append-only%' then raise; end if; end;
  begin delete from scorecard_review_events where review_id = r; raise exception 'expected direct audit DELETE to be rejected';
  exception when others then if sqlerrm not like '%append-only%' then raise; end if; end;

  -- cleanup: cascading delete from the definition removes reviews and (via cascade) their audit rows
  delete from scorecard_definitions where id = def_id;
end $$;

do $$ begin raise notice 'ALL 0121 WAREHOUSE PERFORMANCE AUDIT/REVERSAL TESTS PASSED'; end $$;

rollback;
