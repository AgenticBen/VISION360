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
import { checkFlow } from "./flow-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILES = {
  organizations: "site/data/organizations.json",
  assessment: "site/data/assessment.json",
  geography: "site/data/geography.json",
  engine: "site/quiz-engine.js",
};

export const PUBLIC_SITE = "https://vision360.agenticarc.ai";
export const REGISTRY_FILE = "site/data/flows/index.json";

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

  const questionById = new Map(assessment.questions.map((q) => [q.id, q]));
  const flows = loadFlows({ organizations, assessment, questionById });

  cached = Object.freeze({
    flows,
    organizations,
    assessment,
    geography,
    engine,
    byId,
    hashes: Object.freeze(hashes),
    version,
    // Same geography ordering as the public site: both use the engine's rules.
    geoRank: engine.geoRank(geography),
    questionById,
  });
  return cached;
}

// Every published workflow the assistant can run, from the registry. The
// referral flow reuses the same frozen assessment object, so its code path and
// corpus version are unchanged. A workflow that fails its checks is skipped.
function loadFlows({ organizations, assessment, questionById }) {
  const out = new Map();
  let reg = { flows: [] };
  try { reg = JSON.parse(readFileSync(path.join(ROOT, REGISTRY_FILE), "utf8")); } catch {}
  for (const m of reg.flows || []) {
    if (m.status && m.status !== "published") continue;
    try {
      const bytes = readFileSync(path.join(ROOT, m.file));
      const hash = sha(bytes).slice(0, 12);
      const flow = m.file === FILES.assessment ? assessment : deepFreeze(JSON.parse(bytes));
      if (flow !== assessment) {
        const c = checkFlow(flow, { organizations, routing: !!m.routing });
        if (!c.ok) { console.error(`workflow ${m.id} skipped: ${c.errors.map((e) => e.message).join("; ")}`); continue; }
      }
      out.set(m.id, Object.freeze({
        id: m.id, title: m.title, description: m.description || "", routing: !!m.routing, file: m.file, flow, hash,
        version: `v${flow.version || 1}@${hash}`,
        questionById: flow === assessment ? questionById : new Map(flow.questions.map((q) => [q.id, q])),
      }));
    } catch (e) { console.error(`workflow ${m.id} skipped: ${e.message}`); }
  }
  return out;
}

export function flowMeta(corpus, id) {
  return (corpus.flows && corpus.flows.get(id)) || null;
}

// The corpus as seen by one conversation: the same data with that workflow's
// questions. Referral returns the corpus itself.
const views = new WeakMap();
export function corpusView(corpus, flowId) {
  const id = flowId || "referral";
  const F = flowMeta(corpus, id);
  if (!F) return null;
  if (F.flow === corpus.assessment) return corpus;
  let byId = views.get(corpus);
  if (!byId) { byId = new Map(); views.set(corpus, byId); }
  if (!byId.has(id)) byId.set(id, Object.freeze({ ...corpus, assessment: F.flow, questionById: F.questionById, flow: F }));
  return byId.get(id);
}

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

export function canonicalUrl(orgId) {
  return `${PUBLIC_SITE}/directory/#org-${encodeURIComponent(orgId)}`;
}

export const ROOT_DIR = ROOT;
