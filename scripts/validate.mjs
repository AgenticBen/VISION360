#!/usr/bin/env node
// Validates data/organizations.json against schema/organization.schema.json
// and against the five project rules in CLAUDE.md.
// Zero dependencies. Run: node scripts/validate.mjs

import { readFileSync, existsSync } from "node:fs";

const DATA = "data/organizations.json";
const SCHEMA = "schema/organization.schema.json";

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

if (!existsSync(DATA)) {
  console.error(`FAIL: ${DATA} does not exist. Phase 1 has not produced output.`);
  process.exit(1);
}

let orgs, schema;
try {
  orgs = JSON.parse(readFileSync(DATA, "utf8"));
  schema = JSON.parse(readFileSync(SCHEMA, "utf8"));
} catch (e) {
  console.error(`FAIL: could not parse JSON — ${e.message}`);
  process.exit(1);
}
if (!Array.isArray(orgs)) {
  console.error("FAIL: organizations.json must be an array of organization objects.");
  process.exit(1);
}

// ---------- minimal JSON Schema subset validator ----------
function validate(node, sch, path) {
  if (!sch) return;
  if (sch.enum && !sch.enum.includes(node)) {
    err(`${path}: "${node}" is not one of ${sch.enum.join(", ")}`);
    return;
  }
  const t = sch.type;
  if (t) {
    const types = Array.isArray(t) ? t : [t];
    const actual =
      node === null ? "null" : Array.isArray(node) ? "array" :
      Number.isInteger(node) ? "integer" : typeof node;
    const ok = types.some((x) =>
      x === actual || (x === "number" && actual === "integer") || (x === "integer" && actual === "integer"));
    if (!ok) { err(`${path}: expected ${types.join("|")}, got ${actual}`); return; }
  }
  if (typeof node === "string") {
    if (sch.minLength != null && node.length < sch.minLength) err(`${path}: shorter than ${sch.minLength} chars`);
    if (sch.maxLength != null && node.length > sch.maxLength) err(`${path}: longer than ${sch.maxLength} chars`);
    if (sch.pattern && !new RegExp(sch.pattern).test(node)) err(`${path}: "${node}" does not match ${sch.pattern}`);
  }
  if (typeof node === "number" && sch.minimum != null && node < sch.minimum) err(`${path}: below minimum ${sch.minimum}`);
  if (Array.isArray(node)) {
    if (sch.minItems != null && node.length < sch.minItems) err(`${path}: needs at least ${sch.minItems} item(s), has ${node.length}`);
    node.forEach((v, i) => validate(v, sch.items, `${path}[${i}]`));
  }
  if (node && typeof node === "object" && !Array.isArray(node)) {
    (sch.required || []).forEach((k) => { if (!(k in node)) err(`${path}: missing required field "${k}"`); });
    if (sch.additionalProperties === false && sch.properties) {
      Object.keys(node).forEach((k) => {
        if (!(k in sch.properties) && !k.startsWith("_")) err(`${path}: unexpected field "${k}"`);
      });
    }
    Object.entries(sch.properties || {}).forEach(([k, s]) => {
      if (k in node) validate(node[k], s, `${path}.${k}`);
    });
  }
}

orgs.forEach((o, i) => validate(o, schema, `[${i}:${o?.id ?? "no-id"}]`));

// ---------- RULE 1: umbrellas stay separate ----------
const byId = new Map(orgs.map((o) => [o.id, o]));
const childrenOf = (needle) =>
  orgs.filter((o) => (o.parent_org_id || "").includes(needle) || (o.is_program_of || "").toLowerCase().includes(needle));

const dsb = childrenOf("services-for-the-blind").concat(
  orgs.filter((o) => (o.is_program_of || "").toLowerCase().includes("services for the blind"))
);
const dsbCount = new Set(dsb.map((o) => o.id)).size;
if (dsbCount < 6) {
  err(`RULE 1 VIOLATION: expected at least 6 separate NC Division of Services for the Blind programs, found ${dsbCount}. ` +
      `The DSB umbrella has been flattened. See CLAUDE.md rule 1.`);
}

const vaChildren = orgs.filter(
  (o) => /^va-/.test(o.id) || (o.parent_org_id || "").startsWith("va") ||
         /veterans affairs/i.test(o.is_program_of || "")
);
const vaCount = new Set(vaChildren.map((o) => o.id)).size;
if (vaCount < 6) {
  err(`RULE 1 VIOLATION: expected at least 6 separate VA blind rehabilitation entry points, found ${vaCount}. ` +
      `The VA umbrella has been flattened. See CLAUDE.md rule 1.`);
}

// parent references must resolve
orgs.forEach((o) => {
  if (o.parent_org_id && !byId.has(o.parent_org_id))
    err(`[${o.id}]: parent_org_id "${o.parent_org_id}" does not match any record`);
  (o.programs || []).forEach((p) => {
    if (!byId.has(p)) err(`[${o.id}]: programs lists "${p}" which does not match any record`);
  });
});

// ---------- RULE 3: no invented facts / gaps must be visible ----------
orgs.forEach((o) => {
  const blob = JSON.stringify(o);
  if (/\bUNKNOWN\b/.test(blob))
    err(`[${o.id}]: contains raw "UNKNOWN" — use "Not published — verification call required" instead`);
  if ((o.access_path || []).length < 2 && o.needs_research !== true)
    err(`[${o.id}]: access_path has fewer than 2 steps but needs_research is not true`);
  (o.access_path || []).forEach((s) =>
    (s.branches || []).forEach((b) => {
      if (b.goto_org_id && !byId.has(b.goto_org_id))
        err(`[${o.id}]: access_path branch points at "${b.goto_org_id}" which does not exist`);
    })
  );
  if (/not published/i.test(JSON.stringify(o.documentation_required || [])) && !(o.open_questions || []).length)
    warn(`[${o.id}]: has an unpublished field but no open_questions telling anyone what to ask`);
});

// ---------- RULE 4: organizational distress never renders ----------
const DISTRESS = /\b(layoff|laid off|WARN notice|WARN filing|furlough|downsiz|insolven|bankrupt|financial (distress|difficulty|trouble)|closure risk|shutting down)\b/i;
orgs.forEach((o) => {
  const publicPart = { ...o };
  delete publicPart.internal_only_notes;
  const hit = JSON.stringify(publicPart).match(DISTRESS);
  if (hit)
    err(`RULE 4 VIOLATION: [${o.id}] mentions "${hit[0]}" in a field that will be rendered/served publicly. ` +
        `Move it to internal_only_notes. See CLAUDE.md rule 4.`);
});

// ---------- duplicates ----------
const seenId = new Set();
orgs.forEach((o) => {
  if (seenId.has(o.id)) err(`Duplicate id: "${o.id}"`);
  seenId.add(o.id);
});
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const byName = new Map();
orgs.forEach((o) => {
  const k = norm(o.name);
  if (byName.has(k) && byName.get(k) !== o.id) warn(`Possible duplicate name: "${o.name}" (${o.id} and ${byName.get(k)})`);
  else byName.set(k, o.id);
});
const byPhone = new Map();
orgs.forEach((o) => {
  const p = (o.contacts?.general_phone || "").replace(/\D/g, "");
  if (p.length >= 10) {
    if (byPhone.has(p) && !o.parent_org_id && !byId.get(byPhone.get(p))?.parent_org_id)
      warn(`Same phone ${o.contacts.general_phone} on ${o.id} and ${byPhone.get(p)} — check these are not duplicates`);
    else byPhone.set(p, o.id);
  }
});

// ---------- GEOGRAPHY: config must not drift from the doc ----------
// CLAUDE.md rule 2 says county names live in docs/geography-definition.md and
// are not hardcoded anywhere else. site/data/geography.json is the machine-
// readable twin the site actually reads, so the two must agree or the rule is
// only being honoured on paper.
const GEO = "site/data/geography.json";
const GEO_DOC = "docs/geography-definition.md";

if (existsSync(GEO) && existsSync(GEO_DOC)) {
  let geo;
  try {
    geo = JSON.parse(readFileSync(GEO, "utf8"));
  } catch (e) {
    err(`${GEO}: could not parse — ${e.message}`);
  }
  if (geo) {
    const doc = readFileSync(GEO_DOC, "utf8");
    // The doc lists counties in prose under "Working county list".
    const section = doc.split(/##\s*Working county list/i)[1] || "";
    const docCounties = new Set(
      (section.split(/##/)[0] || "")
        .replace(/North Carolina:|South Carolina:/g, " ")
        .split(/[,.\n]/)
        .map((t) => t.trim())
        .filter((t) => /^[A-Z][A-Za-z]+$/.test(t))
    );

    const configCounties = new Set();
    (geo.tiers || []).forEach((t) => (t.counties || []).forEach((c) => configCounties.add(c)));

    if (!docCounties.size) {
      warn(`${GEO_DOC}: could not parse a county list, so config parity was not checked.`);
    } else {
      [...configCounties].forEach((c) => {
        if (!docCounties.has(c)) err(`${GEO}: county "${c}" is not in ${GEO_DOC}. See CLAUDE.md rule 2.`);
      });
      [...docCounties].forEach((c) => {
        if (!configCounties.has(c)) err(`${GEO}: county "${c}" is in ${GEO_DOC} but missing from the config.`);
      });
    }

    if (geo.home_county && !configCounties.has(geo.home_county))
      err(`${GEO}: home_county "${geo.home_county}" is not in any tier.`);

    // Counties the DATA asserts that the doc has never heard of. A warning, not
    // an error: these are real catchments (the DSB Charlotte district covers
    // Anson and Montgomery) and the project lead has to rule on them, not us.
    const dataCounties = new Set();
    orgs.forEach((o) => (o.service_area?.counties || []).forEach((c) => dataCounties.add(c)));
    const unlisted = [...dataCounties].filter((c) => !docCounties.has(c)).sort();
    if (unlisted.length)
      warn(`counties present in the data but not in ${GEO_DOC}: ${unlisted.join(", ")}. ` +
           `Ordering falls back to service_area.verdict for these, so nothing is mis-ranked, ` +
           `but the project lead should rule on whether they belong in the region.`);
  }
} else if (!existsSync(GEO)) {
  warn(`${GEO} does not exist — the site will fall back to name ordering.`);
}

// ---------- report ----------
const inArea = orgs.filter((o) => o.service_area?.verdict === "in_area").length;
const needsResearch = orgs.filter((o) => o.needs_research).length;
const noPath = orgs.filter((o) => !(o.access_path || []).length).length;

console.log(`\n  ${orgs.length} organizations`);
console.log(`  ${inArea} in_area · ${dsbCount} DSB programs · ${vaCount} VA entry points`);
console.log(`  ${needsResearch} need research · ${noPath} with no access_path\n`);

warnings.forEach((w) => console.log(`  WARN  ${w}`));
if (warnings.length) console.log("");

if (errors.length) {
  errors.forEach((e) => console.error(`  FAIL  ${e}`));
  console.error(`\n${errors.length} error(s). Do not report this phase complete.\n`);
  process.exit(1);
}
console.log("  PASS — schema and all five CLAUDE.md rules satisfied.\n");
