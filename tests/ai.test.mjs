// Tests for the optional AI understanding layer, using a fake gateway.
// No real AI calls are made.
import test from "node:test";
import assert from "node:assert/strict";
import { makeApp, startSession, talker, call } from "./helpers.mjs";

function fakeGateway(reply, log = []) {
  return async (url, init) => {
    log.push({ url, body: JSON.parse(init.body) });
    if (reply instanceof Error) throw reply;
    const content = typeof reply === "function" ? reply(JSON.parse(init.body)) : reply;
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
  };
}

async function appWith(reply, log) {
  const app = await makeApp({ V360_AI_UNDERSTANDING: "on", AI_GATEWAY_API_KEY: "test-key" });
  // swap in the fake gateway
  const { createApp } = await import("../server/lib/api.mjs");
  const { openStore } = await import("../server/lib/store.mjs");
  return createApp({ store: openStore(":memory:"), env: { V360_AI_UNDERSTANDING: "on", AI_GATEWAY_API_KEY: "test-key", V360_OUTBOX_DIR: (process.env.TMPDIR || "/tmp") + "/v360-outbox" }, aiFetch: fakeGateway(reply, log) });
  void app;
}

test("AI is off by default: no gateway calls", async () => {
  const log = [];
  const { createApp } = await import("../server/lib/api.mjs");
  const { openStore } = await import("../server/lib/store.mjs");
  const app = await createApp({ store: openStore(":memory:"), env: {}, aiFetch: fakeGateway({}, log) });
  const s = await startSession(app);
  const say = talker(app, s);
  await say("my nephew helps me but honestly it's complicated");
  assert.equal(log.length, 0);
  const h = await call(app, "GET", "/api/health");
  assert.equal(h.json.aiUnderstanding.on, false);
});

test("AI maps a free-form answer the rules can't parse, and it is only proposed", async () => {
  const log = [];
  const app = await appWith((body) => {
    const u = JSON.parse(body.messages[1].content);
    if (u.current_question && u.current_question.id === "actor") return { kind: "answer", value: "family_friend", others: [{ questionId: "county", value: "mecklenburg" }] };
    return { kind: "unclear" };
  }, log);
  const s = await startSession(app);
  const say = talker(app, s);
  await say("just ask me questions");
  const r = await say("well it's really about my nephew's grandmother who lives over by the university");
  const actor = r.state.answers.find((a) => a.questionId === "actor");
  assert.equal(actor.value, "family_friend");
  assert.equal(actor.status, "proposed");
  assert.match(actor.source, /AI/);
  assert.equal(r.state.answers.find((a) => a.questionId === "county").value, "mecklenburg");
  assert.equal(r.state.results, null, "no suggestions without the recap");
  assert.ok(log.length >= 1);
  assert.equal(log[0].body.model, "google/gemini-2.5-flash");
});

test("AI cannot introduce a code that doesn't exist", async () => {
  const app = await appWith({ kind: "answer", value: "rich_and_famous", others: [{ questionId: "made_up", value: "x" }, { questionId: "county", value: "the_moon" }] });
  const s = await startSession(app);
  const say = talker(app, s);
  await say("just ask me questions");
  const r = await say("hmm, well, it's a long story");
  assert.ok(!r.state.answers.some((a) => a.questionId === "actor"), "invalid code discarded");
  assert.ok(!r.state.answers.some((a) => a.questionId === "county"));
  assert.match(r.turn.text, /didn't catch/);
});

test("AI failure falls back to the rules", async () => {
  const app = await appWith(new Error("gateway down"));
  const s = await startSession(app);
  const say = talker(app, s);
  await say("just ask me questions");
  const r = await say("hmm, well, it's a long story");
  assert.match(r.turn.text, /didn't catch/);
  const r2 = await say("myself");
  assert.equal(r2.state.answers.find((a) => a.questionId === "actor").value, "self");
});

test("AI is not consulted when the rules already understood, and ambiguity still asks", async () => {
  const log = [];
  const app = await appWith((body) => {
    const u = JSON.parse(body.messages[1].content);
    if (u.current_question && u.current_question.id === "eye_exam_recency") return { kind: "ambiguous", candidates: ["within_year", "more_than_year"] };
    return { kind: "unclear" };
  }, log);
  const s = await startSession(app);
  const say = talker(app, s);
  for (const l of ["just ask me questions", "myself", "Charlotte", "reading", "60", "no", "yes"]) await say(l);
  const before = log.length;
  const r = await say("I went when my granddaughter was born, I think");
  assert.ok(log.length > before, "AI consulted for an answer the rules couldn't parse");
  assert.match(r.turn.text, /Just to check/);
  assert.ok(!r.state.answers.some((a) => a.questionId === "eye_exam_recency"));
});

test("AI opening extraction is merged and still confirmed in the recap", async () => {
  const app = await appWith((body) => {
    const u = JSON.parse(body.messages[1].content);
    if (u.questions) return { answers: [{ questionId: "veteran", value: "yes" }, { questionId: "goals", value: ["technology"] }] };
    return { kind: "unclear" };
  });
  const s = await startSession(app);
  const say = talker(app, s);
  const r = await say("Did twenty years in the Army, now my eyes are going and I can't read my phone");
  const vet = r.state.answers.find((a) => a.questionId === "veteran");
  assert.equal(vet.value, "yes");
  assert.equal(vet.status, "proposed");
});
