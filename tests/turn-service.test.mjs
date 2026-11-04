// The conversation core loads a session once, works on an in-memory copy,
// and saves once. These tests cover what that guarantees: two saves of the
// same session can't silently overwrite each other, retries replay, AI
// readings are passed in explicitly and never stored, and nothing is written
// until the turn is saved.
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/lib/api.mjs";
import { openStore } from "../server/lib/store.mjs";
import { createSqliteSessionRepo } from "../server/lib/session-repo.mjs";
import { createTurnService } from "../server/lib/turn-service.mjs";
import { makeApp, call, startSession, talker } from "./helpers.mjs";

const OUTBOX = (process.env.TMPDIR || "/tmp") + "/v360-outbox";

async function serviceFor(app) {
  const repo = createSqliteSessionRepo(app.store);
  const turns = createTurnService({ corpus: app.corpus, store: app.store, repo, dialogue: app.dialogue, actions: app.ctx.actions, env: { V360_OUTBOX_DIR: OUTBOX } });
  return { repo, turns };
}

test("a stale save is rejected with 409 and changes nothing", async () => {
  const app = await makeApp();
  const s = await startSession(app);
  const say = talker(app, s);
  await say("just ask me questions");
  const { repo, turns } = await serviceFor(app);

  // Two copies of the same session, as two server instances would load it.
  const first = await repo.load(s.id);
  const second = await repo.load(s.id);
  await turns.turn(first, { text: "it's for me" });
  const afterFirst = app.store.getSession(s.id);

  await assert.rejects(() => turns.turn(second, { text: "for my mother" }), (e) => e.status === 409);
  const afterSecond = app.store.getSession(s.id);
  assert.equal(afterSecond.version, afterFirst.version, "the losing save wrote nothing");
  assert.equal(afterSecond.state_json, afterFirst.state_json);
  const actor = app.store.getAnswers(s.id).find((a) => a.questionId === "actor");
  assert.equal(actor.value, "self", "the first answer stands");
});

test("two server instances sharing one database cannot overwrite each other", async () => {
  const store = openStore(":memory:");
  const env = { V360_OUTBOX_DIR: OUTBOX };
  const a = await createApp({ store, env });
  const b = await createApp({ store, env });
  const s = await startSession(a);
  const sayA = talker(a, s);
  await sayA("just ask me questions");
  const { repo, turns } = await serviceFor(b);
  const stale = await repo.load(s.id); // instance B reads...
  await sayA("it's for me"); // ...instance A saves first...
  await assert.rejects(() => turns.turn(stale, { text: "for my mother" }), (e) => e.status === 409); // ...so B's save is refused
  const r = await call(a, "GET", `/api/session/${s.id}/state`, undefined, { authorization: "Bearer " + s.token });
  assert.equal(r.json.state.answers.find((x) => x.questionId === "actor").value, "self");
});

test("a retried turn with the same client turn id replays without changing anything", async () => {
  const app = await makeApp();
  const s = await startSession(app);
  const send = (text) => call(app, "POST", `/api/session/${s.id}/turn`, { text, clientTurnId: "same-id" }, { authorization: "Bearer " + s.token });
  await call(app, "POST", `/api/session/${s.id}/turn`, { text: "just ask me questions", clientTurnId: "open" }, { authorization: "Bearer " + s.token });
  const one = await send("it's for me");
  const versionAfterOne = app.store.getSession(s.id).version;
  const two = await send("it's for me");
  assert.equal(two.status, 200);
  assert.equal(two.json.replayed, true);
  assert.equal(two.json.state.revision, one.json.state.revision);
  assert.equal(app.store.getSession(s.id).version, versionAfterOne, "replay did not save again");
});

test("nothing is written until the turn is saved", async () => {
  const app = await makeApp();
  const s = await startSession(app);
  await talker(app, s)("just ask me questions");
  const loaded = await createSqliteSessionRepo(app.store).load(s.id);
  const before = app.store.getAnswers(s.id).length;
  app.dialogue.handle(loaded, { text: "it's for me", mode: "text" });
  assert.ok(loaded.work.ops.length > 0, "the dialogue queued its changes");
  assert.equal(app.store.getAnswers(s.id).length, before, "but the database is untouched until save");
});

test("AI readings are passed in for one turn and never stored on the session", async () => {
  const fake = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ kind: "answer", value: "family_friend" }) } }] }) });
  const app = await createApp({ store: openStore(":memory:"), env: { V360_AI_UNDERSTANDING: "on", AI_GATEWAY_API_KEY: "test-key", V360_OUTBOX_DIR: OUTBOX }, aiFetch: fake });
  const s = await startSession(app);
  const say = talker(app, s);
  await say("just ask me questions");
  const r = await say("well it's really about my nephew's grandmother who lives over by the university");
  const actor = r.state.answers.find((a) => a.questionId === "actor");
  assert.equal(actor.value, "family_friend");
  assert.equal(actor.status, "proposed", "an AI reading is only a proposal");
  const raw = app.store.getSession(s.id).state_json;
  assert.ok(!/interpretations|"interp"|"extract"|__ai/.test(raw), "no AI reading is kept in the stored conversation state");
});
