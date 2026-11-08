-- Vision Assessment, live test: a sixth kind of step, the picture test
-- (house, apple, circle, square at shrinking sizes). Only widens the list of
-- allowed settings; existing rows are unchanged.

alter table public.screen_check_steps drop constraint if exists screen_check_steps_setting_check;
alter table public.screen_check_steps add constraint screen_check_steps_setting_check
  check (setting in ('speech_rate', 'magnification', 'pictures', 'contrast', 'cursor', 'bold'));
