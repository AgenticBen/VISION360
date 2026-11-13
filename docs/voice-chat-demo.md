# Vision 360 CONNECT — web voice and chat demo (runbook)

A controlled demonstration, not a production service. Use fictional people and test inboxes only.

## What it is

- `/demo` — talk or type to get grounded referrals from this directory.
- `/staff` — staff queue: confirmed answers, unknowns, suggestions with reasons, email status, requests.
- `/admin` — the admin app, behind the admin password (`admin/shell.js` builds the sidebar; the pages are served by the function, not as static files): Dashboard, Conversations (the staff queue; `/staff` redirects here), Email tracker, Workflows and the visual editor, Raw data, Estimated costs, Requests, Change log, and Connect Claude & ChatGPT.
- **Workflows** (`site/data/flows/index.json`): `referral` is `site/data/assessment.json`, used live by the assistant and the directory quiz; `v360-interest` is the V360 TECH interest form, not used live yet. The editor (`/admin/workflows/edit/?flow=…`) saves drafts to the `admin-data` branch; **Publish** makes one commit on `main` with the workflow, `data/corpus.lock.json` and the regenerated golden expectations, and Vercel redeploys. Checks (`server/lib/flow-check.mjs`) must pass first; the impact preview re-runs the golden people. Revert re-commits an old version. Without `V360_GITHUB_TOKEN` everything is kept on the server only (`server/lib/gh-store.mjs`, local adapter).
- **Requests and change log** (`server/lib/requests.mjs`): the round request button files "Change content" / "Change the app" requests tagged with the page; Claude works them over MCP. Done needs a summary and writes the change log; a team comment reopens.
- **MCP** (`POST /api/mcp`, `server/lib/mcp.mjs`): Streamable HTTP, JSON responses, no sign-in (optional `V360_MCP_KEY` header). Tools: workflows (read, edit draft, check, publish, revert), requests, change log, dashboard. Fitness check FC7 pins the tool list.
- Admin sign-in is **off** for now (owner's decision, 2026-11-06): the staff queue and admin pages open without a password, and email addresses are partly masked while open. Set `V360_ADMIN_SIGNIN=on` to require a staff password again.
- `/api/*` — the shared server. Voice and typing call the same endpoints, so there is one set of rules.

Flow: one question at a time (from `site/data/assessment.json`) → answers are *proposed* → recap → explicit "yes" for the current revision → matching with the unchanged `site/quiz-engine.js` → results built only from records → optional consented email → optional staff request.

## Run it locally

```sh
npm run demo            # http://localhost:8360/demo  and  /staff
npm run test:demo       # acceptance tests (in-memory database)
npm run check           # existing directory checks
npm run verify          # everything: checks, all tests, fitness checks (also runs in CI)
npm run lock            # after a deliberate data or rule change; review the diff
npm run staff:create -- <username>   # writes a random password to ../private-audit/staff-login.txt
```

Node 24. No packages to install. Local data lives in `.data/` (git-ignored): `v360-demo.sqlite` and `outbox/` (test emails).

Optional settings in `.env.local` (never commit):

| Variable | Purpose |
|---|---|
| `RESEND_API_KEY`, `V360_EMAIL_FROM` | Send real email through Resend. Without them, emails go to the local test outbox and the UI says so. |
| `V360_EMAIL_ALLOWLIST` | Comma-separated test inboxes or `@domain` entries. Required when a real provider is on. |
| `V360_DB_PATH` | SQLite file location. |
| `V360_RETENTION_DAYS` | Default 0: conversations are kept until an admin deletes them. A number of days turns on automatic deletion (daily cron on Vercel, hourly locally). |

## Voice

Voice uses the browser's own Web Speech API: speech recognition for captions and `speechSynthesis` for reading responses aloud. No vendor account or key is needed. Optionally, replies can be read with an ElevenLabs natural voice (`server/lib/tts.mjs`): it needs `ELEVENLABS_API_KEY` on the server **and** the switch on Admin › Money › Estimated costs. The server only ever voices the assistant's own latest reply, and the page falls back to the browser voice if ElevenLabs fails. Limits:

- Works in recent Chrome, Edge and Safari. Firefox has no speech recognition, so it falls back to typing.
- Chrome and Edge send audio to their maker's speech service for recognition; Safari uses Apple's. The start page says this before the microphone is requested.
- Interim words are shown as "still listening" and never sent. Only final transcripts are sent, and the server only proposes answers from them.
- Interrupting: the Stop speaking button or Escape. Talking over the assistant only interrupts if "Let me interrupt by talking" is on (best with headphones).
- A managed voice provider (for example Vapi or a realtime speech API) can replace this later behind the same `/api` endpoints.

## Deploying

The Vercel project serves `site/` statically and `api/v360.mjs` as a function (see `vercel.json`).
Without a hosted database, the function stores sessions in `/tmp`, which is temporary and per-instance. The page shows a "Preview limits" notice in that case. A durable hosted demo needs a database adapter and its connection settings.

Production deploys change the live directory site. Follow `CLAUDE.md`: run checks, deploy, then do live QA.

## Guarantees the tests check

- The directory, assessment, geography, pathways and engine files match the reviewed corpus lock (`data/corpus.lock.json`). Changing them is allowed on purpose: `npm run lock`, review, commit.
- Golden routing: fixed sample people get the same recommendations unless the rules change on purpose; a failure prints which services moved. The chat (typed and voice) reaches the same results as the engine.
- Geography ranking and result selection exist only in `site/quiz-engine.js`, shared by the directory, chat and voice (fitness check FC5).
- A turn loads the session once and saves once. A save that conflicts with another save of the same session is rejected (409), never silently overwritten. The conversation code never touches storage directly (fitness check FC6).
- A reply at the summary that mentions an answer ("I do have an eye doctor") is treated as a correction, never as a yes.
- No suggestions before an explicit recap confirmation. A stale "yes" is rejected.
- Unknown, declined, skipped and not-asked never become "no".
- Corrections invalidate earlier suggestions and cancel unstarted emails. An email already sent is flagged for staff, not hidden.
- An email needs a read-back address, an explicit yes to an exact description, and an allowlisted inbox when a real provider is used. Retries never send twice.
- Staff and admin routes need a signed-in staff user only when `V360_ADMIN_SIGNIN=on`. Session routes need the session's own token. Cross-origin writes are rejected.

## Not done in this demo

Telephone access, assisted form-filling, real participant data, and production release gates (privacy and HIPAA review, vendor agreements, retention sign-off, staff ownership, routing approval by Lions Services).

Contacting organizations for the person (Admin › Outreach, `server/lib/dialogue-outreach.mjs`) is built but stays in demo mode until those gates are passed: with `V360_OUTREACH_LIVE` unset, every referral email goes to the test inbox, labelled with the organization it was meant for. The person must hear an exact read-back (organizations, name, contact details) and say a clear yes; each referral is a separate action tied to the answer revision, so a correction or "stop contacting them" cancels anything not yet sent. Organizations get the person's name and contact details only, and the wording is "may be eligible", never "qualifies".
