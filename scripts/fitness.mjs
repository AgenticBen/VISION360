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
    id: "FC1",
    title: "The conversation reads per-question words (recap labels, short names, intros, aliases, topics) from the workflow data, not code tables",
    run: () => findAll(["dialogue.mjs", "phrasing.mjs", "understand.mjs"].map((f) => path.join("server", "lib", f)), [
      /\b(RECAP_LABEL|SHORT|SECTION|NO_CONCERN|EXTRA_ALIASES|TOPICS)\s*=\s*\{/,
      /screenLabel\(\s*a\.questionId/,
      /\|\|\s*a\.questionId\s*\)/,
    ]),
  },
  {
    id: "FC2",
    title: "The browser never talks to Supabase or holds a server key",
    run: () => findAll(sourceFiles(["site"]), [/supabase\.co\b/i, /sb_secret_|service_role|@supabase\/supabase-js/, /\bghp_|github_pat_/]),
  },
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
        "publish_draft", "revert_to_version", "list_requests", "comment_on_request", "set_request_status", "log_change",
        "create_workflow", "delete_workflow", "add_section", "update_section", "set_main_workflow", "get_share_links", "list_conversations", "list_feedback",
        "get_dashboard",
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
  {
    id: "FC10",
    title: "A Vercel Cron runs the scheduled work (due emails, retention purge)",
    run: () => {
      const v = JSON.parse(readFileSync("vercel.json", "utf8"));
      const ok = (v.crons || []).some((c) => c.path === "/api/cron/tick");
      return ok ? [] : ["vercel.json has no cron for /api/cron/tick"];
    },
  },
  {
    id: "FC13",
    title: "Published versions reach main only through the publish workflow, after npm run verify",
    run: () => {
      const y = readFileSync(path.join(".github", "workflows", "publish.yml"), "utf8");
      const problems = [];
      const v = y.indexOf("npm run verify"), m = y.indexOf("gh pr merge");
      if (v < 0 || m < 0 || v > m) problems.push("publish.yml must run npm run verify before gh pr merge");
      if (!/verify-live\.mjs/.test(y)) problems.push("publish.yml doesn't run verify-live after merging");
      const repo = readFileSync(path.join("server", "lib", "flow-repo.mjs"), "utf8");
      if (!/gh\.proposeToMain/.test(repo)) problems.push("flow-repo doesn't publish through proposeToMain");
      return problems;
    },
  },
  {
    id: "FC12",
    title: "Every admin write checks the Origin, and publish/revert check the publish key",
    run: () => {
      const src = readFileSync(path.join("server", "lib", "api.mjs"), "utf8");
      const problems = [];
      const block = (start) => { const i = src.indexOf(start); return i < 0 ? "" : src.slice(i, i + 1800); };
      for (const [label, start] of [["requests", 'p === "/api/requests" || p.startsWith'], ["workflows", 'p === "/api/flows" || p.startsWith'], ["staff status", 'm[2] === "status" && method === "POST"'], ["action retry", "staff\\/actions"], ["site settings", 'p === "/api/admin/settings"'], ["delete conversations", 'p === "/api/admin/conversations/delete"'], ["password change", 'p === "/api/admin/password"'], ["sign-in", 'p === "/api/admin/login"']]) {
        if (!/requireSameSite\(req\)/.test(block(start))) problems.push(`${label} writes don't call requireSameSite`);
      }
      if (!/requirePublishKey\(req\);[\s\S]{0,500}flows\.publish/.test(src)) problems.push("publish/revert don't call requirePublishKey before flows.publish");
      return problems;
    },
  },
  {
    id: "FC14",
    title: "With GitHub connected and no connector key, publishing and connector writes are off",
    run: async () => {
      const { accessRules } = await import("../server/lib/api.mjs");
      const a = accessRules({}, { kind: "github" });
      const problems = [];
      if (a.writesAllowed || a.publishAllowed || a.publishing !== "off") problems.push("GitHub without V360_MCP_KEY still allows writes or publishing");
      return problems;
    },
  },
  {
    id: "FC15",
    title: "Every What's new tour target exists on the site (an element id or a data-tour key)",
    run: () => {
      const tour = readFileSync(path.join("site", "whats-new.js"), "utf8");
      const files = [];
      const walk = (d) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) { if (p !== path.join("site", "data") && n !== "fonts" && n !== "brand") walk(p); } else if (/\.(html|m?js)$/.test(n) && p !== path.join("site", "whats-new.js")) files.push(readFileSync(p, "utf8")); } };
      walk("site"); walk("admin");
      const all = files.join("\n");
      const problems = [];
      for (const [, t] of tour.matchAll(/target:\s*"([^"]+)"/g)) {
        const id = (t.match(/^#([\w-]+)/) || [])[1];
        if (id) {
          if (!new RegExp(`id(=|:\\s*)["']${id}["']|["']id["'],\\s*["']${id}["']`).test(all)) problems.push(`target ${t}: no element with id "${id}"`);
        } else if (/^[\w-]+$/.test(t)) {
          if (!new RegExp(`data-tour(=|["']?:\\s*|["'],\\s*)["']${t}["']`).test(all)) problems.push(`target "${t}": no data-tour="${t}"`);
        }
      }
      return problems;
    },
  },
  {
    id: "FC17",
    title: "Admin pages are served only by the server (none under site/), and every conversation runs its own workflow",
    run: () => {
      const problems = [];
      const walk = (d, out = []) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p, out); else out.push(p); } return out; };
      for (const f of walk("site")) if (f.startsWith(path.join("site", "admin") + path.sep)) problems.push(`${f} is a public static file; admin pages belong in admin/`);
      const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
      if (!(vercel.rewrites || []).some((r) => r.source === "/admin/:path*" && r.destination.startsWith("/api/v360"))) problems.push("vercel.json doesn't route /admin/* through the function");
      const dialogue = readFileSync(path.join("server", "lib", "dialogue.mjs"), "utf8");
      if (/const \{ corpus \} = ctx/.test(dialogue)) problems.push("dialogue.mjs reads one fixed corpus; each conversation must use C(session)");
      const api = readFileSync(path.join("server", "lib", "api.mjs"), "utf8");
      if (!/flowForStart\(body\.flow[,)][\s\S]{0,300}turns\.start/.test(api)) problems.push("POST /api/session must check the workflow (flowForStart) before starting");
      if (!/confirm !== "DELETE"/.test(api)) problems.push("deleting conversations must require the word DELETE on the server");
      return problems;
    },
  },
  {
    id: "FC18",
    title: "Screen-check results stay private: locked-down tables, off by default, never named by the browser, one display-settings layer, one set of spoken commands",
    run: () => {
      const problems = [];
      const walk = (d, out = []) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p, out); else out.push(p); } return out; };
      const migs = walk(path.join("supabase", "migrations")).filter((f) => f.endsWith(".sql")).map((f) => readFileSync(f, "utf8")).join("\n");
      const TABLES = ["screen_checks", "screen_check_steps", "screen_check_reviews"];
      for (const t of TABLES) {
        if (!new RegExp(`create table if not exists public\\.${t}\\b`).test(migs)) problems.push(`no migration creates ${t}`);
      }
      const lock = migs.match(/foreach t in array array\[([^\]]*screen_checks[^\]]*)\][\s\S]{0,300}enable row level security[\s\S]{0,200}revoke all[\s\S]{0,40}from anon, authenticated/);
      if (!lock) problems.push("the screen-check tables must have row-level security on and no anon/authenticated access");
      else for (const t of TABLES) if (!lock[1].includes(`'${t}'`)) problems.push(`${t} isn't in the lock-down list`);
      if (/grant[^;]*screen_check[^;]*to\s+(anon|authenticated)/i.test(migs)) problems.push("a screen-check table is granted to anon or authenticated");
      const settings = readFileSync(path.join("server", "lib", "site-settings.mjs"), "utf8");
      if (!/features: Object\.freeze\(\{ screenCheck: false[ ,]/.test(settings)) problems.push("the screen check must be off by default (SITE_DEFAULTS.features.screenCheck = false)");
      for (const f of walk("site")) {
        if (!/\.(js|html|json|css)$/.test(f)) continue;
        if (/screen_check(s|_steps|_reviews)\b/.test(readFileSync(f, "utf8"))) problems.push(`${f} names a screen-check table; results never reach the browser directly`);
      }
      // One display-settings layer: no page keeps its own text size or colors.
      for (const f of walk("site").filter((x) => /\.(js|html)$/.test(x) && !x.endsWith("display-settings.js"))) {
        if (/localStorage\.(get|set)Item\(\s*["']vrd-display-v1/.test(readFileSync(f, "utf8"))) problems.push(`${f} still reads or writes the old directory display settings; use display-settings.js`);
      }
      for (const f of ["site/index.html", "site/directory/index.html", "site/guide.html", "site/demo/index.html", "site/screen-check/index.html"]) {
        if (!/<script src="\/display-settings\.js"[^>]*data-legacy="(assistant|directory)"/.test(readFileSync(f, "utf8"))) problems.push(`${f} doesn't load the shared display settings (with data-legacy)`);
      }
      // One set of spoken commands: the assessment loads the shared parser
      // and doesn't keep its own copy of "bigger", "blue background" and so on.
      const assess = readFileSync(path.join("site", "screen-check", "index.html"), "utf8");
      if (!/<script src="\/voice-commands\.js"><\/script>/.test(assess)) problems.push("site/screen-check/index.html doesn't load the shared voice commands (voice-commands.js)");
      return problems;
    },
  },
  {
    id: "FC19",
    title: "Every workflow sits in one Workflows row (a site menu item): Resource Assistant or Vision Assessment, and only the Resource Assistant row ranks services",
    run: () => {
      const problems = [];
      const reg = JSON.parse(readFileSync(path.join("site", "data", "flows", "index.json"), "utf8"));
      for (const f of reg.flows || []) {
        if (!["assistant", "assessment"].includes(f.group)) problems.push(`workflow ${f.id} has no row: set "group" to "assistant" or "assessment" in site/data/flows/index.json`);
        if (f.group === "assessment" && f.routing) problems.push(`workflow ${f.id} ranks services, so it belongs in the Resource Assistant row`);
      }
      if (!(reg.flows || []).some((f) => f.group === "assistant" && f.routing && (!f.status || f.status === "published"))) problems.push("the Resource Assistant row needs a published workflow that suggests services");
      if (!(reg.flows || []).some((f) => f.group === "assessment" && !f.routing && (!f.status || f.status === "published"))) problems.push("the Vision Assessment row needs a published question-and-answer workflow");
      return problems;
    },
  },
  {
    id: "FC20",
    title: "Contacting organizations for people is off by default, stays a pure conversation step, and never says someone qualifies",
    run: () => {
      const problems = [];
      const settings = readFileSync(path.join("server", "lib", "site-settings.mjs"), "utf8");
      if (!/orgOutreach: false/.test(settings)) problems.push("contacting organizations must be off by default (SITE_DEFAULTS.features.orgOutreach = false)");
      problems.push(...findAll([path.join("server", "lib", "dialogue-outreach.mjs")], [
        /from\s+["']\.\/(store|actions|ai-understanding|tts|session-repo|api|outreach-directory)\.mjs["']/,
        /from\s+["']node:(sqlite|fs|http|https)["']/,
        /\bstore\./,
        /\bfetch\(/,
      ]));
      const mail = readFileSync(path.join("server", "lib", "outreach-mail.mjs"), "utf8").replace(/^\s*\/\/.*$/gm, "");
      if (/qualif/i.test(mail)) problems.push("server/lib/outreach-mail.mjs says someone qualifies; say they may be eligible");
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
