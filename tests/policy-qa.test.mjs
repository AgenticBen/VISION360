// Regression tests from the conversation-policy QA pass (2026-11-04).
// Each test pins a rule from 03-caller-confirmation that a real phrasing
// used to break: a yes with new information, "not sure" read as yes, "no idea"
// read as no, a loose email read-back, guessed dates and ages, and "that's all"
// ending a session mid-sentence.
import test from "node:test";
import assert from "node:assert/strict";
import { makeApp, startSession, talker } from "./helpers.mjs";
import { createSqliteSessionRepo } from "../server/lib/session-repo.mjs";
import { createTurnService } from "../server/lib/turn-service.mjs";
import { strictConfirm, yesNo, detectGlobal, interpretAnswer } from "../server/lib/understand.mjs";
import { readFileSync } from "node:fs";

const assessment = JSON.parse(readFileSync(new URL("../site/data/assessment.json", import.meta.url)));
const Q = (id) => assessment.questions.find((q) => q.id === id);

const PERSONA = {
  opening: "just ask me questions",
  section: "skip this section",
  answers: { actor: "myself", county: "Mecklenburg", goals: "technology", age_band: "I'm 67", hearing_loss: "no", eye_doctor: "yes", eye_exam_recency: "within the last year", insurance: "Medicare", veteran: "no" },
};

async function toRecap(app, mode = "text") {
  const s = await startSession(app, mode);
  const say = talker(app, s);
  let r = await say(PERSONA.opening, { mode });
  for (let i = 0; i < 40 && r.state.phase === "intake"; i++) {
    if (r.turn.expect === "block_offer") { r = await say(PERSONA.section, { mode }); continue; }
    r = await say(PERSONA.answers[r.state.currentQuestion.id], { mode });
  }
  assert.equal(r.state.phase, "recap");
  return { s, say, r };
}

async function toResults(app) {
  const { s, say, r } = await toRecap(app);
  const done = await say("yes", { revision: r.state.revision });
  assert.equal(done.state.phase, "results");
  return { s, say, r: done };
}

const answer = (r, id) => (r.state.answers.find((a) => a.questionId === id) || {}).value;

test("a bare yes is a confirmation; a yes with anything else is not", () => {
  for (const t of ["yes", "yeah", "yep", "I do", "uh huh", "okay", "yes that's right", "yes ma'am", "that's all correct", "sounds right", "correct"]) {
    assert.equal(strictConfirm(t), true, t);
  }
  for (const t of ["yes I'm 70", "yes, 70", "yes it's for my mother", "I do have Aetna", "yes but it's dot org", "yes, wait", "yes hold on let me check", "yes send it to bob at example dot com", "mm-hmm", "it's fine", "I'm not sure", "yes and I also need help with food", "no idea"]) {
    assert.equal(strictConfirm(t), false, t);
  }
});

test("at the summary, 'yes' plus new information changes the answer instead of confirming", async () => {
  const app = await makeApp();
  const cases = [["yes, Aetna", "insurance", "private"], ["yes I'm in South Carolina", "county", "outside_nc"], ["yes and I'm uninsured", "insurance", "uninsured"]];
  for (const [text, qid, value] of cases) {
    const { say, r } = await toRecap(app);
    const c = await say(text, { revision: r.state.revision });
    assert.equal(c.state.results, null, `${text}: nothing suggested`);
    assert.equal(answer(c, qid), value, `${text}: answer changed`);
  }
});

test("at the summary, 'yes' plus something unclear is never taken as confirmation", async () => {
  const app = await makeApp();
  for (const text of ["yes I'm 70", "yes and reading too", "yes, I don't know", "yes, wait"]) {
    const { say, r } = await toRecap(app);
    const c = await say(text, { revision: r.state.revision });
    assert.equal(c.state.results, null, text);
    assert.notEqual(c.state.phase, "closed", text);
  }
});

test("'not sure', 'no idea' and 'I don't remember' mean unknown, never yes or no", () => {
  for (const t of ["I'm not sure", "not sure", "no idea", "no clue", "I don't remember"]) assert.equal(yesNo(t), null, t);
  for (const [qid, t] of [["veteran", "I'm not sure"], ["housing_stable", "not sure"], ["hearing_loss", "no idea"], ["veteran", "I don't remember"], ["broadband", "no clue"], ["eye_doctor", "I have no idea"]]) {
    assert.equal(interpretAnswer(t, Q(qid), {}).kind, "unknown", `${qid} <- ${t}`);
  }
  assert.equal(interpretAnswer("no", Q("hearing_loss"), {}).value, "no");
  assert.equal(interpretAnswer("yes", Q("veteran"), {}).value, "yes");
});

test("'I'm not sure' about military service does not open the VA questions", async () => {
  const app = await makeApp();
  const s = await startSession(app);
  const say = talker(app, s);
  let r = await say(PERSONA.opening);
  for (let i = 0; i < 40 && r.state.currentQuestion && r.state.currentQuestion.id !== "veteran"; i++) {
    if (r.turn.expect === "block_offer") { r = await say(PERSONA.section); continue; }
    r = await say(PERSONA.answers[r.state.currentQuestion.id]);
  }
  const v = await say("I'm not sure");
  const vet = v.state.answers.find((a) => a.questionId === "veteran");
  assert.equal(vet.kind, "unknown");
  assert.doesNotMatch(v.turn.text, /Thank you for your service/);
});

test("an unclear exam date or age is asked about, never guessed", () => {
  const today = new Date("2026-11-04");
  for (const t of ["not recently", "not this year", "not in the last year", "less than two years ago"]) {
    assert.equal(interpretAnswer(t, Q("eye_exam_recency"), { today }).kind, "ambiguous", t);
  }
  assert.equal(interpretAnswer("within the last year", Q("eye_exam_recency"), { today }).value, "within_year");
  for (const t of ["between 50 and 60", "around 54 or 55", "13 or 14", "over 50", "my mom is 80 but I'm 50"]) {
    assert.equal(interpretAnswer(t, Q("age_band"), {}).kind, "ambiguous", t);
  }
  assert.equal(interpretAnswer("over 60", Q("age_band"), {}).value, "55_plus");
  assert.equal(interpretAnswer("I'm 67", Q("age_band"), {}).value, "55_plus");
});

test("'that's all' ends the session only when it is the whole reply", async () => {
  for (const t of ["that's all", "no, that's all, thanks", "I'm done"]) assert.equal(!!detectGlobal(t).end, true, t);
  for (const t of ["that's all correct", "reading, that's all", "yes, that's all"]) assert.equal(!!detectGlobal(t).end, false, t);
  const app = await makeApp();
  const { say, r } = await toRecap(app);
  const done = await say("yes, that's all correct", { revision: r.state.revision });
  assert.equal(done.state.phase, "results", "confirmed, not ended");
});

test("the email address read-back needs a clear yes", async () => {
  const app = await makeApp();
  for (const text of ["yes but it's dot org", "yes, wait", "not sure", "right but it's my work email"]) {
    const { say } = await toResults(app);
    await say("yes please");
    await say("sam@example.com");
    const c = await say(text);
    assert.equal(c.state.phase, "email_confirm_address", text);
    assert.equal(c.state.actions.length, 0, `${text}: nothing queued`);
  }
});

test("at consent, a different address is read back first and nothing is queued", async () => {
  const app = await makeApp();
  const { say } = await toResults(app);
  await say("yes please");
  await say("sam@example.com");
  const consent = await say("yes");
  assert.equal(consent.state.phase, "email_consent");
  const other = await say("yes send it to bob at example dot com");
  assert.equal(other.state.phase, "email_confirm_address");
  assert.equal(other.state.email.address, "bob@example.com");
  assert.equal(other.state.actions.length, 0);
  const stillWaiting = await say("yes I'm 70");
  assert.equal(stillWaiting.state.actions.length, 0, "a yes with extra words never sends");
});

test("after results, a correction without a cue word is applied", async () => {
  const app = await makeApp();
  const { say } = await toResults(app);
  const c = await say("yes, it's for my mother");
  assert.equal(answer(c, "actor"), "family_friend");
  assert.equal(c.state.results, null, "old suggestions set aside");
  assert.equal(c.state.phase, "recap");
});

test("a turn that loaded the session before the email worker changed it is refused, not saved stale", async () => {
  // Worker off inline, so it runs exactly between the load and the save below,
  // like a second server instance would.
  const app = await makeApp({ V360_INLINE_WORKER: "off" });
  const { s, say } = await toResults(app);
  await say("yes please");
  await say("sam@example.com");
  await say("yes");
  const queued = await say("yes");
  assert.equal(queued.state.actions.length, 1);
  const repo = createSqliteSessionRepo(app.store);
  const turns = createTurnService({ corpus: app.corpus, store: app.store, repo, dialogue: app.dialogue, actions: app.ctx.actions, env: {} });
  const stale = await repo.load(s.id); // a turn starts...
  await app.ctx.actions.drain(5); // ...the worker sends the email meanwhile...
  await assert.rejects(() => turns.turn(stale, { text: "change the county to Gaston" }), (e) => e.status === 409 && e.code === "conflict");
  // ...and a fresh attempt sees the sent email and flags it for staff.
  const fresh = await say("change the county to Gaston");
  assert.ok(app.store.staffReviews(s.id).some((r) => /already sent/.test(r.reason)));
  assert.equal(fresh.state.results, null);
});
