// Read-only resource corpus for the demo server.
//
// Everything here is loaded from the same generated files the public site
// serves (site/data/*.json) and the same engine (site/quiz-engine.js). Nothing
// in this module writes to them. The corpus version is a hash of the exact
// bytes, so every recommendation can say which data and rules produced it.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILES = {
  organizations: "site/data/organizations.json",
  assessment: "site/data/assessment.json",
  geography: "site/data/geography.json",
  engine: "site/quiz-engine.js",
};

export const PUBLIC_SITE = "https://vision360.agenticarc.ai";

function sha(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

let cached = null;

export async function loadCorpus() {
  if (cached) return cached;
  const raw = {};
  const hashes = {};
  for (const [k, rel] of Object.entries(FILES)) {
    raw[k] = readFileSync(path.join(ROOT, rel));
    hashes[k] = sha(raw[k]);
  }
  await import(path.join(ROOT, FILES.engine));
  const engine = globalThis.VisionAssessment;
  if (!engine) throw new Error("quiz-engine.js did not attach VisionAssessment");

  const organizations = deepFreeze(JSON.parse(raw.organizations));
  const assessment = deepFreeze(JSON.parse(raw.assessment));
  const geography = deepFreeze(JSON.parse(raw.geography));
  const byId = new Map(organizations.map((o) => [o.id, o]));
  const version = "corpus-" + sha(Buffer.concat(Object.values(hashes).map((h) => Buffer.from(h)))).slice(0, 16);

  cached = Object.freeze({
    organizations,
    assessment,
    geography,
    engine,
    byId,
    hashes: Object.freeze(hashes),
    version,
    geoRank: makeGeoRank(geography),
    questionById: new Map(assessment.questions.map((q) => [q.id, q])),
  });
  return cached;
}

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// Port of geoTier()/geoRank() in site/app.js so the demo orders results the
// same way the public quiz does. Geography sorts; it never excludes.
const GEO_RANK = { home: 0, statewide: 1, adjacent: 2, region: 3, travel: 4, elsewhere: 5 };

function makeGeoRank(geo) {
  const tierCounties = (id) => (geo.tiers.find((t) => t.id === id) || {}).counties || [];
  const intersects = (a, b) => a.some((c) => b.includes(c));
  function tier(org) {
    const area = org.service_area || {};
    const counties = area.counties || [];
    const verdict = area.verdict;
    if (counties.includes(geo.home_county)) return "home";
    if (!counties.length && verdict === "in_area") return "statewide";
    if (counties.length && intersects(counties, tierCounties("adjacent"))) return "adjacent";
    if (counties.length && intersects(counties, tierCounties("region"))) return "region";
    if (verdict === "statewide_travel_required") return "travel";
    if (verdict === "in_area") return "statewide";
    return "elsewhere";
  }
  const rank = (org) => GEO_RANK[tier(org)];
  rank.tier = tier;
  return rank;
}

export function canonicalUrl(orgId) {
  return `${PUBLIC_SITE}/#org-${encodeURIComponent(orgId)}`;
}

export const ROOT_DIR = ROOT;
