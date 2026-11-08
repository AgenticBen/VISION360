import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, call, startSession, talker } from "./helpers.mjs";
import { goBackIntent, listStepsIntent, stepNumber } from "../server/lib/understand.mjs";

async function upToAge(app) {
  const s = await startSession(app);
  const say = talker(app, s);
  await say("just ask me the questions");
  await say("it's for me");
  await say("Mecklenburg");
  const r = await say("technology and getting around");
  assert.equal(r.turn.question.id, "age_band", "set-up reached the age question");
  return { s, say };
}
const answerOf = (r, id) => (r.state.answers.find((a) => a.questionId === id) || {}).value;

test("go back asks which step, reads a numbered list, re-asks that step, then carries on where it was", async () => {
  const app = await makeApp();
  const { say } = await upToAge(app);
  let r = await say("go back");
  assert.equal(r.turn.expect, "go_back");
  assert.match(r.turn.text, /Which step would you like to go back to/);
  assert.match(r.turn.text, /say list/i);
  assert.deepEqual(r.turn.steps.map((x) => x.id), ["__name", "actor", "county", "goals"]);

  r = await say("list");
  assert.match(r.turn.text, /1: Your first name — Sam\. 2: .*3: Where .* — Mecklenburg County\. 4: /);
  r = await say("number three");
  assert.equal(r.turn.question.id, "county");
  assert.match(r.turn.text, /Right now I have that you live in Mecklenburg County/);
  r = await say("Gaston County");
  assert.equal(answerOf(r, "county"), "neighbouring");
  assert.match(r.turn.text, /Now, back to where we left off/);
  assert.equal(r.turn.question.id, "age_band", "back at the question it was on");
});

test("going back straight to a named step, with or without the new answer", async () => {
  const app = await makeApp();
  const { say } = await upToAge(app);
  let r = await say("can we go back to where I live");
  assert.equal(r.turn.question.id, "county");
  r = await say("never mind");
  assert.match(r.turn.text, /keep that as it is/);
  assert.equal(r.turn.question.id, "age_band");
  assert.equal(answerOf(r, "county"), "mecklenburg");

  r = await say("previous question");
  assert.equal(r.turn.question.id, "goals", "the last answer given");
  r = await say("work");
  assert.deepEqual(answerOf(r, "goals"), ["work"]);
  assert.equal(r.turn.question.id, "age_band");

  r = await say("go back to my name");
  assert.match(r.turn.text, /Right now I have Sam/);
  r = await say("Samantha");
  assert.match(r.turn.text, /Thanks, Samantha\. Now, back to where we left off/);
  assert.equal(r.state.names.caller, "Samantha");
});

test("'I want to go back to work' is an answer, not going back", async () => {
  const app = await makeApp();
  const s = await startSession(app);
  const say = talker(app, s);
  await say("just ask me the questions");
  await say("it's for me");
  let r = await say("Mecklenburg");
  assert.equal(r.turn.question.id, "goals");
  r = await say("I want to go back to work");
  assert.notEqual(r.turn.expect, "go_back");
  assert.ok([].concat(answerOf(r, "goals") || []).includes("work"));
});

test("a step number that doesn't exist reads the list; nothing to go back to at the start", async () => {
  const app = await makeApp();
  const { say } = await upToAge(app);
  let r = await say("go back to 9");
  assert.match(r.turn.text, /There isn't a step 9; we've done 4 so far\. Here are the steps so far/);
  r = await say("carry on");
  assert.equal(r.turn.question.id, "age_band");

  const s2 = await startSession(app, "text", { name: null });
  const say2 = talker(app, s2);
  await say2("skip");
  await say2("just ask me the questions");
  r = await say2("go back");
  assert.match(r.turn.text, /nothing to go back to/);
  assert.equal(r.turn.question.id, "actor");
});

test("going back from the summary changes the answer and reads the summary again", async () => {
  const app = await makeApp();
  const s = await startSession(app);
  const say = talker(app, s);
  let r = await say("just ask me the questions");
  for (let i = 0; i < 40 && r.state.phase !== "recap"; i++) r = await say(r.turn.question && r.turn.question.id === "county" ? "Mecklenburg" : r.turn.question && r.turn.question.id === "actor" ? "for me" : "skip");
  assert.equal(r.state.phase, "recap");
  r = await say("go back to where I live, it's Gaston County");
  assert.equal(answerOf(r, "county"), "neighbouring");
  assert.equal(r.state.phase, "recap");
  assert.equal(r.turn.expect, "confirm_recap");
});

test("the name button and the Vision Assessment form can go back too", async () => {
  const app = await makeApp();
  const { s } = await upToAge(app);
  let r = await call(app, "POST", `/api/session/${s.id}/turn`, { action: "edit_name", clientTurnId: "en1" }, { authorization: "Bearer " + s.token });
  assert.match(r.json.turn.text, /What should I call you/);

  const f = await call(app, "POST", "/api/session", { noticeAccepted: true, mode: "text", flow: "vision-assessment" });
  const fs = { id: f.json.sessionId, token: f.json.token };
  const say = talker(app, fs);
  await say("for me");
  r = await say("a lot");
  assert.equal(r.turn.question.id, "faces");
  r = await say("go back");
  assert.deepEqual(r.turn.steps.map((x) => x.id), ["for_whom", "reading_print"]);
  r = await say("2");
  assert.equal(r.turn.question.id, "reading_print");
  r = await say("a little");
  assert.equal(answerOf(r, "reading_print"), "some");
  assert.equal(r.turn.question.id, "faces");
});

test("go back, list and step numbers are understood", () => {
  assert.deepEqual(goBackIntent("Can we go back please"), { target: null, last: false });
  assert.deepEqual(goBackIntent("previous question"), { target: null, last: true });
  assert.deepEqual(goBackIntent("go back to where I live"), { target: "where i live", last: false });
  assert.deepEqual(goBackIntent("I want to change an earlier answer"), { target: null, last: false });
  assert.equal(goBackIntent("My age is 40 and I want to go back to school next year"), null);
  assert.ok(listStepsIntent("what have I answered so far"));
  assert.ok(!listStepsIntent("a list of jobs near me"));
  assert.equal(stepNumber("number three"), 3);
  assert.equal(stepNumber("the second one"), 2);
  assert.equal(stepNumber("Gaston"), null);
});
