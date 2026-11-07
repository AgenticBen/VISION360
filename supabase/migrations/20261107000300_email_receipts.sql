-- Provider receipts of a conversation's emails, so a delivery webhook can find it.
alter table public.session_bundles add column if not exists email_receipts text[] not null default '{}';
create index if not exists session_bundles_receipts on public.session_bundles using gin (email_receipts);
