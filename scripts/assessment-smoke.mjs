#!/usr/bin/env node
// Runs synthetic answer sets through site/quiz-engine.js and asserts what comes
// back. No browser, no DOM.
//
// This is also the artifact the VOICE AGENT team runs: if the phone agent and
// this file disagree about what a given set of answers should produce, one of
// them has drifted from site/data/assessment.json and this is how you find out.
//
// Zero dependencies. Run: node scripts/assessment-smoke.mjs

import { readFileSync, existsSync } from "node:fs";

const ASSESSMENT = "site/data/assessment.json";
const ORGS = "site/data/organizations.json";

if (!existsSync(ASSESSMENT)) {
  console.error(`SKIP: ${ASSESSMENT} does not exist yet.`);
  process.exit(0);
}

await import("../site/quiz-engine.js");
const E = globalThis.VisionAssessment;
if (!E) { console.error("FAIL: quiz-engine.js did not attach VisionAssessment."); process.exit(1); }

const assessment = JSON.parse(readFileSync(ASSESSMENT, "utf8"));
const orgs = JSON.parse(readFileSync(ORGS, "utf8"));
const byId = new Map(orgs.map((o) => [o.id, o]));

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); failures++; }
};

/* ---- structural invariants -------------------------------------------- */
console.log("\nStructure");

const qIds = new Set(assessment.questions.map((q) => q.id));
const blockQs = assessment.blocks.flatMap((b) => b.questions);
check("every block question exists", blockQs.every((id) => qIds.has(id)),
  blockQs.filter((id) => !qIds.has(id)).join(", "));
check("every question is in exactly one block",
  assessment.questions.every((q) => blockQs.filter((id) => id === q.id).length === 1));

const effects = assessment.questions.flatMap((q) =>
  (q.options || []).flatMap((o) => o.effects || []));
check("every org effect points at a real record",
  effects.filter((e) => e.target === "org").every((e) => byId.has(e.id)),
  effects.filter((e) => e.target === "org" && !byId.has(e.id)).map((e) => e.id).join(", "));

/* The provenance rule. Every recommendation must trace to a branch condition a
   human verified in Phase 2 — CLAUDE.md rule 3, made mechanical. */
const conditions = new Set();
orgs.forEach((o) => (o.access_path || []).forEach((s) =>
  (s.branches || []).forEach((b) => { if (b.condition) conditions.add(b.condition); })));
const unsourced = effects.filter((e) => !e.evidence || !conditions.has(e.evidence.branch_condition));
check(`all ${effects.length} effects trace to a verified branch condition`,
  unsourced.length === 0,
  unsourced.slice(0, 3).map((e) => `"${e.evidence?.branch_condition ?? "(none)"}"`).join(" | "));

check("every handoff destination is a real record",
  (assessment.handoffs || []).every((h) => (h.refer_to || []).every((id) => byId.has(id))));

/* ---- behavioural cases ------------------------------------------------- */
console.log("\nBehaviour");

function run(answers, skipBlocks = []) {
  const s = E.create(assessment);
  skipBlocks.forEach((b) => E.skipBlock(s, b, true));
  for (const [q, v] of Object.entries(answers)) E.answer(s, q, v);
  return { state: s, ranked: E.score(s, orgs, null), handoffs: E.handoffs(s) };
}

const first = E.nextQuestion(E.create(assessment));
check("there is a first question", !!first, "assessment produced none");

// Nothing answered: no ranking signal, and still every record present.
const empty = run({});
check("no answers ranks nothing above zero", empty.ranked.every((r) => r.points === 0));
check("no answers still ranks all 96", empty.ranked.length === orgs.length);

// A veteran should surface VA routes.
const vet = run({ veteran: "yes" });
const vetTop = vet.ranked.slice(0, 5).map((r) => r.id);
check("veteran routes to a VA record", vetTop.some((id) => id.startsWith("va-")),
  `top 5 were ${vetTop.join(", ")}`);

// Suppression must never remove anything.
check("every case keeps all records ranked",
  [empty, vet].every((c) => c.ranked.length === orgs.length));

// Honest hand-offs fire and carry no score.
const housing = run({ housing_stable: "no" });
const housingHandoff = housing.handoffs.map((h) => h.id);
if ((assessment.handoffs || []).some((h) => h.id === "housing")) {
  check("housing answer triggers the hand-off", housingHandoff.includes("housing"),
    `fired: ${housingHandoff.join(", ") || "(none)"}`);
}

// Reversing an answer must discard anything it had unlocked.
const flip = E.create(assessment);
E.answer(flip, "veteran", "yes");
const conditional = assessment.questions.find(
  (q) => q.ask_if && JSON.stringify(q.ask_if).includes("veteran"));
if (conditional) {
  E.answer(flip, conditional.id, (conditional.options[0] || {}).value);
  E.answer(flip, "veteran", "no");
  check("reversing an answer discards what it unlocked",
    !Object.prototype.hasOwnProperty.call(flip.answers, conditional.id));
}

/* ---- reachability ------------------------------------------------------ */
console.log("\nReach");
const reachable = new Set();
effects.forEach((e) => {
  if (e.target === "org") reachable.add(e.id);
  else orgs.forEach((o) => { if ((o.categories || []).includes(e.id)) reachable.add(o.id); });
});
console.log(`  ${reachable.size} of ${orgs.length} organizations are reachable by at least one answer`);
const unreachable = orgs.filter((o) => !reachable.has(o.id)).map((o) => o.id);
if (unreachable.length) {
  console.log(`  ${unreachable.length} reachable only through the directory:`);
  console.log(`    ${unreachable.slice(0, 12).join(", ")}${unreachable.length > 12 ? " …" : ""}`);
}

console.log(failures ? `\n${failures} failure(s).\n` : "\nAll checks passed.\n");
process.exit(failures ? 1 : 0);
