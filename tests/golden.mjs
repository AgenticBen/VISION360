// Golden routing: fixed sample people with fixed answers, and the services the
// current rules recommend for them. Used by tests/golden-routing.test.mjs and
// regenerated (after a reviewed routing change) by scripts/golden-update.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { loadCorpus } from "../server/lib/corpus.mjs";
import { routeWith } from "../server/lib/golden-route.mjs";

export const FIXTURE = new URL("./fixtures/golden-personas.json", import.meta.url);

export function readFixture() {
  return JSON.parse(readFileSync(FIXTURE, "utf8"));
}

export function writeFixture(data) {
  writeFileSync(FIXTURE, JSON.stringify(data, null, 2) + "\n");
}

export async function route(persona) {
  const corpus = await loadCorpus();
  return routeWith(corpus, corpus.assessment, persona);
}

// A readable explanation of how routing moved, for test failures.
export function describeDiff(name, expected, actual) {
  const lines = [`Routing changed for "${name}".`, "", "  rank  expected                                   actual"];
  const n = Math.max(expected.matches.length, actual.matches.length);
  for (let i = 0; i < n; i++) {
    const e = expected.matches[i] || "-";
    const a = actual.matches[i] || "-";
    lines.push(`  ${String(i + 1).padStart(4)}  ${e.padEnd(42)} ${a}${e === a ? "" : "   <- changed"}`);
  }
  const added = actual.matches.filter((id) => !expected.matches.includes(id));
  const removed = expected.matches.filter((id) => !actual.matches.includes(id));
  if (added.length) lines.push("", "  now recommended: " + added.join(", "));
  if (removed.length) lines.push("  no longer recommended: " + removed.join(", "));
  if (JSON.stringify(expected.handoffs) !== JSON.stringify(actual.handoffs)) {
    lines.push("", `  handoffs: expected [${expected.handoffs.join(", ")}], now [${actual.handoffs.join(", ")}]`);
  }
  for (const d of actual.detail.filter((x) => added.includes(x.id))) lines.push(`  why ${d.id} (${d.points} pts): ${d.reason}`);
  lines.push("", "If this change is intended, run `node scripts/golden-update.mjs`, review the fixture diff, and commit it.");
  return lines.join("\n");
}
