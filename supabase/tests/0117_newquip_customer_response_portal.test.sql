-- Transactional test for migration 0117 (responding contact, emailed response links, internal review, evidence). BEGIN/ROLLBACK - leaves no rows.
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

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000017a1'), ('00000000-0000-0000-0000-0000000017a2');
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000017b1', 'RP Org A'), ('00000000-0000-0000-0000-0000000017b2', 'RP Org B');
insert into org_members (org_id, user_id, role) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017a1', 'member'), ('00000000-0000-0000-0000-0000000017b2', '00000000-0000-0000-0000-0000000017a2', 'member');

-- Fixture: two approved quotations (A1, A2) in org A, each with a snapshot, profile, issued document and an ACCEPTED send.
insert into newquip_quotes (id, org_id, quote_ref, draft, draft_hash) values
  ('00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017b1', 'RP-1', '{}', 'h1'),
  ('00000000-0000-0000-0000-0000000017c2', '00000000-0000-0000-0000-0000000017b1', 'RP-2', '{}', 'h2');
insert into newquip_quote_customers (org_id, quote_id, seq, cin7_customer_id, snapshot, snapshot_hash, captured_by_email) values
  ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', 1, 'c1', '{"name":{"state":"present","value":"Farm"}}', repeat('a', 64), 'rep@x'),
  ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c2', 1, 'c2', '{"name":{"state":"present","value":"Farm 2"}}', repeat('a', 64), 'rep@x');
insert into newquip_company_profiles (org_id, profile, entered_by_email) values ('00000000-0000-0000-0000-0000000017b1', '{"legalName":"NewQuip"}', 'm@x');
update newquip_quotes set state = 'ESTIMATOR_REVIEW' where quote_ref in ('RP-1', 'RP-2');
update newquip_quotes set state = 'MANAGER_APPROVED_FINAL', accepted_baseline = '{"x":1}', baseline_hash = repeat('b', 64), contract_cents = 1000, approved_by_email = 'm@x', approved_at = now(),
  customer_confirmed_cents = 1000, estimator_signoff_hash = draft_hash, estimator_signoff_at = now(), estimator_signoff_by_email = 'e@x' where quote_ref in ('RP-1', 'RP-2');
insert into newquip_quote_documents (id, org_id, quote_id, quote_ref, revision, version, baseline_hash, customer_snapshot_id, company_profile_id, storage_path, content_hash, byte_size, content, issued_by_email)
  select '00000000-0000-0000-0000-0000000017d1', '00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', 'RP-1', 1, 1, repeat('b', 64), c.id, p.id, '00000000-0000-0000-0000-0000000017b1/RP-1/r1.pdf', repeat('c', 64), 10, '{}', 'm@x'
  from newquip_quote_customers c, newquip_company_profiles p where c.quote_id = '00000000-0000-0000-0000-0000000017c1' limit 1;
insert into newquip_quote_documents (id, org_id, quote_id, quote_ref, revision, version, baseline_hash, customer_snapshot_id, company_profile_id, storage_path, content_hash, byte_size, content, issued_by_email)
  select '00000000-0000-0000-0000-0000000017d2', '00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c2', 'RP-2', 1, 1, repeat('b', 64), c.id, p.id, '00000000-0000-0000-0000-0000000017b1/RP-2/r1.pdf', repeat('d', 64), 10, '{}', 'm@x'
  from newquip_quote_customers c, newquip_company_profiles p where c.quote_id = '00000000-0000-0000-0000-0000000017c2' limit 1;
insert into newquip_quote_sends (id, org_id, quote_id, document_id, idempotency_key, to_emails, subject, sent_by_email) values
  ('00000000-0000-0000-0000-0000000017e1', '00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017d1', 'k1', array['anton@sparkconsulting.co.za'], '[PREVIEW] Q', 'rep@x'),
  ('00000000-0000-0000-0000-0000000017e2', '00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c2', '00000000-0000-0000-0000-0000000017d2', 'k1', array['anton@sparkconsulting.co.za'], '[PREVIEW] Q', 'rep@x');

-- an existing-style (staff) response is untouched by the new columns
insert into newquip_quote_responses (id, org_id, quote_id, document_id, response, contact_name, responded_on, evidence_ref, recorded_by_email)
values ('00000000-0000-0000-0000-0000000017f0', '00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c2', '00000000-0000-0000-0000-0000000017d2', 'DECLINED', 'Joe', current_date, 'email', 'rep@x');
do $$ begin
  if (select origin from newquip_quote_responses where id = '00000000-0000-0000-0000-0000000017f0') <> 'STAFF' then raise exception 'existing-style responses must be origin STAFF'; end if;
  if (select authority_confirmed from newquip_quote_responses where id = '00000000-0000-0000-0000-0000000017f0') <> false then raise exception 'authority_confirmed defaults false'; end if;
end $$;
-- an alternative responding contact needs an audited reason
select pg_temp.expect_denied($q$insert into newquip_quote_responses (org_id, quote_id, document_id, response, contact_name, responded_on, evidence_ref, recorded_by_email, contact_source, exception_reason) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c2', '00000000-0000-0000-0000-0000000017d2', 'DECLINED', 'Joe', current_date, 'email', 'rep@x', 'ALTERNATIVE', '')$q$, 'alternative contact without a reason');
select pg_temp.expect_denied($q$insert into newquip_quote_responses (org_id, quote_id, document_id, response, contact_name, responded_on, evidence_ref, recorded_by_email, contact_source) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c2', '00000000-0000-0000-0000-0000000017d2', 'DECLINED', 'Joe', current_date, 'email', 'rep@x', 'GUESS')$q$, 'unknown contact source');
select pg_temp.expect_denied($q$insert into newquip_quote_responses (org_id, quote_id, document_id, response, contact_name, responded_on, evidence_ref, recorded_by_email, origin) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c2', '00000000-0000-0000-0000-0000000017d2', 'DECLINED', 'Joe', current_date, 'email', 'rep@x', 'ROBOT')$q$, 'unknown origin');

-- ── links ──
insert into newquip_response_links (id, org_id, quote_id, document_id, send_id, document_hash, baseline_hash, revision, customer_name, recipients, allowed_actions, token_hash, environment, expires_at, created_by_email)
values ('00000000-0000-0000-0000-000000001701', '00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017d1', '00000000-0000-0000-0000-0000000017e1', repeat('c', 64), repeat('b', 64), 1, 'Farm',
  array['anton@sparkconsulting.co.za'], array['ACCEPTED', 'DECLINED', 'CHANGES_REQUESTED'], repeat('1', 64), 'preview', now() + interval '14 days', 'rep@x');
-- a link must be bound to the issued document's revision, baseline and content hash, and to its own send
select pg_temp.expect_denied($q$insert into newquip_response_links (org_id, quote_id, document_id, send_id, document_hash, baseline_hash, revision, customer_name, recipients, allowed_actions, token_hash, environment, expires_at, created_by_email) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017d1', '00000000-0000-0000-0000-0000000017e1', repeat('e', 64), repeat('b', 64), 1, 'Farm', array['a@b.co'], array['ACCEPTED'], repeat('2', 64), 'preview', now() + interval '1 day', 'rep@x')$q$, 'link with the wrong document hash');
select pg_temp.expect_denied($q$insert into newquip_response_links (org_id, quote_id, document_id, send_id, document_hash, baseline_hash, revision, customer_name, recipients, allowed_actions, token_hash, environment, expires_at, created_by_email) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017d1', '00000000-0000-0000-0000-0000000017e1', repeat('c', 64), repeat('b', 64), 2, 'Farm', array['a@b.co'], array['ACCEPTED'], repeat('3', 64), 'preview', now() + interval '1 day', 'rep@x')$q$, 'link with the wrong revision');
select pg_temp.expect_denied($q$insert into newquip_response_links (org_id, quote_id, document_id, send_id, document_hash, baseline_hash, revision, customer_name, recipients, allowed_actions, token_hash, environment, expires_at, created_by_email) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017d1', '00000000-0000-0000-0000-0000000017e2', repeat('c', 64), repeat('b', 64), 1, 'Farm', array['a@b.co'], array['ACCEPTED'], repeat('4', 64), 'preview', now() + interval '1 day', 'rep@x')$q$, 'link using another quotation''s send');
select pg_temp.expect_denied($q$insert into newquip_response_links (org_id, quote_id, document_id, send_id, document_hash, baseline_hash, revision, customer_name, recipients, allowed_actions, token_hash, environment, expires_at, created_by_email) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017d1', '00000000-0000-0000-0000-0000000017e1', repeat('c', 64), repeat('b', 64), 1, 'Farm', array['a@b.co'], array['SIGN_EVERYTHING'], repeat('5', 64), 'preview', now() + interval '1 day', 'rep@x')$q$, 'link with an unknown action');
select pg_temp.expect_denied($q$insert into newquip_response_links (org_id, quote_id, document_id, send_id, document_hash, baseline_hash, revision, customer_name, recipients, allowed_actions, token_hash, environment, expires_at, created_by_email) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017d1', '00000000-0000-0000-0000-0000000017e1', repeat('c', 64), repeat('b', 64), 1, 'Farm', array['a@b.co'], array['ACCEPTED'], repeat('1', 64), 'preview', now() + interval '1 day', 'rep@x')$q$, 'duplicate token hash');
select pg_temp.expect_denied($q$insert into newquip_response_links (org_id, quote_id, document_id, send_id, document_hash, baseline_hash, revision, customer_name, recipients, allowed_actions, token_hash, environment, expires_at, created_by_email) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017d1', '00000000-0000-0000-0000-0000000017e1', repeat('c', 64), repeat('b', 64), 1, 'Farm', array['a@b.co'], array['ACCEPTED'], repeat('6', 64), 'preview', now() - interval '1 day', 'rep@x')$q$, 'link that is already expired');
-- identity immutable; attempts only go up; revocation is one-way and needs a reason; links are never deleted
select pg_temp.expect_denied($q$update newquip_response_links set expires_at = now() + interval '99 years'$q$, 'extending a link');
select pg_temp.expect_denied($q$update newquip_response_links set allowed_actions = array['ACCEPTED'], token_hash = repeat('9', 64)$q$, 'rewriting a link');
update newquip_response_links set attempts = 3;
select pg_temp.expect_denied($q$update newquip_response_links set attempts = 1$q$, 'resetting the attempt counter');
select pg_temp.expect_denied($q$delete from newquip_response_links$q$, 'deleting a link');

-- ── a customer-link response ──
-- accepted without the authority confirmation, with no reason on a decline, with an unmatched document hash: all refused
select pg_temp.expect_denied($q$insert into newquip_quote_responses (org_id, quote_id, document_id, response, contact_name, responded_on, evidence_ref, recorded_by_email, origin, link_id, contact_email, contact_source, contact_company, document_hash, authority_confirmed) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017d1', 'ACCEPTED', 'Piet', current_date, 'link', 'piet@farm.co.za', 'CUSTOMER_LINK', '00000000-0000-0000-0000-000000001701', 'piet@farm.co.za', 'CUSTOMER_PROVIDED', 'Farm', repeat('c', 64), false)$q$, 'link acceptance without the authority confirmation');
select pg_temp.expect_denied($q$insert into newquip_quote_responses (org_id, quote_id, document_id, response, contact_name, responded_on, evidence_ref, recorded_by_email, origin, link_id, contact_email, contact_source, contact_company, document_hash, authority_confirmed, note) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017d1', 'DECLINED', 'Piet', current_date, 'link', 'piet@farm.co.za', 'CUSTOMER_LINK', '00000000-0000-0000-0000-000000001701', 'piet@farm.co.za', 'CUSTOMER_PROVIDED', 'Farm', repeat('c', 64), false, '')$q$, 'link decline without a reason');
select pg_temp.expect_denied($q$insert into newquip_quote_responses (org_id, quote_id, document_id, response, contact_name, responded_on, evidence_ref, recorded_by_email, origin, link_id, contact_email, contact_source, contact_company, document_hash, authority_confirmed) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017d1', 'ACCEPTED', 'Piet', current_date, 'link', 'piet@farm.co.za', 'CUSTOMER_LINK', '00000000-0000-0000-0000-000000001701', 'piet@farm.co.za', 'CUSTOMER_PROVIDED', 'Farm', repeat('f', 64), true)$q$, 'link response carrying another document hash');
select pg_temp.expect_denied($q$insert into newquip_quote_responses (org_id, quote_id, document_id, response, contact_name, responded_on, evidence_ref, recorded_by_email, origin, contact_email, contact_source, contact_company, document_hash, authority_confirmed) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017d1', 'ACCEPTED', 'Piet', current_date, 'link', 'piet@farm.co.za', 'CUSTOMER_LINK', 'piet@farm.co.za', 'CUSTOMER_PROVIDED', 'Farm', repeat('c', 64), true)$q$, 'a link response without a link');
-- a link of another quotation cannot answer this one
insert into newquip_response_links (id, org_id, quote_id, document_id, send_id, document_hash, baseline_hash, revision, customer_name, recipients, allowed_actions, token_hash, environment, expires_at, created_by_email)
values ('00000000-0000-0000-0000-000000001702', '00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c2', '00000000-0000-0000-0000-0000000017d2', '00000000-0000-0000-0000-0000000017e2', repeat('d', 64), repeat('b', 64), 1, 'Farm 2',
  array['anton@sparkconsulting.co.za'], array['DECLINED'], repeat('7', 64), 'preview', now() + interval '1 day', 'rep@x');
select pg_temp.expect_denied($q$insert into newquip_quote_responses (org_id, quote_id, document_id, response, contact_name, responded_on, evidence_ref, recorded_by_email, origin, link_id, contact_email, contact_source, contact_company, document_hash, authority_confirmed) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017d1', 'ACCEPTED', 'Piet', current_date, 'link', 'piet@farm.co.za', 'CUSTOMER_LINK', '00000000-0000-0000-0000-000000001702', 'piet@farm.co.za', 'CUSTOMER_PROVIDED', 'Farm', repeat('c', 64), true)$q$, 'a link of another quotation');
-- the link only permits the actions it was issued for
select pg_temp.expect_denied($q$insert into newquip_quote_responses (org_id, quote_id, document_id, response, contact_name, responded_on, evidence_ref, recorded_by_email, origin, link_id, contact_email, contact_source, contact_company, document_hash, authority_confirmed) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c2', '00000000-0000-0000-0000-0000000017d2', 'ACCEPTED', 'Piet', current_date, 'link', 'piet@farm.co.za', 'CUSTOMER_LINK', '00000000-0000-0000-0000-000000001702', 'piet@farm.co.za', 'CUSTOMER_PROVIDED', 'Farm', repeat('d', 64), true)$q$, 'an action the link does not permit');
-- the valid acceptance
insert into newquip_quote_responses (id, org_id, quote_id, document_id, response, contact_name, responded_on, evidence_ref, recorded_by_email, origin, link_id, contact_email, contact_source, contact_company, document_hash, authority_confirmed, origin_hint)
values ('00000000-0000-0000-0000-0000000017f1', '00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017d1', 'ACCEPTED', 'Piet', current_date, 'Customer response link', 'piet@farm.co.za', 'CUSTOMER_LINK',
  '00000000-0000-0000-0000-000000001701', 'piet@farm.co.za', 'CUSTOMER_PROVIDED', 'Farm', repeat('c', 64), true, 'abc123');
-- one response per link, even a second one of a different kind
select pg_temp.expect_denied($q$insert into newquip_quote_responses (org_id, quote_id, document_id, response, contact_name, responded_on, evidence_ref, recorded_by_email, origin, link_id, contact_email, contact_source, contact_company, document_hash, authority_confirmed, note) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017d1', 'DECLINED', 'Piet', current_date, 'link', 'piet@farm.co.za', 'CUSTOMER_LINK', '00000000-0000-0000-0000-000000001701', 'piet@farm.co.za', 'CUSTOMER_PROVIDED', 'Farm', repeat('c', 64), false, 'changed my mind')$q$, 'a second response on the same link');
-- an expired or revoked link cannot be used
insert into newquip_response_links (id, org_id, quote_id, document_id, send_id, document_hash, baseline_hash, revision, customer_name, recipients, allowed_actions, token_hash, environment, expires_at, created_by_email, created_at)
values ('00000000-0000-0000-0000-000000001703', '00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c2', '00000000-0000-0000-0000-0000000017d2', '00000000-0000-0000-0000-0000000017e2', repeat('d', 64), repeat('b', 64), 1, 'Farm 2',
  array['anton@sparkconsulting.co.za'], array['DECLINED'], repeat('8', 64), 'preview', now() - interval '1 hour', 'rep@x', now() - interval '2 hours');
select pg_temp.expect_denied($q$insert into newquip_quote_responses (org_id, quote_id, document_id, response, contact_name, responded_on, evidence_ref, recorded_by_email, origin, link_id, contact_email, contact_source, contact_company, document_hash, authority_confirmed, note) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c2', '00000000-0000-0000-0000-0000000017d2', 'DECLINED', 'Piet', current_date, 'link', 'piet@farm.co.za', 'CUSTOMER_LINK', '00000000-0000-0000-0000-000000001703', 'piet@farm.co.za', 'CUSTOMER_PROVIDED', 'Farm 2', repeat('d', 64), false, 'no thanks')$q$, 'an expired link');
select pg_temp.expect_denied($q$update newquip_response_links set revoked_at = now() where id = '00000000-0000-0000-0000-000000001702'$q$, 'revocation without a reason');
update newquip_response_links set revoked_at = now(), revoked_reason = 'superseded by a new send' where id = '00000000-0000-0000-0000-000000001702';
select pg_temp.expect_denied($q$update newquip_response_links set revoked_reason = 'edited' where id = '00000000-0000-0000-0000-000000001702'$q$, 'rewriting a revocation');
select pg_temp.expect_denied($q$update newquip_response_links set revoked_at = null where id = '00000000-0000-0000-0000-000000001702'$q$, 'un-revoking a link');
select pg_temp.expect_denied($q$insert into newquip_quote_responses (org_id, quote_id, document_id, response, contact_name, responded_on, evidence_ref, recorded_by_email, origin, link_id, contact_email, contact_source, contact_company, document_hash, authority_confirmed, note) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c2', '00000000-0000-0000-0000-0000000017d2', 'DECLINED', 'Piet', current_date, 'link', 'piet@farm.co.za', 'CUSTOMER_LINK', '00000000-0000-0000-0000-000000001702', 'piet@farm.co.za', 'CUSTOMER_PROVIDED', 'Farm 2', repeat('d', 64), false, 'no thanks')$q$, 'a revoked link');

-- ── reviews ──
select pg_temp.expect_denied($q$insert into newquip_response_reviews (org_id, quote_id, response_id, decision, reviewed_by_email) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c2', '00000000-0000-0000-0000-0000000017f0', 'VERIFIED', 'rep@x')$q$, 'reviewing a staff-recorded (non-link) response');
select pg_temp.expect_denied($q$insert into newquip_response_reviews (org_id, quote_id, response_id, decision, reviewed_by_email) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c2', '00000000-0000-0000-0000-0000000017f1', 'VERIFIED', 'rep@x')$q$, 'review naming another quotation');
select pg_temp.expect_denied($q$insert into newquip_response_reviews (org_id, quote_id, response_id, decision, reviewed_by_email) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017f1', 'REJECTED', 'rep@x')$q$, 'rejection without a reason');
select pg_temp.expect_denied($q$insert into newquip_response_reviews (org_id, quote_id, response_id, decision, reviewed_by_email) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017f1', 'MAYBE', 'rep@x')$q$, 'unknown decision');
insert into newquip_response_reviews (org_id, quote_id, response_id, decision, note, reviewed_by_email) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017f1', 'VERIFIED', 'authority confirmed by phone', 'rep@x');
select pg_temp.expect_denied($q$insert into newquip_response_reviews (org_id, quote_id, response_id, decision, note, reviewed_by_email) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017f1', 'REJECTED', 'second opinion', 'm@x')$q$, 'a second review of the same response');
select pg_temp.expect_denied($q$update newquip_response_reviews set decision = 'REJECTED'$q$, 'review update');
select pg_temp.expect_denied($q$delete from newquip_response_reviews$q$, 'review delete');

-- ── evidence ──
insert into newquip_response_evidence (org_id, quote_id, document_id, response_id, storage_path, file_name, content_type, byte_size, sha256, uploaded_by_email)
values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017d1', '00000000-0000-0000-0000-0000000017f1', '00000000-0000-0000-0000-0000000017b1/evidence/q1/r1/aaa.pdf', 'signed.pdf', 'application/pdf', 1234, repeat('a', 64), 'rep@x');
select pg_temp.expect_denied($q$insert into newquip_response_evidence (org_id, quote_id, document_id, response_id, storage_path, file_name, content_type, byte_size, sha256, uploaded_by_email) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017d1', '00000000-0000-0000-0000-0000000017f1', '00000000-0000-0000-0000-0000000017b1/evidence/q1/r1/aaa.pdf', 'again.pdf', 'application/pdf', 10, repeat('b', 64), 'rep@x')$q$, 'overwriting an evidence path');
select pg_temp.expect_denied($q$insert into newquip_response_evidence (org_id, quote_id, document_id, response_id, storage_path, file_name, content_type, byte_size, sha256, uploaded_by_email) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017d1', '00000000-0000-0000-0000-0000000017f1', '00000000-0000-0000-0000-0000000017b1/evidence/q1/r1/bbb.exe', 'x.exe', 'application/x-msdownload', 10, repeat('b', 64), 'rep@x')$q$, 'an unsupported content type');
select pg_temp.expect_denied($q$insert into newquip_response_evidence (org_id, quote_id, document_id, response_id, storage_path, file_name, content_type, byte_size, sha256, uploaded_by_email) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017d1', '00000000-0000-0000-0000-0000000017f1', '00000000-0000-0000-0000-0000000017b1/evidence/q1/r1/big.pdf', 'big.pdf', 'application/pdf', 9999999, repeat('b', 64), 'rep@x')$q$, 'an oversized file');
select pg_temp.expect_denied($q$insert into newquip_response_evidence (org_id, quote_id, document_id, response_id, storage_path, file_name, content_type, byte_size, sha256, uploaded_by_email) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017d1', '00000000-0000-0000-0000-0000000017f1', '00000000-0000-0000-0000-0000000017b2/evidence/q1/r1/x.pdf', 'x.pdf', 'application/pdf', 10, repeat('b', 64), 'rep@x')$q$, 'a path outside the organisation''s evidence folder');
select pg_temp.expect_denied($q$insert into newquip_response_evidence (org_id, quote_id, document_id, response_id, storage_path, file_name, content_type, byte_size, sha256, uploaded_by_email) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c2', '00000000-0000-0000-0000-0000000017d2', '00000000-0000-0000-0000-0000000017f1', '00000000-0000-0000-0000-0000000017b1/evidence/q1/r1/other.pdf', 'other.pdf', 'application/pdf', 10, repeat('b', 64), 'rep@x')$q$, 'evidence naming a different quotation than its response');
select pg_temp.expect_denied($q$update newquip_response_evidence set sha256 = repeat('c', 64)$q$, 'evidence update');
select pg_temp.expect_denied($q$delete from newquip_response_evidence$q$, 'evidence delete');

-- the quotation bucket is still private and the new objects added no storage policy
do $$ begin
  if (select public from storage.buckets where id = 'newquip-quote-documents') is distinct from false then raise exception 'the quotation bucket must be private'; end if;
end $$;

-- ── privileges: nothing for anon / PUBLIC, SELECT only for authenticated, no TRUNCATE, token hash unreadable ──
do $$ declare t text; p text; r text; begin
  foreach t in array array['newquip_response_links', 'newquip_response_reviews', 'newquip_response_evidence'] loop
    foreach r in array array['anon', 'authenticated'] loop
      foreach p in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(r, t, p) then raise exception '% must not have % on %', r, p, t; end if;
      end loop;
    end loop;
    if has_table_privilege('anon', t, 'SELECT') then raise exception 'anon must not read %', t; end if;
  end loop;
  if has_column_privilege('authenticated', 'newquip_response_links', 'token_hash', 'SELECT') then raise exception 'members must not read the token hash'; end if;
  if not has_column_privilege('authenticated', 'newquip_response_links', 'expires_at', 'SELECT') then raise exception 'members read link metadata'; end if;
  if not has_table_privilege('authenticated', 'newquip_response_reviews', 'SELECT') then raise exception 'members read reviews'; end if;
  if not has_table_privilege('service_role', 'newquip_response_links', 'INSERT') then raise exception 'service role writes links'; end if;
  foreach t in array array['newquip_response_links_guard()', 'newquip_response_reviews_guard()', 'newquip_response_evidence_guard()', 'newquip_quote_responses_guard()'] loop
    foreach r in array array['anon', 'authenticated'] loop
      if has_function_privilege(r, ('public.' || t)::regprocedure, 'EXECUTE') then raise exception '% must not execute %', r, t; end if;
    end loop;
  end loop;
end $$;

-- ── RLS: members read their own organisation only; no client writes ──
select pg_temp.act_as('00000000-0000-0000-0000-0000000017a1');
do $$ begin
  if (select count(*) from newquip_response_links) < 2 then raise exception 'org A member must see its links'; end if;
  if (select count(*) from newquip_response_reviews) <> 1 then raise exception 'org A member must see its review'; end if;
  if (select count(*) from newquip_response_evidence) <> 1 then raise exception 'org A member must see its evidence'; end if;
end $$;
select pg_temp.expect_denied($q$select token_hash from newquip_response_links$q$, 'a member reading the token hash');
select pg_temp.expect_denied($q$insert into newquip_response_evidence (org_id, quote_id, document_id, response_id, storage_path, file_name, content_type, byte_size, sha256, uploaded_by_email) values ('00000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017d1', '00000000-0000-0000-0000-0000000017f1', '00000000-0000-0000-0000-0000000017b1/evidence/q1/r1/client.pdf', 'c.pdf', 'application/pdf', 10, repeat('b', 64), 'x@x')$q$, 'client write to evidence');
select pg_temp.expect_denied($q$update newquip_response_links set revoked_at = now(), revoked_reason = 'client'$q$, 'client revoking a link');
select pg_temp.expect_denied($q$truncate newquip_response_links$q$, 'client TRUNCATE');
select pg_temp.reset_role();
select pg_temp.act_as('00000000-0000-0000-0000-0000000017a2');
do $$ begin
  if (select count(*) from newquip_response_links) <> 0 then raise exception 'org B must not see org A links'; end if;
  if (select count(*) from newquip_response_reviews) <> 0 then raise exception 'org B must not see org A reviews'; end if;
  if (select count(*) from newquip_response_evidence) <> 0 then raise exception 'org B must not see org A evidence'; end if;
  if (select count(*) from newquip_quote_responses where origin = 'CUSTOMER_LINK') <> 0 then raise exception 'org B must not see org A link responses'; end if;
end $$;
select pg_temp.reset_role();

select 'OK: 0117 customer response portal' as result;
rollback;
