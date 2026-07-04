-- Per-org logo, uploaded by a super-admin via /admin, shown in that org's
-- own nav bar (and as a thumbnail on the admin org list).
alter table organizations add column if not exists logo_url text;

-- Public read (logos aren't sensitive and need to render in <img> tags for
-- every org member without a signed URL round-trip); writes only via the
-- service-role client from the admin upload action, never from the browser.
insert into storage.buckets (id, name, public)
values ('org-logos', 'org-logos', true)
on conflict (id) do nothing;

create policy "org logos are publicly readable"
  on storage.objects for select
  using (bucket_id = 'org-logos');
