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
  {
    id: "FC6",
    title: "The conversation core never touches storage, providers or HTTP, and no hidden AI fields remain",
    run: () => [
      ...findAll([path.join("server", "lib", "dialogue.mjs")], [
        /from\s+["']\.\/(store|actions|ai-understanding|tts|session-repo|api)\.mjs["']/,
        /from\s+["']node:(sqlite|fs|http|https)["']/,
        /\bstore\./,
        /\bfetch\(/,
      ]),
      ...findAll(sourceFiles(["server", "api"]), [/__ai/]),
    ],
  },
  {
    id: "FC7",
    title: "The MCP connector offers only the approved tools and reaches data only through workflows and requests",
    run: async () => {
      const APPROVED = [
        "list_workflows", "get_workflow", "list_versions", "get_draft", "update_draft", "add_question", "update_question",
        "delete_question", "move_question", "set_follow_up", "set_option", "set_effect", "find_organizations", "check_draft",
        "publish_draft", "revert_to_version", "list_requests", "comment_on_request", "set_request_status", "log_change", "get_dashboard",
      ];
      const { TOOL_NAMES } = await import("../server/lib/mcp.mjs");
      const problems = [];
      const extra = TOOL_NAMES.filter((n) => !APPROVED.includes(n));
      const missing = APPROVED.filter((n) => !TOOL_NAMES.includes(n));
      if (extra.length) problems.push("tools not on the approved list: " + extra.join(", "));
      if (missing.length) problems.push("approved tools missing: " + missing.join(", "));
      problems.push(...findAll([path.join("server", "lib", "mcp.mjs")], [
        /^\s*import\b/,
        /\b(store|gh)\.(read|write|commit|update|list)/,
        /\bfetch\(/,
      ]));
      return problems;
    },
  },
];

let failed = 0;
for (const check of CHECKS) {
  let problems;
  try {
    problems = await check.run();
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
