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
    // Same geography ordering as the public site: both use the engine's rules.
    geoRank: engine.geoRank(geography),
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

export function canonicalUrl(orgId) {
  return `${PUBLIC_SITE}/#org-${encodeURIComponent(orgId)}`;
}

export const ROOT_DIR = ROOT;
