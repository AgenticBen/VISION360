// Characterization: geography ranking and result selection must behave exactly
// as they did before they moved into site/quiz-engine.js. The FROZEN_* helpers
// below are copies of the pre-move rules (site/app.js geoTier and quizResults,
// server/lib/corpus.mjs makeGeoRank, server/lib/results.mjs). Do not "fix"
// them; change the engine and update these on purpose if the rules change.
import test from "node:test";
import assert from "node:assert/strict";
import { loadCorpus } from "../server/lib/corpus.mjs";
import { readFixture } from "./golden.mjs";

const FROZEN_RANK = { home: 0, statewide: 1, adjacent: 2, region: 3, travel: 4, elsewhere: 5 };

function frozenTier(org, geo) {
  const tierCounties = (id) => (geo && geo.tiers ? (geo.tiers.find((t) => t.id === id) || {}).counties || [] : []);
  const intersects = (a, b) => a.some((c) => b.includes(c));
  const area = org.service_area || {};
  const counties = area.counties || [];
  const verdict = area.verdict;
  if (geo && counties.includes(geo.home_county)) return "home";
  if (!counties.length && verdict === "in_area") return "statewide";
  if (counties.length && intersects(counties, tierCounties("adjacent"))) return "adjacent";
  if (counties.length && intersects(counties, tierCounties("region"))) return "region";
  if (verdict === "statewide_travel_required") return "travel";
  if (verdict === "in_area") return "statewide";
  return "elsewhere";
}

// Chat / voice: at most 8, at least 30 points and within 40% of the top match.
function frozenConversationPick(ranked) {
  const top = ranked[0] ? ranked[0].points : 0;
  const floor = Math.max(30, Math.round(top * 0.4));
  return ranked.filter((r) => r.points >= floor).slice(0, 8);
}

// Directory "Find services": everything that scored, first 8 shown, rest expandable.
function frozenDirectoryPick(ranked) {
  const hits = ranked.filter((r) => r.points > 0);
  return { top: hits.slice(0, 8), rest: hits.slice(8) };
}

function engineStateFor(corpus, persona) {
  const E = corpus.engine;
  const st = E.create(corpus.assessment);
  for (const b of persona.skippedBlocks || []) E.skipBlock(st, b);
  for (const q of corpus.assessment.questions) {
    if (Object.prototype.hasOwnProperty.call(persona.answers, q.id)) E.answer(st, q.id, persona.answers[q.id]);
  }
  return st;
}

const ids = (list) => list.map((r) => r.org.id);

test("server geography tiers match the frozen rules for every organization", async () => {
  const corpus = await loadCorpus();
  for (const org of corpus.organizations) {
    const want = frozenTier(org, corpus.geography);
    assert.equal(corpus.geoRank.tier(org), want, org.id);
    assert.equal(corpus.geoRank(org), FROZEN_RANK[want], org.id);
  }
});

test("engine geography tiers match the frozen rules, with and without geography.json", async () => {
  const corpus = await loadCorpus();
  const E = corpus.engine;
  for (const org of corpus.organizations) {
    assert.equal(E.geoTier(org, corpus.geography), frozenTier(org, corpus.geography), org.id);
    assert.equal(E.geoTier(org, null), frozenTier(org, null), org.id + " (no geography)");
    assert.equal(E.geoRank(corpus.geography)(org), FROZEN_RANK[frozenTier(org, corpus.geography)], org.id);
  }
});

test("engine result selection matches the frozen chat and directory rules for every sample person", async () => {
  const corpus = await loadCorpus();
  const E = corpus.engine;
  for (const p of readFixture().personas) {
    const ranked = E.score(engineStateFor(corpus, p), corpus.organizations, corpus.geoRank);
    const conv = E.selectResults(ranked, "conversation");
    assert.deepEqual(ids(conv.top), ids(frozenConversationPick(ranked)), p.id + " (chat)");
    assert.deepEqual(conv.rest, [], p.id + " (chat shows no extra list)");
    const dir = E.selectResults(ranked, "directory");
    const want = frozenDirectoryPick(ranked);
    assert.deepEqual(ids(dir.top), ids(want.top), p.id + " (directory)");
    assert.deepEqual(ids(dir.rest), ids(want.rest), p.id + " (directory, more)");
  }
});

test("nothing scored means nothing selected, in both channels", async () => {
  const corpus = await loadCorpus();
  const E = corpus.engine;
  const ranked = E.score(E.create(corpus.assessment), corpus.organizations, corpus.geoRank);
  assert.equal(E.selectResults(ranked, "conversation").top.length, 0);
  assert.equal(E.selectResults(ranked, "directory").top.length, 0);
});
