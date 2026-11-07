-- Feedback people leave at the end of a conversation (Resource Assistant,
-- Vision Assessment, forms). Kept apart from conversations: deleting a
-- conversation keeps its feedback. One row per conversation; a skip is a row
-- with skipped = true and no text or rating, so the response rate can be shown.
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  session_id text not null unique,
  flow_id text,
  flow_title text,
  tool text not null check (tool in ('assistant', 'assessment', 'form')),
  mode text check (mode in ('spoken', 'typed', 'spoken_edited')),
  text text check (text is null or char_length(text) between 1 and 4000),
  rating smallint check (rating is null or rating between 1 and 5),
  skipped boolean not null default false
);
create index if not exists feedback_created on public.feedback (created_at desc);
alter table public.feedback enable row level security;
-- Server only: no policies, so anon and authenticated can't read or write it.
grant select, insert, update, delete on public.feedback to service_role;
