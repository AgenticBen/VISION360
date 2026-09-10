#!/usr/bin/env node
// Generates site/data/organizations.json — the ONLY copy of the data that ships.
//
// data/organizations.json is the working file and is never deployed. This script
// produces the public copy, stripping what CLAUDE.md rule 4 and the site-builder
// spec say must not reach a served file:
//   - internal_only_notes (organizational distress; one org here is a client)
//   - named_staff entries where public_safe is not true
//   - the EMAIL AND PHONE of those same people wherever they were also written
//     into prose the site renders (confidence_note, open_questions,
//     access_path[].detail / .branches[].note, service notes, and so on)
//
// The names themselves are deliberately KEPT. The project lead's open questions
// are her call-sheet ("Call Susan L. King and ask…"); stripping her call targets
// would break the tool she works from. What must not be served is a contact
// detail for someone we could not confirm is publicly listed. So: keep the name,
// redact the contact detail, and say plainly that it was withheld.
//
// The deployed site directory is an allowlist: only files inside site/ are served,
// so source-reports/, data/conflicts.md and data/verification-log.md cannot leak.
// vercel.json (outputDirectory) and .vercelignore enforce that at deploy time.
//
// Zero dependencies. Run: node scripts/build-public.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const SRC = "data/organizations.json";
const OUT_DIR = "site/data";
const OUT = `${OUT_DIR}/organizations.json`;

const REDACTED = "[contact withheld pending verification]";

if (!existsSync(SRC)) {
  console.error(`FAIL: ${SRC} does not exist.`);
  process.exit(1);
}

const orgs = JSON.parse(readFileSync(SRC, "utf8"));
if (!Array.isArray(orgs)) {
  console.error("FAIL: organizations.json must be an array.");
  process.exit(1);
}

/* =========================================================================
   Generic recursive helpers.
   Everything below walks the whole record, at every depth. The previous
   version of this script only looked at the top level and at
   <org>.contacts.named_staff, so a nested internal_only_notes, a named_staff
   inside a programme or an access_path branch, or a nested underscore-prefixed
   working key could ship silently. See qa/links-and-leakage.md.
   ========================================================================= */

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/* Every string value in the tree, in document order. */
function collectStrings(node, out = []) {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) node.forEach((v) => collectStrings(v, out));
  else if (isPlainObject(node)) Object.keys(node).forEach((k) => collectStrings(node[k], out));
  return out;
}

/* Every named_staff entry at any depth. */
function collectNamedStaff(node, out = []) {
  if (Array.isArray(node)) node.forEach((v) => collectNamedStaff(v, out));
  else if (isPlainObject(node)) {
    Object.keys(node).forEach((k) => {
      if (k === "named_staff" && Array.isArray(node[k])) {
        node[k].forEach((s) => { if (isPlainObject(s)) out.push(s); });
      }
      collectNamedStaff(node[k], out);
    });
  }
  return out;
}

/* Recursively: drop internal_only_notes, drop _-prefixed working keys, and
   filter named_staff down to public_safe === true — at every depth. */
function stripInternal(node, counters) {
  if (Array.isArray(node)) return node.map((v) => stripInternal(v, counters));
  if (!isPlainObject(node)) return node;

  const out = {};
  Object.keys(node).forEach((k) => {
    if (k === "internal_only_notes") {
      const v = node[k];
      counters.notes += Array.isArray(v) ? v.length : 1;
      return;                                   // never ships, at any depth
    }
    if (k.startsWith("_")) { counters.working += 1; return; }

    if (k === "named_staff" && Array.isArray(node[k])) {
      const kept = node[k].filter((s) => isPlainObject(s) && s.public_safe === true);
      counters.staff += node[k].length - kept.length;
      out[k] = kept.map((v) => stripInternal(v, counters));
      return;
    }
    out[k] = stripInternal(node[k], counters);
  });
  return out;
}

/* Replace every occurrence of each secret string with REDACTED, everywhere. */
function redactStrings(node, secrets) {
  if (typeof node === "string") {
    let s = node;
    secrets.forEach((sec) => { if (s.includes(sec)) s = s.split(sec).join(REDACTED); });
    return s;
  }
  if (Array.isArray(node)) return node.map((v) => redactStrings(v, secrets));
  if (isPlainObject(node)) {
    const out = {};
    Object.keys(node).forEach((k) => { out[k] = redactStrings(node[k], secrets); });
    return out;
  }
  return node;
}

/* =========================================================================
   Which contact details belong to somebody we could not confirm is listed.

   Two sources, both derived from the data — nothing is hard-coded, so this
   stays correct when the data changes:

     A. The email / phone FIELDS of any named_staff entry whose public_safe is
        not true. Authoritative: the record itself says this is that person's
        contact detail.

     B. A contact detail written into prose immediately after that person's
        name — "a staff member's unverified phone number". Her staff entry
        carries no phone field, so (A) alone would miss it. Scoped to a short
        forward window after the name so that a general line quoted earlier in
        the same sentence ("Call MAB at 704-372-3870 and ask: what is Susan L.
        King's current role…") is not swept up, and additionally excluded if the
        value is one of the organization's own published contacts or belongs to
        a public_safe staff member.
   ========================================================================= */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?1[\s.-])?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?:\s*(?:x|ext\.?)\s*\d{1,5})?/g;
const NAME_WINDOW = 120;   // chars after a name that still count as "theirs"

function contactDetailsOf(staff) {
  return [staff.email, staff.phone]
    .filter((v) => typeof v === "string" && v.trim().length)
    .map((v) => v.trim());
}

function unsafeContactSecrets(org) {
  const staff = collectNamedStaff(org);
  const unsafe = staff.filter((s) => s.public_safe !== true);
  if (!unsafe.length) return [];

  const secrets = new Set();

  // (A) declared fields
  unsafe.forEach((s) => contactDetailsOf(s).forEach((v) => secrets.add(v)));

  // Values we must never redact via the prose heuristic: the organization's own
  // published contacts, and the details of staff we DID confirm.
  const published = new Set();
  const c = org.contacts || {};
  [c.general_phone, c.general_email, c.website, c.intake_form_url].forEach((v) => {
    if (typeof v !== "string") return;
    (v.match(EMAIL_RE) || []).forEach((h) => published.add(h));
    (v.match(PHONE_RE) || []).forEach((h) => published.add(h.trim()));
  });
  staff.filter((s) => s.public_safe === true)
    .forEach((s) => contactDetailsOf(s).forEach((v) => published.add(v)));

  // (B) prose proximity
  const names = unsafe.map((s) => s.name).filter((n) => typeof n === "string" && n.trim().length);
  collectStrings(org).forEach((str) => {
    names.forEach((name) => {
      let from = 0, at;
      while ((at = str.indexOf(name, from)) !== -1) {
        const window = str.slice(at + name.length, at + name.length + NAME_WINDOW);
        [...(window.match(EMAIL_RE) || []), ...(window.match(PHONE_RE) || [])]
          .map((h) => h.trim())
          .forEach((h) => { if (!published.has(h)) secrets.add(h); });
        from = at + name.length;
      }
    });
  });

  // Longest first, so "704-638-9000 ext. 13904" is redacted before a shorter
  // overlapping value could chop it in half.
  return [...secrets].sort((a, b) => b.length - a.length);
}

/* =========================================================================
   Build
   ========================================================================= */

const counters = { notes: 0, working: 0, staff: 0 };
let redactedValues = 0;

const publicOrgs = orgs.map((o) => {
  const secrets = unsafeContactSecrets(o);
  const stripped = stripInternal(o, counters);
  if (!secrets.length) return stripped;

  const before = JSON.stringify(stripped);
  const redacted = redactStrings(stripped, secrets);
  const after = JSON.stringify(redacted);
  if (before !== after) {
    secrets.forEach((sec) => {
      const n = before.split(sec).length - 1;
      if (n) { redactedValues += n; console.log(`  redacted ${n}× in ${o.id}: a non-public contact detail`); }
    });
  }
  return redacted;
});

/* =========================================================================
   Safety net. This is the last gate before anything ships, so it is wide.

   NOTE — DRIFT: scripts/validate.mjs:127 carries its own copy of a DISTRESS
   regex, which is still the older, narrower literal. The two must agree; they
   are not to be maintained separately. Reconcile them into one shared module
   (a human decision — validate.mjs is out of scope for this pass).
   ========================================================================= */

const DISTRESS = new RegExp([
  "layoffs?", "laid off", "lay(?:ing)? off", "WARN (?:notice|filing|Act)",
  "furlough", "downsiz", "insolven", "bankrupt", "receivership", "going concern",
  "financial (?:distress|difficult|trouble)",
  "fiscal (?:crisis|distress)",
  "budget (?:cut|shortfall|crisis)", "budgetary deficit", "operating deficit",
  "funding (?:shortfall|cut|crisis|gap|risk)",
  "grant terminat", "terminat\\w+[^.]{0,60}grant", "grant[^.]{0,40}terminat\\w+",
  "reduction in force", "RIF\\b", "job cuts", "staff cuts",
  "cutting \\d+ (?:jobs|positions|staff)",
  "restructur", "refocusing resources",
  "closure risk", "shutting down", "at risk of clos",
  "leadership turmoil", "ousted", "forced out",
  "abruptly (?:resigned|departed|left)", "interim (?:CEO|executive director|president)"
].map((s) => "(?:" + s + ")").join("|"), "i");

const errors = [];

publicOrgs.forEach((o) => {
  const serialized = JSON.stringify(o);

  const hit = serialized.match(DISTRESS);
  if (hit) errors.push(`[${o.id}] would ship "${hit[0]}" — see CLAUDE.md rule 4`);

  // Recursive, not top-level: a nested internal_only_notes must fail too.
  (function scan(node, path) {
    if (Array.isArray(node)) return node.forEach((v, i) => scan(v, `${path}[${i}]`));
    if (!isPlainObject(node)) return;
    Object.keys(node).forEach((k) => {
      if (k === "internal_only_notes") errors.push(`[${o.id}] still has internal_only_notes at ${path}`);
      if (k.startsWith("_")) errors.push(`[${o.id}] still has working key "${k}" at ${path}`);
      scan(node[k], `${path}.${k}`);
    });
  })(o, "");

  collectNamedStaff(o).forEach((s) => {
    if (s.public_safe !== true) errors.push(`[${o.id}] would ship non-public contact "${s.name}"`);
  });
});

// Positive cross-check: no non-public staff email or phone may survive ANYWHERE
// in the public output, including prose. This is the check that was missing.
orgs.forEach((src, i) => {
  const serialized = JSON.stringify(publicOrgs[i]);
  collectNamedStaff(src)
    .filter((s) => s.public_safe !== true)
    .forEach((s) => {
      contactDetailsOf(s).forEach((v) => {
        if (serialized.includes(v)) {
          errors.push(`[${src.id}] leaks a contact detail for "${s.name}", who is not public_safe`);
        }
      });
    });
});

if (errors.length) {
  errors.forEach((e) => console.error(`  FAIL  ${e}`));
  console.error(`\n${errors.length} error(s). Nothing written.\n`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, JSON.stringify(publicOrgs, null, 2) + "\n");

console.log(`\n  ${OUT} written — ${publicOrgs.length} organizations`);
console.log(
  `  stripped ${counters.notes} internal note(s), ${counters.staff} non-public contact(s)` +
  `${counters.working ? `, ${counters.working} working key(s)` : ""}` +
  `; redacted ${redactedValues} contact detail(s) from prose\n`
);
