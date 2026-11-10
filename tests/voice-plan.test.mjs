// The natural voice's cost on the ElevenLabs plan (server/lib/voice-plan.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { voicePlan } from "../server/lib/voice-plan.mjs";
import { makeApp, call } from "./helpers.mjs";

test("Starter plan: $6 for 40,000 credits at 0.2 credits a character", () => {
  const p = voicePlan({}, { conversations: 44, ttsChars: 38161 });
  assert.equal(p.plan.usd, 6);
  assert.equal(p.plan.credits, 40000);
  assert.equal(p.usdPerCredit, 0.00015);
  assert.equal(p.per1kUsd, 0.03, "1,000 characters is 200 credits, about 3 cents");
  assert.equal(p.charsPerConversation, 867);
  assert.equal(p.creditsPerConversation, 173);
  assert.equal(p.usdPerConversation, 0.0259, "about 2.6 cents");
  assert.equal(p.conversationsPerPlan, 231);
  assert.equal(p.perConversationSource, "site");
});

test("the plan can be changed in Vercel without code; bad values fall back", () => {
  const p = voicePlan({ V360_TTS_PLAN_USD: "22", V360_TTS_PLAN_CREDITS: "100000", V360_TTS_PLAN_NAME: "Creator", V360_TTS_CREDITS_PER_CHAR: "nope" }, {});
  assert.equal(p.plan.name, "Creator");
  assert.equal(p.plan.usd, 22);
  assert.equal(p.plan.creditsPerChar, 0.2);
  assert.equal(p.charsPerConversation, 1331, "no conversations yet: the measured week (65,200 characters over 49 sessions)");
  assert.equal(p.perConversationSource, "measured");
});

test("the admin overview prices the voice from the plan unless a price is set", async () => {
  const app = await makeApp();
  let r = await call(app, "GET", "/api/admin/overview");
  assert.equal(r.json.costs.tts.per1kUsd, 0.03);
  assert.equal(r.json.costs.tts.plan.plan.name, "Starter");
  const set = await makeApp({ V360_COST_PER_1K_TTS_CHARS: "0.05" });
  r = await call(set, "GET", "/api/admin/overview");
  assert.equal(r.json.costs.tts.per1kUsd, 0.05);
});
