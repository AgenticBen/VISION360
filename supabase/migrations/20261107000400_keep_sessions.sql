-- Conversations are kept until an admin deletes them (owner's decision,
-- 2026-11-07). Existing conversations get the "keep" expiry, in the row and in
-- the bundle each server copy imports. purge_expired_sessions() is unchanged:
-- it only removes rows whose expiry has passed, which "keep" never does.
update public.session_bundles
   set expires_at = '9999-12-31T00:00:00Z',
       bundle = jsonb_set(bundle, '{session,expires_at}', '"9999-12-31T00:00:00.000Z"', false)
 where expires_at < '9999-01-01';
