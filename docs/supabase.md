# Supabase for VISION360 (prepared, not switched on)

Everything needed to move VISION360's changing data into a Supabase project is in the repo. Nothing uses it until the settings below are added in Vercel.

## What moves, and when

| Data | Today | With Supabase |
|---|---|---|
| Published workflow versions | Commits on `main` (the editor's GitHub token) | Unchanged: git stays the version log, and Vercel redeploys from it |
| Workflow drafts, change requests, change log | `admin-data` branch on GitHub, or this server only | `admin_documents` table (every write kept in `admin_document_history`) |
| Conversations, answers, suggestions, emails, staff follow-ups | SQLite in `/tmp` on Vercel (resets on restart) | Tables are ready (`sessions`, `answers`, …). The session repository adapter is the next step (horizon 2) |

## Files

- `supabase/migrations/20261107000100_vision360_core.sql` — the schema. Row Level Security is on for every table with **no policies**, so the public `anon` key can't read or write anything; only the server, with the service role key, can. History is append-only. `purge_expired_sessions()` removes conversations past their expiry date; since 2026-11-07 conversations are kept until an admin deletes them (expiry 9999-12-31), unless `V360_RETENTION_DAYS` is set. It has been applied twice to a local Postgres 17 (it's safe to re-run) and checked for history, append-only, RLS and purge.
- `server/lib/supabase-store.mjs` — the adapter (plain `fetch` to PostgREST, no new dependencies). `createAdminStore` uses it for drafts, requests and the change log when both settings below are set, and keeps published versions on GitHub.
- `tests/supabase-store.test.mjs` — runs the adapter against a fake PostgREST.

## Turning it on

1. **Create the project** (Ben approves the cost first): a new project named `vision360` in a Lions Services organization, region `us-east-1`. The free plan pauses after a week without use, so the pilot needs a paid plan. Health data needs Supabase's HIPAA add-on and a signed BAA before real participants use it.
2. **Apply the migration**: in the Supabase SQL editor run `supabase/migrations/20261107000100_vision360_core.sql`, or `supabase db push` from this folder.
3. **Add two settings in Vercel** (Production and Preview), then redeploy:
   - `V360_SUPABASE_URL` = `https://<project-ref>.supabase.co`
   - `V360_SUPABASE_SERVICE_KEY` = the service role key (Project Settings → API). This is a secret: never put it in the site, the repo or a chat.
4. **Check**: Admin → Connect Claude & ChatGPT should show "Drafts, requests and change log: Supabase". File a test request with the round button and confirm it appears on the Requests page and as a row in `admin_documents`.

## Next: conversations

`server/lib/session-repo.mjs` already separates conversation storage behind `load` / `save`, with one save per turn guarded by `version`. The Supabase version is a Postgres function, `save_session(id, expected_version, ops jsonb)`, that applies the queued operations in one transaction and returns 409 when the version moved. A `createSupabaseSessionRepo` calls it, plus a Vercel cron for `purge_expired_sessions()` and the email queue. That is horizon 2 in the pilot plan.
