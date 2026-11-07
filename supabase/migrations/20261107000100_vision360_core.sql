-- VISION360 on Supabase: first migration.
--
-- Two parts:
--   1. Admin documents: drafts, change requests and the change log, the same
--      JSON documents the editor keeps on the GitHub admin-data branch in dev.
--      server/lib/supabase-store.mjs reads and writes them (optimistic `sha`).
--   2. Conversations: one row per conversation holding everything about it
--      (answers, suggestions, consent, emails, staff follow-ups) as a JSON
--      bundle. server/lib/supabase-sessions.mjs reads and writes it; each
--      server copy keeps a local SQLite cache (server/lib/store.mjs).
--      A turn only saves if `version` still matches what it loaded.
-- Published workflow versions are NOT here: they are commits on main.
--
-- Security: Row Level Security is on for every table and there are NO
-- policies, so the public anon key can read or write nothing. Only the server
-- (service role key, kept in Vercel) talks to the database. The browser never
-- talks to Supabase directly.

-- ---------------------------------------------------------------- admin documents
create table if not exists public.admin_documents (
  branch      text        not null,           -- "admin-data" (mirrors the git branch)
  path        text        not null,           -- e.g. requests.json, changelog.json, drafts/referral.json
  body        text        not null,
  sha         text        not null,           -- content hash; writes must name the sha they read
  updated_at  timestamptz not null default now(),
  primary key (branch, path),
  constraint admin_documents_body_size check (octet_length(body) <= 1048576)
);

-- Every write is also kept, so nothing is ever lost (the git history equivalent).
create table if not exists public.admin_document_history (
  id          bigint generated always as identity primary key,
  branch      text        not null,
  path        text        not null,
  body        text        not null,
  sha         text        not null,
  message     text,
  written_at  timestamptz not null default now()
);
create index if not exists admin_document_history_path on public.admin_document_history (branch, path, written_at desc);

create or replace function public.admin_documents_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.admin_document_history (branch, path, body, sha, message)
  values (new.branch, new.path, new.body, new.sha, (nullif(current_setting('request.headers', true), '')::json ->> 'x-v360-message'));
  return new;
end $$;
drop trigger if exists admin_documents_history on public.admin_documents;
create trigger admin_documents_history after insert or update on public.admin_documents
  for each row execute function public.admin_documents_history();

-- History is append-only.
create or replace function public.forbid_change() returns trigger language plpgsql set search_path = public as $$
begin raise exception 'admin_document_history is append-only'; end $$;
drop trigger if exists admin_document_history_append_only on public.admin_document_history;
create trigger admin_document_history_append_only before update or delete on public.admin_document_history
  for each row execute function public.forbid_change();

-- ---------------------------------------------------------------- conversations
create table if not exists public.session_bundles (
  id              uuid        primary key,
  version         integer     not null,
  created_at      timestamptz not null,
  updated_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  status          text        not null,
  staff_status    text        not null default 'pending',
  open_followups  integer     not null default 0,   -- staff follow-ups not yet closed
  next_action_at  timestamptz,                      -- earliest queued/retrying email
  bundle          jsonb       not null,
  constraint session_bundles_size check (octet_length(bundle::text) <= 2097152)
);
create index if not exists session_bundles_created on public.session_bundles (created_at desc);
create index if not exists session_bundles_due on public.session_bundles (next_action_at) where next_action_at is not null;
create index if not exists session_bundles_expiry on public.session_bundles (expires_at);

-- Retention: conversations expire after V360_RETENTION_DAYS (7), but a
-- conversation with an open staff follow-up is kept until it's closed.
create or replace function public.purge_expired_sessions() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.session_bundles where expires_at < now() and open_followups = 0;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------- lock it down
do $$
declare t text;
begin
  foreach t in array array['admin_documents','admin_document_history','session_bundles']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
revoke execute on function public.purge_expired_sessions() from anon, authenticated, public;
grant execute on function public.purge_expired_sessions() to service_role;
revoke execute on function public.admin_documents_history() from anon, authenticated, public;
revoke execute on function public.forbid_change() from anon, authenticated, public;
