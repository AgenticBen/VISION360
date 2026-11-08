-- Vision Assessment v2, phase 1 (the shell): ending early is kept.
--   status 'ended'   the person chose End; what they did is saved
--   ended_at         when they ended
--   stopped_at       the test they were on when they ended (or left)
--   setting_changes  text size, colors, bold, pointer or voice changed from
--                    the menu or by voice outside a test, so staff can see what
--                    the person reached for: [{ setting, value, via, at }]
-- "Left without ending" is worked out when read (started, no activity for two
-- hours), so no job writes it. Row-level security and grants are unchanged.

alter table public.screen_checks drop constraint if exists screen_checks_status_check;
alter table public.screen_checks add constraint screen_checks_status_check
  check (status in ('started', 'finished', 'ended', 'abandoned'));

alter table public.screen_checks add column if not exists ended_at timestamptz;
alter table public.screen_checks add column if not exists stopped_at text
  check (stopped_at is null or char_length(stopped_at) <= 40);
alter table public.screen_checks add column if not exists setting_changes jsonb not null default '[]'::jsonb;
