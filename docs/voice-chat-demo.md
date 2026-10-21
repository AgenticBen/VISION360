# Vision 360 CONNECT — web voice and chat demo (runbook)

A controlled demonstration, not a production service. Use fictional people and test inboxes only.

## What it is

- `/demo` — talk or type to get grounded referrals from this directory.
- `/staff` — password-protected staff queue: confirmed answers, unknowns, suggestions with reasons, email status, requests.
- `/api/*` — the shared server. Voice and typing call the same endpoints, so there is one set of rules.

Flow: one question at a time (from `site/data/assessment.json`) → answers are *proposed* → recap → explicit "yes" for the current revision → matching with the unchanged `site/quiz-engine.js` → results built only from records → optional consented email → optional staff request.

## Run it locally

```sh
npm run demo            # http://localhost:8360/demo  and  /staff
npm run test:demo       # acceptance tests (in-memory database)
npm run check           # existing directory checks
npm run staff:create -- <username>   # writes a random password to ../private-audit/staff-login.txt
```

Node 24. No packages to install. Local data lives in `.data/` (git-ignored): `v360-demo.sqlite` and `outbox/` (test emails).

Optional settings in `.env.local` (never commit):

| Variable | Purpose |
|---|---|
| `RESEND_API_KEY`, `V360_EMAIL_FROM` | Send real email through Resend. Without them, emails go to the local test outbox and the UI says so. |
| `V360_EMAIL_ALLOWLIST` | Comma-separated test inboxes or `@domain` entries. Required when a real provider is on. |
| `V360_DB_PATH` | SQLite file location. |
| `V360_RETENTION_DAYS` | Default 7. Expired sessions are purged hourly. |

## Voice

Voice uses the browser's own Web Speech API: speech recognition for captions and `speechSynthesis` for reading responses aloud. No vendor account or key is needed. Limits:

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

- The directory, assessment, geography, pathways and engine files are byte-identical to the baseline (hash test).
- No suggestions before an explicit recap confirmation. A stale "yes" is rejected.
- Unknown, declined, skipped and not-asked never become "no".
- Corrections invalidate earlier suggestions and cancel unstarted emails. An email already sent is flagged for staff, not hidden.
- An email needs a read-back address, an explicit yes to an exact description, and an allowlisted inbox when a real provider is used. Retries never send twice.
- Staff routes need a signed-in staff user. Session routes need the session's own token. Cross-origin writes are rejected.

## Not done in this demo

Telephone access, assisted form-filling, real participant data, and production release gates (privacy and HIPAA review, vendor agreements, retention sign-off, staff ownership, routing approval by Lions Services).
