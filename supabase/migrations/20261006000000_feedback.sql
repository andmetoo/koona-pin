-- Feedback from the app and from koona.app/pin (NP-088, Р-9).
-- Written only by the Edge Function `feedback` with the service role key:
-- RLS is on and there is no policy, so `anon` and `authenticated` can neither
-- read nor write these tables, even with the public key.

create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('bug', 'idea', 'question')),
  message text not null check (char_length(message) between 1 and 5000),
  email text check (email is null or char_length(email) <= 254),
  app_version text check (app_version is null or char_length(app_version) <= 40),
  os text check (os is null or char_length(os) <= 100),
  language text check (language is null or char_length(language) <= 10),
  -- The report the person saw and chose to attach; never filled without the box ticked.
  report text check (report is null or char_length(report) <= 10000),
  source text not null check (source in ('app', 'site'))
);

-- One row per accepted request, for the limit per address. The address is a
-- salted SHA-256 (the salt is a function secret) and lives for a day.
create table public.feedback_hits (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  at timestamptz not null default now()
);
create index feedback_hits_ip_hash_at on public.feedback_hits (ip_hash, at);

alter table public.feedback enable row level security;
alter table public.feedback_hits enable row level security;
revoke all on public.feedback, public.feedback_hits from anon, authenticated;

-- Stores a message if its sender has a place left in the hourly limit, else returns
-- false. One transaction: if the insert fails, the place is not used up. The advisory
-- lock makes two requests from one address at the same moment count as two.
create function public.feedback_submit(address_hash text, per_hour integer, entry jsonb)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  used integer;
begin
  perform pg_advisory_xact_lock(hashtext(address_hash));
  select count(*) into used
    from public.feedback_hits
    where ip_hash = address_hash and at > now() - interval '1 hour';
  if used >= per_hour then
    return false;
  end if;
  insert into public.feedback (kind, message, email, app_version, os, language, report, source)
    select r.kind, r.message, r.email, r.app_version, r.os, r.language, r.report, r.source
    from jsonb_populate_record(null::public.feedback, entry) as r;
  insert into public.feedback_hits (ip_hash) values (address_hash);
  return true;
end;
$$;
revoke execute on function public.feedback_submit(text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.feedback_submit(text, integer, jsonb) to service_role;
