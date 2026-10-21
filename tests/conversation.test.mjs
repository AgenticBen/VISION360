// Conversation quality: names, "you", open questions, exact details, email
// capture and a clear ending.
import test from "node:test";
import assert from "node:assert/strict";
import { makeApp, startSession, talker } from "./helpers.mjs";

test("asks for a first name and uses it; questions say 'you', not 'the person'", async () => {
  const app = await makeApp();
  const s = await startSession(app, "text", { name: null });
  assert.match(s.first.turn.text, /first name/);
  const say = talker(app, s);
  let r = await say("yeah it's Ben");
  assert.match(r.turn.text, /Nice to meet you, Ben/);
  assert.equal(r.state.names.caller, "Ben");
  r = await say("just ask me questions");
  assert.match(r.turn.text, /for you, or/);
  r = await say("it's for me");
  assert.match(r.turn.text, /this is for you/);
  assert.match(r.turn.text, /Where do you live\?/);
  assert.doesNotMatch(r.turn.text, /the person/);
  assert.doesNotMatch(r.turn.text, /You can say:/, "options are not read out up front");
});

test("echoes the exact age and town instead of a band", async () => {
  const app = await makeApp();
  const s = await startSession(app);
  const say = talker(app, s);
  await say("just ask me questions");
  await say("myself");
  let r = await say("Huntersville");
  assert.match(r.turn.text, /^Huntersville — got it/);
  r = await say("technology");
  r = await say("I'm 26");
  assert.match(r.turn.text, /^26, got it/);
  assert.equal(r.state.answers.find((a) => a.questionId === "age_band").value, "22_to_54");
  assert.equal(r.state.answers.find((a) => a.questionId === "age_band").display, "26");
});

test("offers choices only after an unclear answer", async () => {
  const app = await makeApp();
  const s = await startSession(app);
  const say = talker(app, s);
  await say("just ask me questions");
  await say("myself");
  const r = await say("hmm, well, it's a long story");
  assert.match(r.turn.text, /Mecklenburg County/);
});

test("third party: asks their name and uses it", async () => {
  const app = await makeApp();
  const s = await startSession(app);
  const say = talker(app, s);
  let r = await say("I'm asking for my mom");
  assert.match(r.turn.text, /their first name/);
  r = await say("Maria");
  assert.match(r.turn.text, /I'll call them Maria/);
  assert.match(r.turn.text, /Where does Maria live\?/);
});

test("spoken email with filler words becomes a clean address", async () => {
  const app = await makeApp();
  const s = await startSession(app);
  const say = talker(app, s);
  const persona = { actor: "myself", county: "Charlotte", goals: "reading", age_band: "60", hearing_loss: "no", eye_doctor: "yes", eye_exam_recency: "within the last year", insurance: "Medicare", veteran: "no" };
  let r = await say("just ask me questions");
  for (let i = 0; i < 20 && r.state.phase === "intake"; i++) r = r.turn.expect === "block_offer" ? await say("skip them") : await say(persona[r.state.currentQuestion.id]);
  r = await say("yes", { revision: r.state.revision });
  assert.match(r.turn.text, /email you this plan\?$/);
  r = await say("yes please");
  r = await say("yeah so my email is sam dot smith at example dot com");
  assert.match(r.turn.text, /I have sam\.smith@example\.com\./);
});

test("the conversation has a clear ending", async () => {
  const app = await makeApp();
  const s = await startSession(app);
  const say = talker(app, s);
  const persona = { actor: "myself", county: "Charlotte", goals: "reading", age_band: "60", hearing_loss: "no", eye_doctor: "yes", eye_exam_recency: "within the last year", insurance: "Medicare", veteran: "no" };
  let r = await say("just ask me questions");
  for (let i = 0; i < 20 && r.state.phase === "intake"; i++) r = r.turn.expect === "block_offer" ? await say("skip them") : await say(persona[r.state.currentQuestion.id]);
  r = await say("yes", { revision: r.state.revision });
  r = await say("no thanks");               // email?
  assert.match(r.turn.text, /reach out/);
  r = await say("yes");                     // staff?
  assert.match(r.turn.text, /phone number or email/);
  r = await say("704 555 0100");
  r = await say("yes");
  assert.match(r.turn.text, /anything else/);
  r = await say("no, that's all");
  assert.equal(r.turn.expect, "ended");
  assert.match(r.turn.text, /You're all set, Sam/);
  const reviews = app.store.staffReviews(s.id);
  assert.ok(reviews.some((x) => x.contact && x.contact.callerName === "Sam" && x.contact.value === "704-555-0100"));
});

test("natural voice: off without a key; with a key, only the latest reply is voiced", async () => {
  const { createApp } = await import("../server/lib/api.mjs");
  const { openStore } = await import("../server/lib/store.mjs");
  const { call } = await import("./helpers.mjs");
  const off = await makeApp();
  let h = await call(off, "GET", "/api/health");
  assert.equal(h.json.tts.provider, "browser");
  const sent = [];
  const fakeEleven = async (url, init) => { sent.push({ url, body: JSON.parse(init.body), key: init.headers["xi-api-key"] }); return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }; };
  const app = await createApp({ store: openStore(":memory:"), env: { ELEVENLABS_API_KEY: "test-key" }, ttsFetch: fakeEleven });
  h = await call(app, "GET", "/api/health");
  assert.equal(h.json.tts.provider, "elevenlabs");
  assert.ok(!JSON.stringify(h.json).includes("test-key"), "key never exposed");
  const s = await startSession(app);
  const latest = s.afterName.turn;
  let r = await call(app, "POST", `/api/session/${s.id}/tts`, { turnId: latest.turnId, rate: "1.2" }, { authorization: "Bearer " + s.token });
  assert.equal(r.status, 200);
  assert.equal(sent[0].body.text, latest.speech);
  assert.equal(sent[0].key, "test-key");
  r = await call(app, "POST", `/api/session/${s.id}/tts`, { turnId: s.first.turn.turnId }, { authorization: "Bearer " + s.token });
  assert.equal(r.status, 409, "old turns can't be voiced");
  r = await call(app, "POST", `/api/session/${s.id}/tts`, { turnId: latest.turnId }, { authorization: "Bearer wrong" });
  assert.equal(r.status, 404, "needs the session's own token");
});
