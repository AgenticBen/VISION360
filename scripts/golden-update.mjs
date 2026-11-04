#!/usr/bin/env node
// Regenerates the expected recommendations in tests/fixtures/golden-personas.json
// from the current data and rules. Run this ONLY after a routing change you
// intend, then review the fixture diff (git diff tests/fixtures) before committing.
//
//   node scripts/golden-update.mjs
import { readFixture, writeFixture, route } from "../tests/golden.mjs";

const data = readFixture();
let changed = 0;
for (const p of data.personas) {
  const r = await route(p);
  const expected = { matches: r.matches, handoffs: r.handoffs };
  if (JSON.stringify(p.expected) !== JSON.stringify(expected)) changed++;
  p.expected = expected;
}
writeFixture(data);
console.log(`Updated ${data.personas.length} golden personas (${changed} changed). Review: git diff tests/fixtures`);
