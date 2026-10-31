-- NewQuip customer acceptance: responding contact, evidence files, secure emailed response links and internal verification. NOT applied to hosted Supabase (owner approval required).
-- Additive only: nothing here changes an existing row's meaning, and older application code ignores all of it.
--
--   newquip_quote_responses          + origin / responding-contact / authority columns (existing rows become origin = 'STAFF', unchanged)
--   newquip_response_links           one-shot, expiring, hashed-token links emailed with a send (no token is stored, only its SHA-256)
--   newquip_response_reviews         append-only internal VERIFIED / REJECTED decision on a customer-link ACCEPTANCE
--   approval_notifications           + quote_id, request_id now nullable: a customer-response notification no longer needs a (possibly non-existent) approval request
--   newquip_response_evidence        append-only registry of evidence files (the files live in the existing PRIVATE bucket 'newquip-quote-documents' under <org>/evidence/...)
--
-- ACCEPTANCE GATE (enforced in application code, mirrored by the data model): a response with origin = 'CUSTOMER_LINK' is only a formal acceptance once an internal
-- review VERIFIED it. Responses recorded by staff (origin = 'STAFF') behave exactly as before. Writes are service-role Server Actions only; clients get SELECT only.
-- Rollback / recovery: `drop table newquip_response_evidence, newquip_response_reviews, newquip_response_links cascade;` and drop the added responses columns.

-- ── responses: additive columns ─────────────────────────────────────────────
alter table newquip_quote_responses
  add column if not exists origin text not null default 'STAFF',
  add column if not exists contact_email text,
  add column if not exists contact_source text,
  add column if not exists contact_company text,
  add column if not exists exception_reason text,
  add column if not exists authority_confirmed boolean not null default false,
  add column if not exists document_hash text,
  add column if not exists link_id uuid,
  add column if not exists origin_hint text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'newquip_quote_responses_origin_chk') then
    alter table newquip_quote_responses add constraint newquip_quote_responses_origin_chk check (origin in ('STAFF', 'CUSTOMER_LINK'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'newquip_quote_responses_contact_source_chk') then
    alter table newquip_quote_responses add constraint newquip_quote_responses_contact_source_chk check (contact_source is null or contact_source in ('DELIVERY_CONTACT', 'CIN7_CONTACT', 'ALTERNATIVE', 'CUSTOMER_PROVIDED'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'newquip_quote_responses_exception_chk') then
    alter table newquip_quote_responses add constraint newquip_quote_responses_exception_chk check (contact_source is distinct from 'ALTERNATIVE' or length(btrim(coalesce(exception_reason, ''))) >= 5);
  end if;
  -- an emailed-link response always names the person and company, carries the link, and an acceptance carries the authority confirmation
  if not exists (select 1 from pg_constraint where conname = 'newquip_quote_responses_link_chk') then
    alter table newquip_quote_responses add constraint newquip_quote_responses_link_chk check (
      origin = 'STAFF' or (link_id is not null and contact_source = 'CUSTOMER_PROVIDED' and length(btrim(coalesce(contact_email, ''))) > 3 and length(btrim(coalesce(contact_company, ''))) > 0
        and document_hash is not null and (response <> 'ACCEPTED' or authority_confirmed) and (response = 'ACCEPTED' or length(btrim(note)) >= 3)));
  end if;
end $$;
-- a link carries at most ONE response (the one-shot rule, enforced by the database even under concurrent submissions)
create unique index if not exists newquip_quote_responses_link_uniq on newquip_quote_responses (link_id) where link_id is not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'newquip_quote_responses_id_org_uniq') then
    alter table newquip_quote_responses add constraint newquip_quote_responses_id_org_uniq unique (id, org_id);
  end if;
end $$;

-- ── response links ──────────────────────────────────────────────────────────
create table if not exists newquip_response_links (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  quote_id    uuid not null,
  document_id uuid not null,
  send_id     uuid not null references newquip_quote_sends (id),
  -- What the link is bound to: the exact issued document (its content hash) and the approved revision / baseline.
  document_hash text not null check (length(document_hash) = 64),
  baseline_hash text not null check (length(baseline_hash) = 64),
  revision    integer not null check (revision > 0),
  customer_name text not null check (length(btrim(customer_name)) > 0),
  recipients  text[] not null check (cardinality(recipients) > 0),
  allowed_actions text[] not null check (cardinality(allowed_actions) > 0 and allowed_actions <@ array['ACCEPTED', 'DECLINED', 'CHANGES_REQUESTED']),
  -- SHA-256 of the secret part of the emailed token. The token itself is never stored.
  token_hash  text not null unique check (length(token_hash) = 64),
  -- The environment that issued the link: a Preview link is refused by Production and vice versa.
  environment text not null check (environment in ('production', 'preview', 'development')),
  expires_at  timestamptz not null,
  created_by_email text not null,
  created_at  timestamptz not null default clock_timestamp(),
  revoked_at  timestamptz,
  revoked_reason text,
  -- bounded abuse counter: wrong-secret / invalid submissions against THIS link
  attempts    integer not null default 0 check (attempts >= 0),
  foreign key (document_id, org_id) references newquip_quote_documents (id, org_id),
  foreign key (quote_id, org_id) references newquip_quotes (id, org_id) on delete cascade,
  unique (id, org_id),
  check (expires_at > created_at),
  check (revoked_at is null or length(btrim(coalesce(revoked_reason, ''))) >= 3)
);
create index if not exists newquip_response_links_quote_idx on newquip_response_links (org_id, quote_id, created_at desc);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'newquip_quote_responses_link_fk') then
    alter table newquip_quote_responses add constraint newquip_quote_responses_link_fk foreign key (link_id, org_id) references newquip_response_links (id, org_id);
  end if;
end $$;

-- ── internal review of a customer-link acceptance ───────────────────────────
create table if not exists newquip_response_reviews (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  quote_id    uuid not null,
  response_id uuid not null,
  decision    text not null check (decision in ('VERIFIED', 'REJECTED')),
  note        text not null default '',
  reviewed_by_email text not null,
  reviewed_by_owner_email text,
  created_at  timestamptz not null default clock_timestamp(),
  foreign key (response_id, org_id) references newquip_quote_responses (id, org_id),
  foreign key (quote_id, org_id) references newquip_quotes (id, org_id) on delete cascade,
  unique (response_id),
  check (decision <> 'REJECTED' or length(btrim(note)) >= 3)
);

-- ── evidence files ──────────────────────────────────────────────────────────
create table if not exists newquip_response_evidence (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  quote_id    uuid not null,
  document_id uuid not null,
  response_id uuid not null,
  storage_path text not null unique check (storage_path like org_id::text || '/evidence/%'),
  file_name   text not null check (length(file_name) between 1 and 200),
  content_type text not null check (content_type in ('application/pdf', 'image/jpeg', 'image/png', 'message/rfc822')),
  byte_size   integer not null check (byte_size > 0 and byte_size <= 5242880),
  sha256      text not null check (length(sha256) = 64),
  description text not null default '',
  uploaded_by_email text not null,
  uploaded_by_owner_email text,
  created_at  timestamptz not null default clock_timestamp(),
  foreign key (response_id, org_id) references newquip_quote_responses (id, org_id),
  foreign key (document_id, org_id) references newquip_quote_documents (id, org_id),
  foreign key (quote_id, org_id) references newquip_quotes (id, org_id) on delete cascade,
  unique (id, org_id)
);
create index if not exists newquip_response_evidence_response_idx on newquip_response_evidence (org_id, response_id);

-- ── guards ──────────────────────────────────────────────────────────────────
-- Links: identity is immutable. Only a one-way revocation and the attempt counter may change; a link can only be created for the CURRENT approved document.
create or replace function newquip_response_links_guard() returns trigger language plpgsql set search_path = public as $$
declare d record; s record;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from organizations where id = old.org_id) then raise exception 'newquip_response_links: links are an audit record and are never deleted'; end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    select quote_id, revision, baseline_hash, content_hash into d from newquip_quote_documents where id = new.document_id and org_id = new.org_id;
    if d.quote_id is distinct from new.quote_id then raise exception 'newquip_response_links: the document belongs to a different quotation'; end if;
    if d.revision <> new.revision or d.baseline_hash <> new.baseline_hash or d.content_hash <> new.document_hash then
      raise exception 'newquip_response_links: the link must be bound to the issued document''s revision, baseline and content hash';
    end if;
    select quote_id, document_id, org_id into s from newquip_quote_sends where id = new.send_id;
    if s.org_id is distinct from new.org_id or s.quote_id is distinct from new.quote_id or s.document_id is distinct from new.document_id then
      raise exception 'newquip_response_links: the send belongs to a different quotation or document';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - 'revoked_at' - 'revoked_reason' - 'attempts') is distinct from (to_jsonb(old) - 'revoked_at' - 'revoked_reason' - 'attempts') then
    raise exception 'newquip_response_links: only revocation and the attempt counter may change';
  end if;
  if old.revoked_at is not null and (new.revoked_at is distinct from old.revoked_at or new.revoked_reason is distinct from old.revoked_reason) then
    raise exception 'newquip_response_links: a revoked link stays revoked';
  end if;
  if new.attempts < old.attempts then raise exception 'newquip_response_links: the attempt counter never decreases'; end if;
  return new;
end;
$$;
drop trigger if exists newquip_response_links_guard_trg on newquip_response_links;
create trigger newquip_response_links_guard_trg before insert or update or delete on newquip_response_links for each row execute function newquip_response_links_guard();

-- Reviews: append-only; only an ACCEPTED response that came from a customer link is reviewed.
create or replace function newquip_response_reviews_guard() returns trigger language plpgsql set search_path = public as $$
declare r record;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    if exists (select 1 from organizations where id = old.org_id) then raise exception 'newquip_response_reviews: a review is an audit record and is never updated or deleted'; end if;
    return old;
  end if;
  select quote_id, origin, response into r from newquip_quote_responses where id = new.response_id and org_id = new.org_id;
  if r.quote_id is distinct from new.quote_id then raise exception 'newquip_response_reviews: the response belongs to a different quotation'; end if;
  if r.origin is distinct from 'CUSTOMER_LINK' or r.response is distinct from 'ACCEPTED' then raise exception 'newquip_response_reviews: only an acceptance received through a customer link needs review'; end if;
  return new;
end;
$$;
drop trigger if exists newquip_response_reviews_guard_trg on newquip_response_reviews;
create trigger newquip_response_reviews_guard_trg before insert or update or delete on newquip_response_reviews for each row execute function newquip_response_reviews_guard();

-- Evidence: append-only, attached to a response of the same quotation and document; a file is never replaced.
create or replace function newquip_response_evidence_guard() returns trigger language plpgsql set search_path = public as $$
declare r record;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    if exists (select 1 from organizations where id = old.org_id) then raise exception 'newquip_response_evidence: evidence is an audit record and is never updated or deleted'; end if;
    return old;
  end if;
  select quote_id, document_id into r from newquip_quote_responses where id = new.response_id and org_id = new.org_id;
  if r.quote_id is distinct from new.quote_id or r.document_id is distinct from new.document_id then raise exception 'newquip_response_evidence: the response belongs to a different quotation or document'; end if;
  return new;
end;
$$;
drop trigger if exists newquip_response_evidence_guard_trg on newquip_response_evidence;
create trigger newquip_response_evidence_guard_trg before insert or update or delete on newquip_response_evidence for each row execute function newquip_response_evidence_guard();

-- Responses (replaces the 0115 guard, same append-only rule): a customer-link response must come from a live, matching link.
create or replace function newquip_quote_responses_guard() returns trigger language plpgsql set search_path = public as $$
declare d record; l record;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    if exists (select 1 from organizations where id = old.org_id) then raise exception 'newquip_quote_responses: customer responses are an audit record and are never updated or deleted'; end if;
    return old;
  end if;
  select quote_id, content_hash into d from newquip_quote_documents where id = new.document_id and org_id = new.org_id;
  if d.quote_id is distinct from new.quote_id then raise exception 'newquip_quote_responses: the document belongs to a different quotation'; end if;
  if new.origin = 'CUSTOMER_LINK' then
    select quote_id, document_id, document_hash, expires_at, revoked_at, allowed_actions into l from newquip_response_links where id = new.link_id and org_id = new.org_id;
    if l.quote_id is distinct from new.quote_id or l.document_id is distinct from new.document_id or l.document_hash is distinct from d.content_hash or new.document_hash is distinct from d.content_hash then
      raise exception 'newquip_quote_responses: the link does not belong to this document';
    end if;
    if l.revoked_at is not null then raise exception 'newquip_quote_responses: the link was revoked'; end if;
    if l.expires_at <= clock_timestamp() then raise exception 'newquip_quote_responses: the link has expired'; end if;
    if not (new.response = any (l.allowed_actions)) then raise exception 'newquip_quote_responses: that response is not permitted by the link'; end if;
  end if;
  return new;
end;
$$;

-- ── notifications: a customer response must notify the Rep even when the quotation never had an approval request (grandfathered) ──
-- Additive: existing rows keep their request_id; the new nullable quote_id lets a notification hang off the quotation itself. No fake approval request is created.
alter table approval_notifications alter column request_id drop not null;
alter table approval_notifications add column if not exists quote_id uuid;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'approval_notifications_quote_fk') then
    alter table approval_notifications add constraint approval_notifications_quote_fk foreign key (quote_id, org_id) references newquip_quotes (id, org_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'approval_notifications_anchor_chk') then
    alter table approval_notifications add constraint approval_notifications_anchor_chk check (request_id is not null or quote_id is not null);
  end if;
end $$;
create index if not exists approval_notifications_quote_idx on approval_notifications (org_id, quote_id) where quote_id is not null;

-- ── RLS: members read their own organisation; no client writes ──────────────
alter table newquip_response_links    enable row level security;
alter table newquip_response_reviews  enable row level security;
alter table newquip_response_evidence enable row level security;
drop policy if exists "org members read newquip_response_links" on newquip_response_links;
drop policy if exists "org members read newquip_response_reviews" on newquip_response_reviews;
drop policy if exists "org members read newquip_response_evidence" on newquip_response_evidence;
create policy "org members read newquip_response_links"    on newquip_response_links    for select using (is_org_member(org_id));
create policy "org members read newquip_response_reviews"  on newquip_response_reviews  for select using (is_org_member(org_id));
create policy "org members read newquip_response_evidence" on newquip_response_evidence for select using (is_org_member(org_id));

-- ── privileges (the 0112 / 0113 / 0116 pattern): nothing for anon / PUBLIC, SELECT only for authenticated, writes via the service role ──
-- service_role is also reset (Supabase default privileges give it TRUNCATE / REFERENCES / TRIGGER) and then granted only what the Server Actions use.
revoke all on newquip_response_links, newquip_response_reviews, newquip_response_evidence from public, anon, authenticated, service_role;
-- members may read link METADATA, never the token hash
grant select (id, org_id, quote_id, document_id, send_id, document_hash, baseline_hash, revision, customer_name, recipients, allowed_actions, environment, expires_at, created_by_email, created_at, revoked_at, revoked_reason, attempts)
  on newquip_response_links to authenticated;
grant select on newquip_response_reviews, newquip_response_evidence to authenticated;
grant select, insert, update on newquip_response_links to service_role;            -- revocation + attempt counter; a link is never deleted
grant select, insert on newquip_response_reviews, newquip_response_evidence to service_role;   -- append-only
revoke all on function newquip_response_links_guard(), newquip_response_reviews_guard(), newquip_response_evidence_guard(), newquip_quote_responses_guard() from public, anon, authenticated;
