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

A demonstration of talking or typing to get referrals lives at `/demo`, with a protected staff queue at `/staff`. It reads this dataset and the existing assessment engine without changing them. See `docs/voice-chat-demo.md`.

```sh
npm run demo        # http://localhost:8360/demo
npm run test:demo
```

## Updating records

Edit `data/organizations.json`, then run `npm run data` and `npm run lock`, and review the lock diff and the golden routing output from `npm run test:demo` (regenerate expected results with `node scripts/golden-update.mjs` only when a routing change is intended). Then run `npm run verify`. The data build generates `site/data/organizations.json`, which is the only organization dataset deployed. Commit both copies. Keep organization IDs and parent/program relationships stable. Clearly distinguish unknown requirements from confirmed absence of requirements. Preserve clinical-service limitations and published referral paths.

For partner corrections, retain the source correspondence and exact before/after audit privately. Reconcile current values before applying a change, run the checks, and verify the actual production webpage after deployment. Source emails, acknowledgment logs, and private research do not belong in this public repository.

## Deployment

This repository uses the existing Vercel project `lions-vision-referral` in `agenticbens-projects`. The output directory is `site`. Preserve `vercel.json` and `.vercelignore`; no build script is required on Vercel.

```sh
vercel link --project lions-vision-referral --scope agenticbens-projects
npm run verify
vercel --prod
```

After deployment, check that `/api/health` reports the deployed `commit` and that its data hashes match `data/corpus.lock.json`. Then reload the live site, search for the updated organization, inspect its expanded entry and affected views, and compare the displayed fields and contact links against the change record. A successful deployment alone does not complete verification.

## Source and limitations

The initial import comes from the original application that matched the September 4, 2026 production deployment. It includes application code, schema, validation scripts, geographic definition, and the already-public dataset. Private research files and original local history are not included. This repository's editable dataset starts from the published records.

The directory remains a working verification tool. Unknown information is shown explicitly. Geography is provisional; distant organizations remain available. `npm run check` reports which organizations are reachable only through Directory and which counties fall outside the provisional geographic definition. This import does not resolve those existing limitations or certify full accessibility conformance.

No open-source license has been added.
