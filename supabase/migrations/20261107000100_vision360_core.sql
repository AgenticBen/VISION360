-- VISION360 on Supabase: first migration (prepared, not yet applied).
--
-- Two parts:
--   1. Admin documents: drafts, change requests and the change log, the same
--      JSON documents the editor keeps on the GitHub admin-data branch today.
--      server/lib/supabase-store.mjs reads and writes them (optimistic `sha`).
--   2. Conversation tables, mirroring server/lib/store.mjs (SQLite) so the
--      session repository can move here next (horizon 2). Published workflow
--      versions stay as commits on main (Vercel redeploys from git).
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
create or replace function public.forbid_change() returns trigger language plpgsql as $$
begin raise exception 'admin_document_history is append-only'; end $$;
drop trigger if exists admin_document_history_append_only on public.admin_document_history;
create trigger admin_document_history_append_only before update or delete on public.admin_document_history
  for each row execute function public.forbid_change();

-- ---------------------------------------------------------------- conversations
create table if not exists public.sessions (
  id              uuid        primary key,
  token_hash      text        not null,
  created_at      timestamptz not null,
  updated_at      timestamptz not null,
  expires_at      timestamptz not null,
  status          text        not null default 'active',
  revision        integer     not null default 0,
  version         integer     not null default 0,     -- optimistic guard per save (see session-repo.mjs)
  corpus_version  text        not null,
  notice_ack_at   timestamptz,
  staff_status    text        not null default 'pending' check (staff_status in ('pending','reviewed','needs_follow_up')),
  channels        jsonb       not null default '[]',
  state           jsonb       not null default '{}'
);
create index if not exists sessions_updated on public.sessions (updated_at desc);
create index if not exists sessions_expires on public.sessions (expires_at);

create table if not exists public.answers (
  session_id          uuid    not null references public.sessions(id) on delete cascade,
  question_id         text    not null,
  value               jsonb,
  kind                text    not null,
  revision            integer not null,
  confirmed_revision  integer,
  source              text    not null,
  updated_at          timestamptz not null,
  primary key (session_id, question_id)
);

create table if not exists public.answer_events (
  id           bigint generated always as identity primary key,
  session_id   uuid    not null references public.sessions(id) on delete cascade,
  question_id  text,
  event        text    not null,
  value        jsonb,
  kind         text,
  revision     integer not null,
  at           timestamptz not null
);
create index if not exists answer_events_session on public.answer_events (session_id, id);

create table if not exists public.recommendations (
  id              uuid    primary key,
  session_id      uuid    not null references public.sessions(id) on delete cascade,
  revision        integer not null,
  corpus_version  text    not null,
  result          jsonb   not null,
  stale           boolean not null default false,
  created_at      timestamptz not null
);
create index if not exists recommendations_session on public.recommendations (session_id, created_at);

create table if not exists public.authorizations (
  id                 uuid primary key,
  session_id         uuid not null references public.sessions(id) on delete cascade,
  action_type        text not null,
  destination        text not null,
  payload_hash       text not null,
  purpose            text not null,
  revision           integer not null,
  recommendation_id  uuid,
  method             text not null,
  granted_at         timestamptz not null
);

create table if not exists public.actions (
  id                uuid primary key,
  session_id        uuid not null references public.sessions(id) on delete cascade,
  type              text not null,
  status            text not null,
  idempotency_key   text not null unique,
  authorization_id  uuid,
  revision          integer not null,
  payload           jsonb not null,
  attempts          integer not null default 0,
  next_attempt_at   timestamptz not null,
  lease_until       timestamptz,
  provider          text,
  provider_receipt  text,
  error             text,
  created_at        timestamptz not null,
  updated_at        timestamptz not null
);
create index if not exists actions_due on public.actions (status, next_attempt_at);
create index if not exists actions_session on public.actions (session_id, created_at);

create table if not exists public.staff_reviews (
  id           uuid primary key,
  session_id   uuid not null references public.sessions(id) on delete cascade,
  reason       text not null,
  contact      jsonb,
  callback_ok  boolean not null default false,
  status       text not null default 'pending',
  owner        text,
  created_at   timestamptz not null,
  updated_at   timestamptz not null
);

create table if not exists public.staff_users (
  id             uuid primary key,
  username       text not null unique,
  password_hash  text not null,
  created_at     timestamptz not null,
  disabled       boolean not null default false
);

create table if not exists public.staff_sessions (
  token_hash  text primary key,
  user_id     uuid not null references public.staff_users(id) on delete cascade,
  created_at  timestamptz not null,
  expires_at  timestamptz not null
);

create table if not exists public.turn_cache (
  session_id      uuid not null references public.sessions(id) on delete cascade,
  client_turn_id  text not null,
  response        jsonb not null,
  at              timestamptz not null,
  primary key (session_id, client_turn_id)
);

create table if not exists public.audit_events (
  id          bigint generated always as identity primary key,
  at          timestamptz not null,
  actor       text not null,
  session_id  uuid,
  event       text not null,
  detail      jsonb
);
create index if not exists audit_events_session on public.audit_events (session_id, id);
create index if not exists audit_events_at on public.audit_events (at desc);

-- Retention: conversations expire after V360_RETENTION_DAYS (7). Cascades
-- remove their answers, suggestions, actions and reviews. Run from a Vercel
-- cron or pg_cron once the session repository moves here.
create or replace function public.purge_expired_sessions() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.audit_events a using public.sessions s where a.session_id = s.id and s.expires_at < now();
  delete from public.sessions where expires_at < now();
  get diagnostics n = row_count;
  delete from public.staff_sessions where expires_at < now();
  return n;
end $$;

-- ---------------------------------------------------------------- lock it down
do $$
declare t text;
begin
  foreach t in array array['admin_documents','admin_document_history','sessions','answers','answer_events','recommendations','authorizations','actions','staff_reviews','staff_users','staff_sessions','turn_cache','audit_events']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
revoke execute on function public.purge_expired_sessions() from anon, authenticated, public;
