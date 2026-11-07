-- The server (service_role / sb_secret_ key) needs explicit table rights on
-- projects that don't grant them by default. anon and authenticated get none.
grant usage on schema public to service_role;
grant select, insert, update, delete on public.session_bundles to service_role;
grant select, insert, update, delete on public.admin_documents to service_role;
grant select, insert on public.admin_document_history to service_role;
grant usage, select on all sequences in schema public to service_role;
