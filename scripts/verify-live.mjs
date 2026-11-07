#!/usr/bin/env node
// verify-live: waits until the live site reports the expected commit and its
// data hashes match data/corpus.lock.json, and that it isn't running on
// temporary storage.
//
//   node scripts/verify-live.mjs https://vision360.agenticarc.ai [commit] [--allow-local]
import { readFileSync } from "node:fs";

const [site = "https://vision360.agenticarc.ai", want = ""] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const allowLocal = process.argv.includes("--allow-local");
const lock = JSON.parse(readFileSync(new URL("../data/corpus.lock.json", import.meta.url), "utf8"));
const deadline = Date.now() + 10 * 60 * 1000;

async function health() {
  const r = await fetch(site.replace(/\/$/, "") + "/api/health", { headers: { "cache-control": "no-cache" } });
  if (!r.ok) throw new Error("health returned " + r.status);
  return r.json();
}

let h = null;
for (;;) {
  try { h = await health(); } catch (e) { h = null; }
  if (h && (!want || String(h.commit).startsWith(want) || want.startsWith(String(h.commit)))) break;
  if (Date.now() > deadline) { console.error(`Live site still reports ${h ? h.commit : "nothing"}, expected ${want}.`); process.exit(1); }
  await new Promise((r) => setTimeout(r, 15000));
}

const problems = [];
const NAMES = { organizations: "site/data/organizations.json", assessment: "site/data/assessment.json", geography: "site/data/geography.json", engine: "site/quiz-engine.js" };
for (const [name, file] of Object.entries(NAMES)) {
  const live = h.hashes && h.hashes[name], locked = lock.files && lock.files[file];
  if (live && locked && live !== locked) problems.push(`${file}: live ${live.slice(0, 12)} vs lock ${locked.slice(0, 12)}`);
}
if (!allowLocal && h.stores && (h.stores.sessions !== "supabase" || h.stores.adminData !== "supabase")) problems.push(`storage is not durable: ${JSON.stringify(h.stores)} (FC16)`);
if (problems.length) { console.error("verify-live failed:\n  - " + problems.join("\n  - ")); process.exit(1); }
console.log(`Live at ${site}: commit ${h.commit}, data matches the lock, storage ${JSON.stringify(h.stores)}.`);
