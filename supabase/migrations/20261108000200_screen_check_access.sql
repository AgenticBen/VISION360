-- Screen Settings Check, phase 2.
--
-- * token_hash: each check is reached with its own random token (only the
--   hash is stored), like conversations.
-- * code: a person keeps one short code for every retake, so it is no longer
--   unique per row; retakes point back with previous_check_id.
-- * The bold-text test (v1.1) is a fifth kind of step.

alter table public.screen_checks add column if not exists token_hash text;
alter table public.screen_checks drop constraint if exists screen_checks_code_key;
create index if not exists screen_checks_code on public.screen_checks (code, created_at desc);

alter table public.screen_check_steps drop constraint if exists screen_check_steps_setting_check;
alter table public.screen_check_steps add constraint screen_check_steps_setting_check
  check (setting in ('speech_rate', 'magnification', 'contrast', 'cursor', 'bold'));
