-- NewQuip customer integration and customer-facing quotation delivery (additive; applies after 0114). NOT applied to hosted Supabase.
--
-- Adds, without touching any existing row's meaning:
--   newquip_quote_customers      append-only Cin7 customer snapshots per quotation (Cin7 stays the master; nothing is written back)
--   newquip_company_profiles     versioned, append-only company details / commercial terms printed on customer documents
--   newquip_quote_documents      append-only registry of issued customer PDFs (exact revision + content hash; file lives in a PRIVATE bucket)
--   newquip_quote_sends          audit of every customer email attempt (recipients, document, provider acceptance - not inbox delivery)
--   newquip_quote_responses      append-only customer responses (accepted / declined / changes requested) against the exact issued document
--   newquip_quotes.requires_customer_acceptance   GRANDFATHERING: every quotation that exists when this migration runs keeps FALSE; new ones default TRUE
-- All writes are service-role Server Actions that authorise first; clients get SELECT only (members of the owning org).
-- Rollback / recovery: every object is new and unreferenced by older code, so `drop table ... cascade; alter table newquip_quotes drop column ...;
-- delete from storage.buckets where id = 'newquip-quote-documents'` returns the schema to 0114. Older application code ignores all of it.

-- ── GRANDFATHERING flag ─────────────────────────────────────────────────────
-- Added with default FALSE so every existing quotation (approved or not) is exempt from the acceptance gate, then the default flips to TRUE for new rows.
alter table newquip_quotes add column if not exists requires_customer_acceptance boolean not null default false;
alter table newquip_quotes alter column requires_customer_acceptance set default true;
comment on column newquip_quotes.requires_customer_acceptance is
  'TRUE: project creation needs the customer to have accepted the exact issued document. FALSE: grandfathered (existing at the 0115 cutover). Set at insert; cannot change afterwards (the approved-quote freeze covers it).';

create or replace function newquip_quotes_acceptance_flag_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if new.requires_customer_acceptance is distinct from old.requires_customer_acceptance then
    raise exception 'newquip_quotes %: requires_customer_acceptance is fixed at creation (grandfathering is never altered retroactively)', old.id;
  end if;
  return new;
end;
$$;
drop trigger if exists newquip_quotes_acceptance_flag_guard_trg on newquip_quotes;
create trigger newquip_quotes_acceptance_flag_guard_trg before update on newquip_quotes for each row execute function newquip_quotes_acceptance_flag_guard();

-- ── Customer snapshots ──────────────────────────────────────────────────────
create table if not exists newquip_quote_customers (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  quote_id    uuid not null,
  seq         integer not null check (seq > 0),
  cin7_customer_id text not null check (length(btrim(cin7_customer_id)) > 0),
  -- The commercial customer details as captured (each field is {state:'present'|'missing', value}); see src/lib/newquip-quotes/customer-snapshot.ts
  snapshot    jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  snapshot_hash text not null check (length(snapshot_hash) = 64),
  captured_by_email text not null,
  captured_by_owner_email text,
  reason      text not null default '',
  created_at  timestamptz not null default clock_timestamp(),
  foreign key (quote_id, org_id) references newquip_quotes (id, org_id) on delete cascade,
  unique (quote_id, seq),
  unique (id, org_id)
);
create index if not exists newquip_quote_customers_quote_idx on newquip_quote_customers (org_id, quote_id, seq desc);

-- ── Company profile (versioned, append-only) ────────────────────────────────
create table if not exists newquip_company_profiles (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  version     integer not null default 0,
  -- Free-form validated server-side (see src/lib/newquip-quotes/company-profile.ts); nothing here is invented by the application.
  profile     jsonb not null check (jsonb_typeof(profile) = 'object'),
  entered_by_email text not null,
  created_at  timestamptz not null default clock_timestamp(),
  unique (org_id, version),
  unique (id, org_id)
);

create or replace function newquip_company_profiles_version() returns trigger language plpgsql set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('newquip_company_profiles:' || new.org_id::text, 0));
  new.version := coalesce((select max(version) from newquip_company_profiles where org_id = new.org_id), 0) + 1;
  return new;
end;
$$;
create trigger newquip_company_profiles_version_trg before insert on newquip_company_profiles for each row execute function newquip_company_profiles_version();

-- ── Issued documents ────────────────────────────────────────────────────────
create table if not exists newquip_quote_documents (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  quote_id    uuid not null,
  quote_ref   text not null,
  revision    integer not null check (revision > 0),
  version     integer not null check (version > 0),
  baseline_hash text not null check (length(baseline_hash) = 64),
  customer_snapshot_id uuid not null,
  company_profile_id   uuid not null,
  storage_path text not null check (length(btrim(storage_path)) > 0),
  content_hash text not null check (length(content_hash) = 64),
  byte_size   integer not null check (byte_size > 0),
  -- The exact customer-safe model that was rendered (sections, totals, schedule, terms). Never contains cost or margin.
  content     jsonb not null check (jsonb_typeof(content) = 'object'),
  issued_by_email text not null,
  issued_by_owner_email text,
  created_at  timestamptz not null default clock_timestamp(),
  foreign key (quote_id, org_id) references newquip_quotes (id, org_id) on delete cascade,
  foreign key (customer_snapshot_id, org_id) references newquip_quote_customers (id, org_id),
  foreign key (company_profile_id, org_id) references newquip_company_profiles (id, org_id),
  unique (quote_id, version),
  unique (id, org_id),
  unique (storage_path)
);
create index if not exists newquip_quote_documents_quote_idx on newquip_quote_documents (org_id, quote_id, version desc);

-- ── Sends ───────────────────────────────────────────────────────────────────
create table if not exists newquip_quote_sends (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  quote_id    uuid not null,
  document_id uuid not null,
  -- One logical send per (document, idempotency key); an audited re-send uses a new key and names what it re-sends.
  idempotency_key text not null check (length(btrim(idempotency_key)) > 0),
  resend_of   uuid,
  resend_reason text,
  to_emails   text[] not null check (cardinality(to_emails) > 0),
  cc_emails   text[] not null default '{}',
  suppressed_emails text[] not null default '{}',
  subject     text not null,
  message     text not null default '',
  status      text not null default 'QUEUED' check (status in ('QUEUED', 'ACCEPTED', 'FAILED', 'SUPPRESSED')),
  provider_message_id text,
  last_error  text,
  sent_by_email text not null,
  sent_by_owner_email text,
  created_at  timestamptz not null default clock_timestamp(),
  attempted_at timestamptz,
  foreign key (document_id, org_id) references newquip_quote_documents (id, org_id),
  foreign key (quote_id, org_id) references newquip_quotes (id, org_id) on delete cascade,
  unique (document_id, idempotency_key),
  check (resend_of is null or (resend_reason is not null and length(btrim(resend_reason)) >= 3)),
  check (status <> 'ACCEPTED' or provider_message_id is not null)
);
create index if not exists newquip_quote_sends_quote_idx on newquip_quote_sends (org_id, quote_id, created_at desc);

-- ── Customer responses ──────────────────────────────────────────────────────
create table if not exists newquip_quote_responses (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  quote_id    uuid not null,
  document_id uuid not null,
  response    text not null check (response in ('ACCEPTED', 'DECLINED', 'CHANGES_REQUESTED')),
  contact_name text not null check (length(btrim(contact_name)) > 0),
  responded_on date not null,
  evidence_ref text not null check (length(btrim(evidence_ref)) >= 3),
  note        text not null default '',
  recorded_by_email text not null,
  recorded_by_owner_email text,
  created_at  timestamptz not null default clock_timestamp(),
  foreign key (document_id, org_id) references newquip_quote_documents (id, org_id),
  foreign key (quote_id, org_id) references newquip_quotes (id, org_id) on delete cascade,
  check (response <> 'CHANGES_REQUESTED' or length(btrim(note)) >= 3)
);
create index if not exists newquip_quote_responses_quote_idx on newquip_quote_responses (org_id, quote_id, created_at desc);

-- ── Guards ──────────────────────────────────────────────────────────────────
-- Snapshots: append-only; none may be added once the quotation is approved (the approved revision is immutable); the document may only reference a snapshot of its own quotation.
create or replace function newquip_quote_customers_guard() returns trigger language plpgsql set search_path = public as $$
declare v_state text;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    if exists (select 1 from organizations where id = old.org_id) then raise exception 'newquip_quote_customers: snapshots are an audit record and are never updated or deleted'; end if;
    return old;
  end if;
  select state into v_state from newquip_quotes where id = new.quote_id and org_id = new.org_id;
  if v_state is distinct from 'REP_DRAFT' and v_state is distinct from 'ESTIMATOR_REVIEW' then
    raise exception 'newquip_quote_customers: the customer snapshot of an approved quotation is immutable';
  end if;
  return new;
end;
$$;
create trigger newquip_quote_customers_guard_trg before insert or update or delete on newquip_quote_customers for each row execute function newquip_quote_customers_guard();

create or replace function newquip_company_profiles_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if exists (select 1 from organizations where id = old.org_id) then raise exception 'newquip_company_profiles: profile versions are never updated or deleted'; end if;
  return old;
end;
$$;
create trigger newquip_company_profiles_guard_trg before update or delete on newquip_company_profiles for each row execute function newquip_company_profiles_guard();

-- Documents: only for an approved quotation, at its approved revision and baseline hash, with the snapshot of the same quotation; never updated or deleted.
create or replace function newquip_quote_documents_guard() returns trigger language plpgsql set search_path = public as $$
declare q record; s_quote uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    if exists (select 1 from organizations where id = old.org_id) then raise exception 'newquip_quote_documents: an issued document is immutable and is never replaced or deleted'; end if;
    return old;
  end if;
  select state, revision, baseline_hash, quote_ref into q from newquip_quotes where id = new.quote_id and org_id = new.org_id;
  if q.state is distinct from 'MANAGER_APPROVED_FINAL' then raise exception 'newquip_quote_documents: a customer document can only be issued for a Manager-approved quotation'; end if;
  if new.revision <> q.revision or new.baseline_hash <> q.baseline_hash or new.quote_ref <> q.quote_ref then
    raise exception 'newquip_quote_documents: the document must match the approved revision and baseline';
  end if;
  select quote_id into s_quote from newquip_quote_customers where id = new.customer_snapshot_id and org_id = new.org_id;
  if s_quote is distinct from new.quote_id then raise exception 'newquip_quote_documents: the customer snapshot belongs to a different quotation'; end if;
  return new;
end;
$$;
create trigger newquip_quote_documents_guard_trg before insert or update or delete on newquip_quote_documents for each row execute function newquip_quote_documents_guard();

-- Sends: identity is immutable; only the delivery outcome fields may change, and an ACCEPTED/SUPPRESSED send never regresses.
create or replace function newquip_quote_sends_guard() returns trigger language plpgsql set search_path = public as $$
declare d record;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from organizations where id = old.org_id) then raise exception 'newquip_quote_sends: send history is never deleted'; end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    select quote_id into d from newquip_quote_documents where id = new.document_id and org_id = new.org_id;
    if d.quote_id is distinct from new.quote_id then raise exception 'newquip_quote_sends: the document belongs to a different quotation'; end if;
    return new;
  end if;
  if (to_jsonb(new) - 'status' - 'provider_message_id' - 'last_error' - 'attempted_at' - 'suppressed_emails') is distinct from
     (to_jsonb(old) - 'status' - 'provider_message_id' - 'last_error' - 'attempted_at' - 'suppressed_emails') then
    raise exception 'newquip_quote_sends: only the delivery outcome of a send may change';
  end if;
  if old.status in ('ACCEPTED', 'SUPPRESSED') and new.status is distinct from old.status then
    raise exception 'newquip_quote_sends: a % send never changes status', old.status;
  end if;
  return new;
end;
$$;
create trigger newquip_quote_sends_guard_trg before insert or update or delete on newquip_quote_sends for each row execute function newquip_quote_sends_guard();

-- Responses: append-only, recorded only against an issued document of the same quotation.
create or replace function newquip_quote_responses_guard() returns trigger language plpgsql set search_path = public as $$
declare d record;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    if exists (select 1 from organizations where id = old.org_id) then raise exception 'newquip_quote_responses: customer responses are an audit record and are never updated or deleted'; end if;
    return old;
  end if;
  select quote_id into d from newquip_quote_documents where id = new.document_id and org_id = new.org_id;
  if d.quote_id is distinct from new.quote_id then raise exception 'newquip_quote_responses: the document belongs to a different quotation'; end if;
  return new;
end;
$$;
create trigger newquip_quote_responses_guard_trg before insert or update or delete on newquip_quote_responses for each row execute function newquip_quote_responses_guard();

-- ── RLS: members read their own organisation; no client writes ──────────────
alter table newquip_quote_customers  enable row level security;
alter table newquip_company_profiles enable row level security;
alter table newquip_quote_documents  enable row level security;
alter table newquip_quote_sends      enable row level security;
alter table newquip_quote_responses  enable row level security;
create policy "org members read newquip_quote_customers"  on newquip_quote_customers  for select using (is_org_member(org_id));
create policy "org members read newquip_company_profiles" on newquip_company_profiles for select using (is_org_member(org_id));
create policy "org members read newquip_quote_documents"  on newquip_quote_documents  for select using (is_org_member(org_id));
create policy "org members read newquip_quote_sends"      on newquip_quote_sends      for select using (is_org_member(org_id));
create policy "org members read newquip_quote_responses"  on newquip_quote_responses  for select using (is_org_member(org_id));

-- ── Private storage bucket ──────────────────────────────────────────────────
-- NOT public and NO storage.objects policy for anon/authenticated: with RLS on storage.objects the bucket is reachable only with the service role,
-- i.e. through the authenticated, organisation-checked download route. There is no public or permanent URL.
insert into storage.buckets (id, name, public) values ('newquip-quote-documents', 'newquip-quote-documents', false) on conflict (id) do nothing;
