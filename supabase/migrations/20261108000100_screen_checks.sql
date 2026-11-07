-- Screen Settings Check (Phase 1: tables only; nothing writes to them until
-- the feature is switched on in a later phase).
--
-- Private like every other table here: row-level security on, no access for
-- anon or authenticated, the server's service_role only. Results are kept
-- until staff delete them; deleting a check deletes its steps and reviews.
-- Nothing in these tables is ever written to the public repository.

create table if not exists public.screen_checks (
  id                     uuid        primary key,
  code                   text        not null unique,        -- short code a person can say or type to retake
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  finished_at            timestamptz,
  status                 text        not null default 'started'
                           check (status in ('started', 'finished', 'abandoned')),
  -- Linked only when started from the Vision Assessment's button (the server
  -- checks that session's token first). No foreign key: a conversation can be
  -- deleted on its own, and the check stays.
  assessment_session_id  uuid,
  previous_check_id      uuid        references public.screen_checks (id) on delete set null,
  device                 jsonb       not null default '{}'::jsonb,   -- type, OS, screen size in CSS pixels
  goal                   text        check (goal is null or char_length(goal) <= 500),
  age_range              text        check (age_range is null or age_range in ('under_18', '18_34', '35_54', '55_64', '65_74', '75_plus')),
  zip                    text        check (zip is null or zip ~ '^[0-9]{5}$'),
  settings               jsonb       not null default '{}'::jsonb,   -- what was applied: text size, colors, speech rate, pointer
  contact                jsonb,                                       -- only if given, with consent
  consent_contact        boolean     not null default false,
  wants_call             boolean     not null default false,
  staff_status           text        not null default 'needs_review'
                           check (staff_status in ('needs_review', 'reviewed', 'closed')),
  constraint screen_checks_contact_needs_consent check (contact is null or consent_contact)
);
create index if not exists screen_checks_created on public.screen_checks (created_at desc);
create index if not exists screen_checks_staff on public.screen_checks (staff_status, created_at desc);
create index if not exists screen_checks_assessment on public.screen_checks (assessment_session_id) where assessment_session_id is not null;

create table if not exists public.screen_check_steps (
  id                 bigint generated always as identity primary key,
  check_id           uuid        not null references public.screen_checks (id) on delete cascade,
  setting            text        not null check (setting in ('speech_rate', 'magnification', 'contrast', 'cursor')),
  trials             jsonb       not null default '[]'::jsonb,   -- each trial: what was shown, the answer, right or wrong, time
  measured_limit     text,
  recommended_value  text,
  unit               text,
  tries              integer     not null default 0,
  duration_ms        integer,
  flags              text[]      not null default '{}',
  created_at         timestamptz not null default now(),
  unique (check_id, setting)
);

create table if not exists public.screen_check_reviews (
  id          bigint generated always as identity primary key,
  check_id    uuid        not null references public.screen_checks (id) on delete cascade,
  reviewer    text        not null,
  decisions   jsonb       not null default '{}'::jsonb,   -- per setting: accept | edit (with value) | reject
  notes       text,
  next_steps  text,
  case_note   text,
  review_ms   integer,
  created_at  timestamptz not null default now()
);
create index if not exists screen_check_reviews_check on public.screen_check_reviews (check_id, created_at desc);

-- ---------------------------------------------------------------- lock it down
do $$
declare t text;
begin
  foreach t in array array['screen_checks', 'screen_check_steps', 'screen_check_reviews']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
grant select, insert, update, delete on public.screen_checks to service_role;
grant select, insert, update, delete on public.screen_check_steps to service_role;
grant select, insert, update, delete on public.screen_check_reviews to service_role;
grant usage, select on all sequences in schema public to service_role;
