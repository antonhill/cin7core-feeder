-- Transactional test for migration 0115 (customer snapshots, company profile, issued documents, sends, responses, grandfathering). BEGIN/ROLLBACK - leaves no rows.
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

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000015a1'), ('00000000-0000-0000-0000-0000000015a2');
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000015b1', 'CD Org A'), ('00000000-0000-0000-0000-0000000015b2', 'CD Org B');
insert into org_members (org_id, user_id, role) values ('00000000-0000-0000-0000-0000000015b1', '00000000-0000-0000-0000-0000000015a1', 'member'), ('00000000-0000-0000-0000-0000000015b2', '00000000-0000-0000-0000-0000000015a2', 'member');

-- Two quotes in org A, one in org B. Q1 / Q2 are created BEFORE the cutover flag matters: simulate a grandfathered quote by explicit FALSE.
insert into newquip_quotes (id, org_id, quote_ref, draft, draft_hash, requires_customer_acceptance) values
  ('00000000-0000-0000-0000-0000000015c1', '00000000-0000-0000-0000-0000000015b1', 'CD-1', '{}', 'h1', false),
  ('00000000-0000-0000-0000-0000000015c2', '00000000-0000-0000-0000-0000000015b1', 'CD-2', '{}', 'h2', default),
  ('00000000-0000-0000-0000-0000000015c3', '00000000-0000-0000-0000-0000000015b2', 'CD-3', '{}', 'h3', default);
do $$ begin
  if (select requires_customer_acceptance from newquip_quotes where quote_ref = 'CD-1') <> false then raise exception 'explicit grandfathered flag lost'; end if;
  if (select requires_customer_acceptance from newquip_quotes where quote_ref = 'CD-2') <> true then raise exception 'new quotes must default to requiring customer acceptance'; end if;
end $$;
-- a quotation that is not yet approved must NOT be exempt (only the migration's backfill sets non-approved rows TRUE; here the default does)
do $$ begin
  if exists (select 1 from newquip_quotes where state <> 'MANAGER_APPROVED_FINAL' and requires_customer_acceptance = false and quote_ref <> 'CD-1') then raise exception 'unapproved quotations must require acceptance'; end if;
end $$;
-- the flag is fixed at creation (never altered retroactively)
select pg_temp.expect_denied($q$update newquip_quotes set requires_customer_acceptance = true where quote_ref = 'CD-1'$q$, 'changing the grandfathering flag');
select pg_temp.expect_denied($q$update newquip_quotes set requires_customer_acceptance = false where quote_ref = 'CD-2'$q$, 'waiving the acceptance requirement');

-- customer snapshots: append-only, org-consistent, only before approval
insert into newquip_quote_customers (org_id, quote_id, seq, cin7_customer_id, snapshot, snapshot_hash, captured_by_email)
values ('00000000-0000-0000-0000-0000000015b1', '00000000-0000-0000-0000-0000000015c2', 1, 'cin7-cust-1', '{"name":{"state":"present","value":"Farm"}}', repeat('a', 64), 'rep@x');
select pg_temp.expect_denied($q$insert into newquip_quote_customers (org_id, quote_id, seq, cin7_customer_id, snapshot, snapshot_hash, captured_by_email) values ('00000000-0000-0000-0000-0000000015b1', '00000000-0000-0000-0000-0000000015c2', 1, 'x', '{}', repeat('a', 64), 'r@x')$q$, 'duplicate seq');
select pg_temp.expect_denied($q$insert into newquip_quote_customers (org_id, quote_id, seq, cin7_customer_id, snapshot, snapshot_hash, captured_by_email) values ('00000000-0000-0000-0000-0000000015b2', '00000000-0000-0000-0000-0000000015c2', 2, 'x', '{}', repeat('a', 64), 'r@x')$q$, 'snapshot for another organisation''s quotation');
select pg_temp.expect_denied($q$insert into newquip_quote_customers (org_id, quote_id, seq, cin7_customer_id, snapshot, snapshot_hash, captured_by_email) values ('00000000-0000-0000-0000-0000000015b1', '00000000-0000-0000-0000-0000000015c2', 2, '  ', '{}', repeat('a', 64), 'r@x')$q$, 'blank customer id');
select pg_temp.expect_denied($q$update newquip_quote_customers set cin7_customer_id = 'changed'$q$, 'snapshot update');
select pg_temp.expect_denied($q$delete from newquip_quote_customers$q$, 'snapshot delete');

-- company profile versions are assigned by the database and are immutable
insert into newquip_company_profiles (org_id, version, profile, entered_by_email) values ('00000000-0000-0000-0000-0000000015b1', 77, '{"legalName":"NewQuip (Pty) Ltd"}', 'm@x');
insert into newquip_company_profiles (org_id, profile, entered_by_email) values ('00000000-0000-0000-0000-0000000015b1', '{"legalName":"NewQuip (Pty) Ltd v2"}', 'm@x');
do $$ begin
  if (select array_agg(version order by version) from newquip_company_profiles where org_id = '00000000-0000-0000-0000-0000000015b1') <> array[1, 2] then raise exception 'profile versions must be 1 then 2'; end if;
end $$;
select pg_temp.expect_denied($q$update newquip_company_profiles set profile = '{}'$q$, 'profile update');
select pg_temp.expect_denied($q$delete from newquip_company_profiles$q$, 'profile delete');

-- documents cannot be issued for an unapproved quotation
select pg_temp.expect_denied($q$insert into newquip_quote_documents (org_id, quote_id, quote_ref, revision, version, baseline_hash, customer_snapshot_id, company_profile_id, storage_path, content_hash, byte_size, content, issued_by_email)
  select '00000000-0000-0000-0000-0000000015b1', '00000000-0000-0000-0000-0000000015c2', 'CD-2', 1, 1, repeat('b', 64), c.id, p.id, 'p/unapproved.pdf', repeat('c', 64), 10, '{}', 'm@x' from newquip_quote_customers c, newquip_company_profiles p where p.version = 1 limit 1$q$, 'document for an unapproved quotation');

-- approve CD-2 (the normal path: ESTIMATOR_REVIEW then MANAGER_APPROVED_FINAL with the sealed baseline)
update newquip_quotes set state = 'ESTIMATOR_REVIEW' where quote_ref = 'CD-2';
update newquip_quotes set state = 'MANAGER_APPROVED_FINAL', accepted_baseline = '{"x":1}', baseline_hash = repeat('b', 64), contract_cents = 1000, approved_by_email = 'm@x', approved_at = now(),
  customer_confirmed_cents = 1000, estimator_signoff_hash = 'h2', estimator_signoff_at = now(), estimator_signoff_by_email = 'e@x' where quote_ref = 'CD-2';
-- an approved quotation's customer snapshot is immutable: no new snapshot
select pg_temp.expect_denied($q$insert into newquip_quote_customers (org_id, quote_id, seq, cin7_customer_id, snapshot, snapshot_hash, captured_by_email) values ('00000000-0000-0000-0000-0000000015b1', '00000000-0000-0000-0000-0000000015c2', 2, 'cin7-cust-2', '{}', repeat('a', 64), 'r@x')$q$, 'new snapshot after approval');

-- documents: must match the approved revision / baseline / quote ref / own snapshot
select pg_temp.expect_denied($q$insert into newquip_quote_documents (org_id, quote_id, quote_ref, revision, version, baseline_hash, customer_snapshot_id, company_profile_id, storage_path, content_hash, byte_size, content, issued_by_email)
  select '00000000-0000-0000-0000-0000000015b1', '00000000-0000-0000-0000-0000000015c2', 'CD-2', 1, 1, repeat('d', 64), c.id, p.id, 'p/wrong-hash.pdf', repeat('c', 64), 10, '{}', 'm@x' from newquip_quote_customers c, newquip_company_profiles p where p.version = 1 limit 1$q$, 'document with a different baseline hash');
select pg_temp.expect_denied($q$insert into newquip_quote_documents (org_id, quote_id, quote_ref, revision, version, baseline_hash, customer_snapshot_id, company_profile_id, storage_path, content_hash, byte_size, content, issued_by_email)
  select '00000000-0000-0000-0000-0000000015b1', '00000000-0000-0000-0000-0000000015c2', 'CD-2', 2, 1, repeat('b', 64), c.id, p.id, 'p/wrong-rev.pdf', repeat('c', 64), 10, '{}', 'm@x' from newquip_quote_customers c, newquip_company_profiles p where p.version = 1 limit 1$q$, 'document for a different revision');
insert into newquip_quote_documents (id, org_id, quote_id, quote_ref, revision, version, baseline_hash, customer_snapshot_id, company_profile_id, storage_path, content_hash, byte_size, content, issued_by_email)
  select '00000000-0000-0000-0000-0000000015d1', '00000000-0000-0000-0000-0000000015b1', '00000000-0000-0000-0000-0000000015c2', 'CD-2', 1, 1, repeat('b', 64), c.id, p.id, 'orgA/CD-2/r1-v1.pdf', repeat('c', 64), 10, '{"sections":[]}', 'm@x'
  from newquip_quote_customers c, newquip_company_profiles p where p.version = 1 limit 1;
select pg_temp.expect_denied($q$insert into newquip_quote_documents (org_id, quote_id, quote_ref, revision, version, baseline_hash, customer_snapshot_id, company_profile_id, storage_path, content_hash, byte_size, content, issued_by_email)
  select '00000000-0000-0000-0000-0000000015b1', '00000000-0000-0000-0000-0000000015c2', 'CD-2', 1, 1, repeat('b', 64), c.id, p.id, 'orgA/CD-2/r1-v1-again.pdf', repeat('e', 64), 10, '{}', 'm@x' from newquip_quote_customers c, newquip_company_profiles p where p.version = 1 limit 1$q$, 'a second document under the same version');
select pg_temp.expect_denied($q$update newquip_quote_documents set content_hash = repeat('f', 64)$q$, 'issued document update');
select pg_temp.expect_denied($q$delete from newquip_quote_documents$q$, 'issued document delete');

-- sends: unique idempotency per document, outcome-only updates, ACCEPTED never regresses, re-send needs a reason
insert into newquip_quote_sends (id, org_id, quote_id, document_id, idempotency_key, to_emails, subject, sent_by_email)
values ('00000000-0000-0000-0000-0000000015e1', '00000000-0000-0000-0000-0000000015b1', '00000000-0000-0000-0000-0000000015c2', '00000000-0000-0000-0000-0000000015d1', 'k1', array['rep@sparkconsulting.co.za'], '[PREVIEW] Quote', 'rep@x');
select pg_temp.expect_denied($q$insert into newquip_quote_sends (org_id, quote_id, document_id, idempotency_key, to_emails, subject, sent_by_email) values ('00000000-0000-0000-0000-0000000015b1', '00000000-0000-0000-0000-0000000015c2', '00000000-0000-0000-0000-0000000015d1', 'k1', array['a@b.co'], 's', 'rep@x')$q$, 'duplicate send (same idempotency key)');
select pg_temp.expect_denied($q$insert into newquip_quote_sends (org_id, quote_id, document_id, idempotency_key, to_emails, subject, sent_by_email) values ('00000000-0000-0000-0000-0000000015b1', '00000000-0000-0000-0000-0000000015c1', '00000000-0000-0000-0000-0000000015d1', 'k2', array['a@b.co'], 's', 'rep@x')$q$, 'send naming another quotation');
select pg_temp.expect_denied($q$insert into newquip_quote_sends (org_id, quote_id, document_id, idempotency_key, to_emails, subject, sent_by_email, resend_of) values ('00000000-0000-0000-0000-0000000015b1', '00000000-0000-0000-0000-0000000015c2', '00000000-0000-0000-0000-0000000015d1', 'k3', array['a@b.co'], 's', 'rep@x', '00000000-0000-0000-0000-0000000015e1')$q$, 're-send without a reason');
select pg_temp.expect_denied($q$update newquip_quote_sends set status = 'ACCEPTED' where id = '00000000-0000-0000-0000-0000000015e1'$q$, 'ACCEPTED without a provider message id');
select pg_temp.expect_denied($q$update newquip_quote_sends set to_emails = array['evil@x.co'] where id = '00000000-0000-0000-0000-0000000015e1'$q$, 'rewriting recipients');
update newquip_quote_sends set status = 'ACCEPTED', provider_message_id = 'msg-1', attempted_at = now() where id = '00000000-0000-0000-0000-0000000015e1';
select pg_temp.expect_denied($q$update newquip_quote_sends set status = 'FAILED' where id = '00000000-0000-0000-0000-0000000015e1'$q$, 'ACCEPTED regressing');
select pg_temp.expect_denied($q$insert into newquip_quote_sends (org_id, quote_id, document_id, idempotency_key, to_emails, subject, sent_by_email, alternative_recipients) values ('00000000-0000-0000-0000-0000000015b1', '00000000-0000-0000-0000-0000000015c2', '00000000-0000-0000-0000-0000000015d1', 'k9', array['a@b.co'], 's', 'rep@x', array['a@b.co'])$q$, 'alternative recipient without an audited reason');
select pg_temp.expect_denied($q$delete from newquip_quote_sends$q$, 'send delete');

-- responses: append-only, evidence required, bound to a document of the same quotation
insert into newquip_quote_responses (org_id, quote_id, document_id, response, contact_name, responded_on, evidence_ref, recorded_by_email)
values ('00000000-0000-0000-0000-0000000015b1', '00000000-0000-0000-0000-0000000015c2', '00000000-0000-0000-0000-0000000015d1', 'ACCEPTED', 'Farmer Joe', current_date, 'email 2026-10-29', 'rep@x');
select pg_temp.expect_denied($q$insert into newquip_quote_responses (org_id, quote_id, document_id, response, contact_name, responded_on, evidence_ref, recorded_by_email) values ('00000000-0000-0000-0000-0000000015b1', '00000000-0000-0000-0000-0000000015c2', '00000000-0000-0000-0000-0000000015d1', 'ACCEPTED', 'J', current_date, '', 'rep@x')$q$, 'response without evidence');
select pg_temp.expect_denied($q$insert into newquip_quote_responses (org_id, quote_id, document_id, response, contact_name, responded_on, evidence_ref, recorded_by_email) values ('00000000-0000-0000-0000-0000000015b1', '00000000-0000-0000-0000-0000000015c2', '00000000-0000-0000-0000-0000000015d1', 'CHANGES_REQUESTED', 'J', current_date, 'email', 'rep@x')$q$, 'changes requested without a note');
select pg_temp.expect_denied($q$insert into newquip_quote_responses (org_id, quote_id, document_id, response, contact_name, responded_on, evidence_ref, recorded_by_email) values ('00000000-0000-0000-0000-0000000015b1', '00000000-0000-0000-0000-0000000015c1', '00000000-0000-0000-0000-0000000015d1', 'DECLINED', 'J', current_date, 'email', 'rep@x')$q$, 'response naming another quotation');
select pg_temp.expect_denied($q$update newquip_quote_responses set response = 'DECLINED'$q$, 'response update');
select pg_temp.expect_denied($q$delete from newquip_quote_responses$q$, 'response delete');

-- the approved quotation is still frozen except for its project link (the new objects did not weaken the 0102 guard)
select pg_temp.expect_denied($q$update newquip_quotes set contract_cents = 999 where quote_ref = 'CD-2'$q$, 'editing an approved quotation');

-- storage bucket is private
do $$ begin
  if (select public from storage.buckets where id = 'newquip-quote-documents') is distinct from false then raise exception 'the quotation bucket must be private'; end if;
end $$;

-- RLS: members read their own organisation only; no client writes anywhere
select pg_temp.act_as('00000000-0000-0000-0000-0000000015a1');
do $$ begin
  if (select count(*) from newquip_quote_documents) <> 1 then raise exception 'org A member must see its document'; end if;
  if (select count(*) from newquip_quote_sends) <> 1 then raise exception 'org A member must see its send'; end if;
  if (select count(*) from newquip_quote_customers) <> 1 then raise exception 'org A member must see its snapshot'; end if;
  if (select count(*) from newquip_quote_responses) <> 1 then raise exception 'org A member must see its customer response'; end if;
end $$;
select pg_temp.expect_denied($q$insert into newquip_quote_responses (org_id, quote_id, document_id, response, contact_name, responded_on, evidence_ref, recorded_by_email) values ('00000000-0000-0000-0000-0000000015b1', '00000000-0000-0000-0000-0000000015c2', '00000000-0000-0000-0000-0000000015d1', 'ACCEPTED', 'J', current_date, 'client write', 'x@x')$q$, 'client write to responses');
select pg_temp.expect_denied($q$insert into newquip_company_profiles (org_id, profile, entered_by_email) values ('00000000-0000-0000-0000-0000000015b1', '{}', 'x@x')$q$, 'client write to profiles');
select pg_temp.reset_role();
select pg_temp.act_as('00000000-0000-0000-0000-0000000015a2');
do $$ begin
  if (select count(*) from newquip_quote_documents) <> 0 then raise exception 'org B must not see org A documents'; end if;
  if (select count(*) from newquip_quote_sends) <> 0 then raise exception 'org B must not see org A sends'; end if;
  if (select count(*) from newquip_quote_customers) <> 0 then raise exception 'org B must not see org A customer snapshots'; end if;
  if (select count(*) from newquip_company_profiles) <> 0 then raise exception 'org B must not see org A profiles'; end if;
  if (select count(*) from newquip_quote_responses) <> 0 then raise exception 'org B must not see org A customer responses'; end if;
end $$;
select pg_temp.reset_role();

select 'OK: 0115 customer quotation delivery' as result;
rollback;
