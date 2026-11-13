# VISION360

Lions Services' working vision-loss referral directory for the greater Charlotte area.

Live app: https://lions-vision-referral.vercel.app/

The app is plain HTML, CSS, and JavaScript. Its Directory, Pathways, and Find services views read a structured resource dataset. No framework or external database is required for this version.

## Local use

Use Node.js 24 and Python 3:

```sh
npm run verify
python3 -m http.server 8000 --directory site
```

Open http://localhost:8000. `npm run verify` validates records, linked programs, geography configuration and assessment routing scenarios, runs every test (including golden routing for fixed sample people), runs the architecture fitness checks, and confirms the generated `site/data` copy is committed. `npm run check` runs only the data checks. GitHub Actions runs `npm run verify` on every push.

## Search and feedback

Search is available above all three views. It matches names, aliases, services, geography, eligibility, preparation, contact details, and referral-step text. Search filters the Directory only; it does not change assessment answers, recommendations, or organization records. Use Clear all in Directory to restore all records. Each expanded listing has a copyable direct link.

The persistent feedback button opens an accessible dialog. Feedback is handed to the visitor's email app, addressed to ben@agenticarc.ai, for review; the visitor must press Send in that app. There is a copy fallback. This static version does not store submissions or provide server-side delivery confirmation. It includes neither search terms nor assessment answers in feedback. Feedback never edits a listing automatically.

## Voice and chat demo

A demonstration of talking or typing to get referrals lives at `/demo`. The admin app at `/admin` has a sidebar with a dashboard, conversations (the staff queue), an email tracker, a visual workflow editor, raw data, estimated costs, change requests, a change log and MCP connection settings. The admin pages live in `admin/` (not `site/`) and are served by the function only after the admin password is entered; the password's scrypt hash and the cookie-signing key are kept in private settings (Supabase `admin_documents`, `settings/auth.json`) and can be changed in Settings. `V360_FLOW_EDITS=off` stops all edits. One workflow is the **main site** (Workflows › Make main site); every published workflow also runs at `/f/<id>`, with a QR code (`/api/qr/<id>.svg`) and a printable flyer. Conversations are kept until an admin deletes them (type DELETE). At the end of every conversation people are asked for feedback (spoken or typed, editable, then a 1–5 rating; both skippable); it is stored apart from conversations (Supabase `feedback` table) and shown on Admin › Feedback, where it can be copied or downloaded as Markdown. Published workflow versions are commits on `main` made by the editor through `V360_GITHUB_TOKEN`, so **pull before working locally**. Claude or ChatGPT connect at `/api/mcp`. Supabase is prepared but off: see `docs/supabase.md`. Every public page shares the top menu in `site/site-menu.js`. It reads this dataset and the existing assessment engine without changing them. See `docs/voice-chat-demo.md`.

```sh
npm run demo        # http://localhost:8360/demo
npm run test:demo
```

## Updating records

Edit `data/organizations.json`, then run `npm run data` and `npm run lock`, and review the lock diff and the golden routing output from `npm run test:demo` (regenerate expected results with `node scripts/golden-update.mjs` only when a routing change is intended). Then run `npm run verify`. The data build generates `site/data/organizations.json`, which is the only organization dataset deployed. Commit both copies. Keep organization IDs and parent/program relationships stable. Clearly distinguish unknown requirements from confirmed absence of requirements. Preserve clinical-service limitations and published referral paths.

For partner corrections, retain the source correspondence and exact before/after audit privately. Reconcile current values before applying a change, run the checks, and verify the actual production webpage after deployment. Source emails, acknowledgment logs, and private research do not belong in this public repository.

## Deployment

This repository uses the existing Vercel project `lions-vision-referral` in `agenticbens-projects`. The output directory is `site`. Preserve `vercel.json` and `.vercelignore`; no build script is required on Vercel.

Production deploys come from git only: push to a branch, open a pull request, and `main` goes live after the `verify` check passes and the PR merges. Don't run `vercel --prod` from a local folder; it would ship uncommitted files and health would report `local` instead of a commit.

```sh
npm run verify
git push origin <branch>   # then open a PR into main
```

After deployment, check that `/api/health` reports the deployed `commit` and that its data hashes match `data/corpus.lock.json`. Then reload the live site, search for the updated organization, inspect its expanded entry and affected views, and compare the displayed fields and contact links against the change record. A successful deployment alone does not complete verification.

### Production settings (Vercel, Production environment)

| Setting | What it does |
|---|---|
| `V360_SUPABASE_URL`, `V360_SUPABASE_SERVICE_KEY` | Conversations, emails, staff follow-ups, drafts, requests and the change log are kept in the Supabase project (migration in `supabase/migrations/`). Without them everything is temporary. The key is server-only; the browser never talks to Supabase. |
| `V360_MCP_KEY` | The connector and publish key. Claude sends it as `?key=` in the connector URL (or an `x-v360-key` header); the workflow editor asks for it once when publishing. Set it **before** the GitHub token: with GitHub connected and no key, all workflow writes are refused. |
| `V360_GITHUB_TOKEN` | Fine-grained token for this repo only (Contents and Pull requests: read and write). A publish opens a pull request from a `publish/*` branch; `.github/workflows/publish.yml` runs `npm run verify`, merges it, and checks the live site (`scripts/verify-live.mjs`). |
| `V360_FLOW_EDITS=off` | Kill switch: stops every workflow and request edit. |
| `V360_ADMIN_SIGNIN=off` | Local machines only: opens the admin without a password (tests, demos). Ignored on the hosted site, where the admin password is always required. |
| `ELEVENLABS_API_KEY` | Natural voice. Also needs the switch on Money › Estimated costs. Optional: `ELEVENLABS_VOICE_ID`, `V360_COST_PER_1K_TTS_CHARS`. |
| `V360_RETENTION_DAYS` | Optional. Unset: conversations are kept until an admin deletes them. A number turns on automatic deletion after that many days. |
| `CRON_SECRET` | Optional: only Vercel's scheduler may call `/api/cron/tick` (daily: due emails, retention purge). |
| `V360_OUTREACH_LIVE` | `on` lets the assistant's referral emails reach the real organizations (Admin › Outreach must also be switched on). Leave it unset until the privacy and partner approvals are done: until then every referral email goes to the demo test inbox, marked with the organization it was meant for. |
| `V360_OUTREACH_TEST_INBOX` | Where demo referral emails go. Defaults to the first exact address in `V360_EMAIL_ALLOWLIST`. |
| `V360_OUTREACH_REPLY_TO` | Optional: the Lions Services inbox organizations reply to. |

The publish path (pull request → `verify` → auto-merge → deploy → verify-live) was checked end to end on 2026-11-07 with a `publish/selftest-20261107` pull request.

Check a deployment with `node scripts/verify-live.mjs https://vision360.agenticarc.ai <commit>`: it waits for the commit, compares data hashes with the lock, and fails if storage isn't Supabase.

## Source and limitations

The initial import comes from the original application that matched the September 4, 2026 production deployment. It includes application code, schema, validation scripts, geographic definition, and the already-public dataset. Private research files and original local history are not included. This repository's editable dataset starts from the published records.

The directory remains a working verification tool. Unknown information is shown explicitly. Geography is provisional; distant organizations remain available. `npm run check` reports which organizations are reachable only through Directory and which counties fall outside the provisional geographic definition. This import does not resolve those existing limitations or certify full accessibility conformance.

No open-source license has been added.
