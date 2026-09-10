# VISION360 maintenance rules

1. Edit organization records in `data/organizations.json`; generate the deployable copy with `npm run data`. Never embed record facts in HTML.
2. Keep umbrella organizations and their distinct programs separate, with stable IDs and valid parent references.
3. Geography sorts; it never excludes. Keep `docs/geography-definition.md` and `site/data/geography.json` consistent.
4. Use verified partner corrections or published sources. Preserve explicit unknowns and clinical limitations. Keep private correspondence and its detailed audit outside this public repository.
5. This is a public codebase. Do not add credentials, internal organizational notes, or unverified personal contact details. The original private research is maintained separately.
6. Run `npm run check` before publication. Preserve semantic HTML, keyboard usability, high contrast, text sizing, and equivalent text for pathways.
7. After publication, visit the existing live website, compare all changed displayed fields with the before/after record, and verify affected navigation and contact links. Mark a change complete only after live QA succeeds.
