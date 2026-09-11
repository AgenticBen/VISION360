# VISION360

Lions Services' working vision-loss referral directory for the greater Charlotte area.

Live app: https://lions-vision-referral.vercel.app/

The app is plain HTML, CSS, and JavaScript. Its Directory, Pathways, and Find services views read a structured resource dataset. No framework or external database is required for this version.

## Local use

Use Node.js 24 and Python 3:

```sh
npm run check
python3 -m http.server 8000 --directory site
```

Open http://localhost:8000. The checks validate records, linked programs, geography configuration, and assessment routing scenarios.

## Search and feedback

Search is available above all three views. It matches names, aliases, services, geography, eligibility, preparation, contact details, and referral-step text. Search filters the Directory only; it does not change assessment answers, recommendations, or organization records. Use Clear all in Directory to restore all records. Each expanded listing has a copyable direct link.

The persistent feedback button opens an accessible dialog. Feedback is handed to the visitor's email app, addressed to ben@agenticarc.ai, for review; the visitor must press Send in that app. There is a copy fallback. This static version does not store submissions or provide server-side delivery confirmation. It includes neither search terms nor assessment answers in feedback. Feedback never edits a listing automatically.

## Updating records

Edit `data/organizations.json`, then run `npm run check`. The data build generates `site/data/organizations.json`, which is the only organization dataset deployed. Commit both copies. Keep organization IDs and parent/program relationships stable. Clearly distinguish unknown requirements from confirmed absence of requirements. Preserve clinical-service limitations and published referral paths.

For partner corrections, retain the source correspondence and exact before/after audit privately. Reconcile current values before applying a change, run the checks, and verify the actual production webpage after deployment. Source emails, acknowledgment logs, and private research do not belong in this public repository.

## Deployment

This repository uses the existing Vercel project `lions-vision-referral` in `agenticbens-projects`. The output directory is `site`. Preserve `vercel.json` and `.vercelignore`; no build script is required on Vercel.

```sh
vercel link --project lions-vision-referral --scope agenticbens-projects
npm run check
vercel --prod
```

After deployment, reload the live site, search for the updated organization, inspect its expanded entry and affected views, and compare the displayed fields and contact links against the change record. A successful deployment alone does not complete verification.

## Source and limitations

The initial import comes from the original application that matched the September 4, 2026 production deployment. It includes application code, schema, validation scripts, geographic definition, and the already-public dataset. Private research files and original local history are not included. This repository's editable dataset starts from the published records.

The directory remains a working verification tool. Unknown information is shown explicitly. Geography is provisional; distant organizations remain available. Existing checks report two organizations reachable only through Directory and several counties outside the provisional geographic definition. This import does not resolve those existing limitations or certify full accessibility conformance.

No open-source license has been added.
