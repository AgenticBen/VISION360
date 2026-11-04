#!/usr/bin/env node
// Architecture fitness checks: rules about how the code is put together that
// tests don't cover (for example "only one place defines geography ranking").
// Each check returns a list of problems; an empty list is a pass.
//
//   npm run fitness
//
// Checks are added as the pilot plan lands. IDs (FC1, FC5, ...) match the
// target design in the private audits folder.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// Every .js/.mjs file under the given folders (generated data excluded).
function sourceFiles(dirs) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) { if (name !== "data" && name !== "node_modules") walk(p); }
      else if (/\.(m?js)$/.test(name)) out.push(p);
    }
  };
  dirs.forEach(walk);
  return out;
}

// Lines in `files` matching any pattern, as "file:line  text".
function findAll(files, patterns) {
  const hits = [];
  for (const f of files) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (patterns.some((re) => re.test(line))) hits.push(`${f}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
  return hits;
}

const ENGINE = path.join("site", "quiz-engine.js");

const CHECKS = [
  {
    id: "FC5",
    title: "Geography ranking and result selection are defined only in site/quiz-engine.js",
    run: () => findAll(
      sourceFiles(["site", "server", "api"]).filter((f) => f !== ENGINE),
      [/\bGEO_RANK\b/, /\btierCounties\b/, /\bmakeGeoRank\b/, /\b(MIN_POINTS|RELATIVE_FLOOR|MAX_RESULTS|minPoints|relativeFloor)\b/],
    ),
  },
];

let failed = 0;
for (const check of CHECKS) {
  let problems;
  try {
    problems = check.run();
  } catch (e) {
    problems = [`check crashed: ${e.message}`];
  }
  if (problems.length) {
    failed++;
    console.error(`  FAIL  ${check.id}  ${check.title}`);
    for (const p of problems) console.error(`        - ${p}`);
  } else {
    console.log(`  PASS  ${check.id}  ${check.title}`);
  }
}

if (!CHECKS.length) console.log("  No fitness checks defined yet.");
if (failed) {
  console.error(`\n${failed} fitness check(s) failed.\n`);
  process.exit(1);
}
console.log("\nFitness checks passed.\n");
