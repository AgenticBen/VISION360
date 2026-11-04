// Acceptance tests for the Vision 360 CONNECT web voice + chat demo.
// Drives the real API in-process with an in-memory database.
// Run: npm run test:demo
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { makeApp, call, startSession, talker } from "./helpers.mjs";
import { hashPassword } from "../server/lib/auth.mjs";

const BASELINE = {
  "site/data/organizations.json": "9bd5c2e78e33c689e4d0965fc15a6d6fa88e5413b7c03c83dc46d449962dccc9",
  "data/organizations.json": "9bd5c2e78e33c689e4d0965fc15a6d6fa88e5413b7c03c83dc46d449962dccc9",
  "site/data/assessment.json": "1c4756a88d537928b6a14554cd2698b4fae9a4b95d223c6fa2e2188d963f5d0d",
  "site/data/geography.json": "a30bcf37769e510a72a669f557b8c7923e4a77376cfd109eba3faa09be4db905",
  "site/data/pathways.json": "5c514ef541ffd43d677a26478c37946bba34e22229ab7449892ba4855f67b6f0",
  "site/quiz-engine.js": "32645aec71fafdcb4123c34e0573bd261b8bde2b45c5d0e0dc07d349012ffd55",
};

// Fictional personas (from the PRD scenarios): an opening sentence, then what
// the person says to each question if it is asked. The driver answers whatever
// question the server actually asks, so the test follows the real flow.
const PERSONAS = {
  A_low_vision_phone: {
    opening: "I have low vision and want help magnifying things on my phone",
    answers: { actor: "myself", county: "Mecklenburg", goals: "technology", age_band: "I'm 67", hearing_loss: "no", eye_doctor: "yes", eye_exam_recency: "within the last year", insurance: "Medicare", veteran: "no" },
    section: "skip this section",
  },
  B_blind_mobility_books: {
    opening: "I'm blind. I want to learn to get around with a cane, manage at home, and get talking books",
    answers: { actor: "just me", county: "Charlotte", goals: "travel", age_band: "45", hearing_loss: "no", eye_doctor: "yes", eye_exam_recency: "within the last year", insurance: "Medicaid", veteran: "no" },
    section: "skip this section",
  },
  C_diabetic_worker: {
    opening: "I work full time, I'm diabetic and losing my sight, I can't drive to work any more and I want to keep my job",
    answers: { actor: "myself", county: "Charlotte", goals: "work and technology", age_band: "38", hearing_loss: "no", eye_doctor: "yes", eye_exam_recency: "more than a year ago", insurance: "private insurance", veteran: "no",
      housing_stable: "yes", food_worry: "never", utilities: "never", transport_barrier: "often", legal_matter: "none", loneliness: "never", broadband: "yes", devices: "a smartphone" },
    section: "answer them",
  },
};

async function runPersona(app, persona, mode = "text") {
  const s = await startSession(app, mode);
  const say = talker(app, s);
  let r = await say(persona.opening, { mode });
  for (let i = 0; i < 40 && r.state.phase === "intake"; i++) {
    if (r.turn.expect === "block_offer") { r = await say(persona.section, { mode }); continue; }
    const qid = r.state.currentQuestion && r.state.currentQuestion.id;
    const line = persona.answers[qid];
    if (!line) throw new Error("persona has no answer for " + qid + ": " + r.turn.text);
    r = await say(line, { mode });
  }
  return { s, say, r };
}

async function toResults(app, persona, mode = "text") {
  const { s, say, r } = await runPersona(app, persona, mode);
  assert.equal(r.state.phase, "recap", "persona should reach the recap: " + r.turn.text);
  assert.equal(r.state.results, null, "no results before confirmation");
  const done = await say("yes", { mode, revision: r.state.revision });
  assert.equal(done.state.phase, "results", done.turn.text);
  return { s, say, r: done };
}

test("source data and rules are unchanged (hash check)", () => {
  for (const [file, hash] of Object.entries(BASELINE)) {
    const got = createHash("sha256").update(readFileSync(new URL("../" + file, import.meta.url))).digest("hex");
    assert.equal(got, hash, file + " changed");
  }
});

test("three fictional personas complete typed and voice intake with identical confirmed answers and results", async () => {
  const app = await makeApp();
  for (const [name, persona] of Object.entries(PERSONAS)) {
    const t = await toResults(app, persona, "text");
    const v = await toResults(app, persona, "voice");
    const simplify = (st) => st.answers.map((a) => [a.questionId, a.kind, JSON.stringify(a.value), a.status]);
    assert.deepEqual(simplify(t.r.state), simplify(v.r.state), name + ": answers differ between modes");
    assert.ok(t.r.state.answers.every((a) => a.status === "confirmed"), name + ": all answers confirmed");
    assert.deepEqual(t.r.state.results.matches.map((m) => m.id), v.r.state.results.matches.map((m) => m.id), name + ": results differ between modes");
    assert.ok(t.r.state.results.matches.length >= 1 && t.r.state.results.matches.length <= 8, name + ": 1-8 matches");
  }
});

test("persona expectations from the PRD (reported, using the unchanged rules)", async () => {
  const app = await makeApp();
  const a = await toResults(app, PERSONAS.A_low_vision_phone);
  const ids = a.r.state.results.matches.map((m) => m.id);
  assert.ok(ids.includes("lions-services-lionsdenn"), "A: LionsDENN appears");
  const b = await toResults(app, PERSONAS.B_blind_mobility_books);
  const bids = b.r.state.results.matches.map((m) => m.id);
  assert.ok(bids.includes("nc-dsb-independent-living"), "B: DSB independent living appears");
  assert.ok(bids.some((id) => id.startsWith("metrolina-association-for-the-blind")), "B: MAB appears");
  const c = await toResults(app, PERSONAS.C_diabetic_worker);
  const cids = c.r.state.results.matches.map((m) => m.id);
  assert.ok(cids.includes("nc-dsb-vocational-rehabilitation"), "C: DSB VR appears");
  assert.ok(cids.some((id) => ["cats-special-transportation-service", "mecklenburg-transportation-system"].includes(id)), "C: a transport service appears");
});

test("every displayed fact is grounded in a directory record", async () => {
  const app = await makeApp();
  const orgs = JSON.parse(readFileSync(new URL("../site/data/organizations.json", import.meta.url)));
  const byId = new Map(orgs.map((o) => [o.id, o]));
  for (const persona of Object.values(PERSONAS)) {
    const { r } = await toResults(app, persona);
    for (const m of r.state.results.matches) {
      const o = byId.get(m.id);
      assert.ok(o, "unknown record " + m.id);
      assert.equal(m.name, o.name);
      assert.equal(m.oneLine, o.one_line);
      assert.equal(m.cost, o.cost || null);
      assert.equal(m.contacts.general_phone, o.contacts.general_phone || null);
      assert.equal(m.contacts.website, o.contacts.website || null);
      assert.equal(m.accessPath.length, (o.access_path || []).length, "full access path preserved");
      assert.equal(m.url, "https://vision360.agenticarc.ai/#org-" + m.id);
    }
  }
});

test("no personalised matching before an explicit recap confirmation", async () => {
  const app = await makeApp();
  const { s, say, r } = await runPersona(app, PERSONAS.A_low_vision_phone);
  assert.equal(r.state.phase, "recap");
  let x = await say("email me the plan");
  assert.equal(x.state.results, null);
  assert.match(x.turn.text, /once you've confirmed/);
  x = await say("hmm");
  assert.equal(x.state.phase, "recap");
  x = await say("yes but change the county to Gaston");
  assert.notEqual(x.state.phase, "results", "a yes with a correction is not a confirmation");
  const county = x.state.answers.find((a) => a.questionId === "county");
  assert.equal(county.value, "neighbouring");
  assert.equal(county.status, "proposed");
  void s;
});

test("a stale confirmation is rejected after a correction", async () => {
  const app = await makeApp();
  const { say, r } = await runPersona(app, PERSONAS.A_low_vision_phone);
  const oldRevision = r.state.revision;
  const c = await say("change the county to Gaston");
  assert.ok(c.state.revision > oldRevision);
  const stale = await say("", { action: "confirm_recap", revision: oldRevision });
  assert.equal(stale.state.phase, "recap");
  assert.match(stale.turn.text, /changed since that summary/);
  const ok = await say("", { action: "confirm_recap", revision: stale.state.revision });
  assert.equal(ok.state.phase, "results");
});

test("misheard county is corrected before it affects a referral", async () => {
  const app = await makeApp();
  const s = await startSession(app);
  const say = talker(app, s);
  await say("just ask me questions");
  await say("myself");
  let r = await say("Gaston");
  assert.equal(r.state.answers.find((a) => a.questionId === "county").value, "neighbouring");
  r = await say("actually I live in Charlotte");
  assert.equal(r.state.answers.find((a) => a.questionId === "county").value, "mecklenburg");
  assert.equal(r.state.currentQuestion.id, "goals", "goes back to the current question");
  assert.equal(r.state.results, null);
});

test("correcting veteran status changes recommendations as the rules require", async () => {
  const app = await makeApp();
  const persona = { opening: "just ask me questions", section: "skip this section", answers: { actor: "myself", county: "Charlotte", goals: "technology", age_band: "70", hearing_loss: "no", eye_doctor: "yes", eye_exam_recency: "within the last year", insurance: "Medicare", veteran: "yes", va_enrolled: "yes" } };
  const { say, r } = await runPersona(app, persona);
  assert.equal(r.state.phase, "recap");
  let res = await say("yes", { revision: r.state.revision });
  const vaBefore = res.state.results.matches.filter((m) => m.id.startsWith("va-")).length;
  assert.ok(vaBefore > 0, "veteran sees VA services");
  res = await say("actually I never served in the military");
  assert.equal(res.state.phase, "recap", res.turn.text);
  assert.equal(res.state.results, null, "old results invalidated");
  assert.ok(!res.state.answers.some((a) => a.questionId === "va_enrolled"), "VA follow-up answer removed");
  res = await say("yes", { revision: res.state.revision });
  const vaAfter = res.state.results.matches.filter((m) => m.id.startsWith("va-")).length;
  assert.equal(vaAfter, 0, "VA services drop after correction");
});

test("an ambiguous eye-exam date prompts clarification, not a guess", async () => {
  const app = await makeApp();
  const s = await startSession(app);
  const say = talker(app, s);
  for (const l of ["just ask me questions", "myself", "Charlotte", "reading", "60", "no", "yes"]) await say(l);
  let r = await say("last March");
  assert.ok(!r.state.answers.some((a) => a.questionId === "eye_exam_recency"), "no date guessed");
  assert.match(r.turn.text, /Just to check/);
  r = await say("2025");
  assert.ok(!r.state.answers.some((a) => a.questionId === "eye_exam_recency"), "2025 is still ambiguous");
  r = await say("more than a year ago");
  assert.equal(r.state.answers.find((a) => a.questionId === "eye_exam_recency").value, "more_than_year");
});

test("I don't know, skipped and declined stay distinct from no", async () => {
  const app = await makeApp();
  const s = await startSession(app);
  const say = talker(app, s);
  for (const l of ["just ask me questions", "myself", "Charlotte", "reading", "60"]) await say(l);
  await say("I don't know");             // hearing_loss
  await say("skip");                     // eye_doctor
  await say("", { action: "decline" });  // eye_exam_recency
  const r = await say("I'd rather not say"); // insurance (sensitive)
  const kinds = Object.fromEntries(r.state.answers.map((a) => [a.questionId, a.kind]));
  assert.equal(kinds.hearing_loss, "unknown");
  assert.equal(kinds.eye_doctor, "skipped");
  assert.equal(kinds.eye_exam_recency, "declined");
  assert.equal(kinds.insurance, "declined");
  assert.ok(!r.state.answers.some((a) => a.value === "no"), "nothing became no");
});

test("a partial correction changes only that fact and is read back", async () => {
  const app = await makeApp();
  const { say, r } = await runPersona(app, PERSONAS.B_blind_mobility_books);
  const before = Object.fromEntries(r.state.answers.map((a) => [a.questionId, JSON.stringify(a.value)]));
  const c = await say("change my age to 58");
  const after = Object.fromEntries(c.state.answers.map((a) => [a.questionId, JSON.stringify(a.value)]));
  for (const k of Object.keys(before)) if (k !== "age_band") assert.equal(after[k], before[k], k + " should not change");
  assert.equal(after.age_band, JSON.stringify("55_plus"));
  assert.match(c.turn.text, /changed that — you're 58/);
  assert.equal(c.state.phase, "recap");
});

test("consented email: one action, retry-safe, sent once to the test outbox", async () => {
  const app = await makeApp();
  const { say } = await toResults(app, PERSONAS.A_low_vision_phone);
  await say("email me the plan");
  let r = await say("sam at example dot com");
  assert.match(r.turn.speech, /s a m, at, example dot com/);
  r = await say("yes");
  assert.equal(r.state.phase, "email_consent");
  assert.equal(r.state.actions.length, 0, "nothing queued before consent");
  // The same consent turn sent twice (client retry) must not create two actions.
  const sess = JSON.parse(JSON.stringify(r.state));
  void sess;
  const turnId = "consent-retry-1";
  const a1 = await say("yes", { clientTurnId: turnId });
  const a2 = await say("yes", { clientTurnId: turnId });
  assert.equal(a2.replayed, true);
  assert.equal(a1.state.actions.length, 1);
  const drained = await app.ctx.actions.drain(10);
  const statuses = drained.map((d) => d.status);
  assert.ok(statuses.includes("mock_written") || app.store.actionsForSession(a1.state.sessionId)[0].status === "mock_written");
  const actions = app.store.actionsForSession(a1.state.sessionId);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].status, "mock_written", "local outbox is reported as mock, not as sent");
});

test("a correction after the email was already sent is flagged for staff, not hidden", async () => {
  const app = await makeApp();
  const { say } = await toResults(app, PERSONAS.A_low_vision_phone);
  await say("email me the plan");
  await say("sam@example.com");
  await say("yes");
  const sent = await say("yes");
  await app.ctx.actions.drain(5);
  const c = await say("actually change the county to Gaston");
  assert.equal(app.store.actionsForSession(c.state.sessionId)[0].status, "mock_written", "a sent email is not pretended away");
  assert.match(c.turn.text, /already gone out/);
  assert.ok(app.store.staffReviews(c.state.sessionId).some((r) => /reconcile/.test(r.reason)));
  void sent;
});

test("direct double-enqueue with the same authorisation is deduplicated", async () => {
  const app = await makeApp();
  const { s } = await toResults(app, PERSONAS.A_low_vision_phone);
  const session = app.store.getSession(s.id);
  const rec = app.store.currentRecommendation(s.id);
  const { buildPlan } = await import("../server/lib/plan.mjs");
  const plan = buildPlan(app.corpus, rec.result);
  const one = app.ctx.actions.authorizeAndEnqueueEmail(session, { recipient: "sam@example.com", plan, recommendationId: rec.id, method: "test" });
  const two = app.ctx.actions.authorizeAndEnqueueEmail(session, { recipient: "sam@example.com", plan, recommendationId: rec.id, method: "test" });
  assert.equal(one.action.id, two.action.id);
  assert.equal(two.duplicate, true);
});

test("a correction after consent cancels the queued email", async () => {
  const app = await makeApp({ V360_INLINE_WORKER: "off" });
  const { say } = await toResults(app, PERSONAS.A_low_vision_phone);
  await say("email me the plan");
  await say("sam@example.com");
  await say("yes");
  const queued = await say("yes");
  assert.equal(queued.state.actions[0].status, "queued");
  const c = await say("actually change the county to Gaston");
  assert.equal(c.state.actions[0].status, "cancelled");
  await app.ctx.actions.drain(5);
  assert.equal(app.store.actionsForSession(c.state.sessionId)[0].status, "cancelled", "worker never sends a cancelled action");
});

test("an interrupted consent question must be asked again before sending", async () => {
  const app = await makeApp();
  const { s, say } = await toResults(app, PERSONAS.A_low_vision_phone);
  await say("email me the plan");
  await say("sam@example.com");
  const consentTurn = await say("yes");
  const ev = await call(app, "POST", `/api/session/${s.id}/event`, { type: "speech_interrupted", turnId: consentTurn.turn.turnId }, { authorization: "Bearer " + s.token });
  assert.equal(ev.json.consentMustBeRepeated, true);
  const r = await say("yes");
  assert.equal(r.state.actions.length, 0, "no send on a yes to an unheard question");
  assert.match(r.turn.text, /cut off/);
  const r2 = await say("yes");
  assert.equal(r2.state.actions.length, 1);
});

test("real-provider mode only sends to allowlisted test inboxes and reports failures honestly", async () => {
  const app = await makeApp({ V360_EMAIL_TRANSPORT: "resend", V360_EMAIL_ALLOWLIST: "@test.example" });
  const { say } = await toResults(app, PERSONAS.A_low_vision_phone);
  await say("email me the plan");
  await say("someone@gmail.com");
  let r = await say("yes");
  assert.match(r.turn.text, /approved test inboxes/);
  assert.equal(r.state.actions.length, 0);
  await say("email me the plan");
  await say("demo@test.example");
  await say("yes");
  r = await say("yes");
  assert.equal(r.state.actions.length, 1);
  // No RESEND_API_KEY in this test env: the provider call must fail, never "sent".
  await app.ctx.actions.drain(5);
  const a = app.store.actionsForSession(r.state.sessionId)[0];
  assert.equal(a.status, "failed");
  assert.ok(app.store.staffReviews(r.state.sessionId).some((x) => /email plan failed/.test(x.reason)));
});

test("no-email path: plan stays on screen and staff handoff works without an address", async () => {
  const app = await makeApp();
  const { s, say } = await toResults(app, PERSONAS.B_blind_mobility_books);
  let r = await say("I don't have email");
  assert.match(r.turn.text, /don't need email/);
  r = await say("talk to a person");
  r = await say("no contact");
  r = await say("yes");
  assert.equal(r.state.staffRequested, true);
  assert.equal(r.state.phase, "results");
  const reviews = app.store.staffReviews(s.id);
  assert.ok(reviews.some((x) => x.reason.startsWith("Requested") && x.callback_ok === 0));
});

test("session and staff routes reject unauthorised access", async () => {
  const app = await makeApp();
  const s = await startSession(app);
  let r = await call(app, "POST", `/api/session/${s.id}/turn`, { text: "hi" }, { authorization: "Bearer wrong" });
  assert.equal(r.status, 404);
  r = await call(app, "GET", `/api/session/${s.id}/state`);
  assert.equal(r.status, 404);
  r = await call(app, "GET", "/api/staff/sessions");
  assert.equal(r.status, 401);
  r = await call(app, "GET", `/api/staff/sessions/${s.id}`);
  assert.equal(r.status, 401);
  app.store.createStaffUser("tester", hashPassword("correct horse"));
  r = await call(app, "POST", "/api/staff/login", { username: "tester", password: "nope" });
  assert.equal(r.status, 401);
  r = await call(app, "POST", "/api/staff/login", { username: "tester", password: "correct horse" });
  assert.equal(r.status, 200);
  const cookie = String(r.headers["Set-Cookie"]).split(";")[0];
  assert.match(String(r.headers["Set-Cookie"]), /HttpOnly; SameSite=Strict/);
  r = await call(app, "GET", "/api/staff/sessions", undefined, { cookie });
  assert.equal(r.status, 200);
  assert.ok(r.json.sessions.some((x) => x.id === s.id));
  r = await call(app, "GET", `/api/staff/sessions/${s.id}`, undefined, { cookie });
  assert.equal(r.status, 200);
  r = await call(app, "POST", `/api/staff/sessions/${s.id}/status`, { staffStatus: "reviewed" }, { cookie, origin: "https://evil.example" });
  assert.equal(r.status, 403, "cross-origin write rejected");
  r = await call(app, "POST", "/api/session", { noticeAccepted: false });
  assert.equal(r.status, 400, "notice must be accepted");
});

test("staff view distinguishes confirmed answers, unknowns, actions and versioned reasons", async () => {
  const app = await makeApp();
  const persona = { opening: "just ask me questions", section: "skip this section", answers: { actor: "myself", county: "Charlotte", goals: "reading", age_band: "60", hearing_loss: "I don't know", eye_doctor: "yes", eye_exam_recency: "within the last year", insurance: "Medicare", veteran: "no" } };
  const { s, say, r } = await runPersona(app, persona);
  await say("yes", { revision: r.state.revision });
  app.store.createStaffUser("tester", hashPassword("pw-123456"));
  const login = await call(app, "POST", "/api/staff/login", { username: "tester", password: "pw-123456" });
  const cookie = String(login.headers["Set-Cookie"]).split(";")[0];
  const d = await call(app, "GET", `/api/staff/sessions/${s.id}`, undefined, { cookie });
  assert.equal(d.status, 200);
  const hearing = d.json.snapshot.answers.find((a) => a.questionId === "hearing_loss");
  assert.equal(hearing.kind, "unknown");
  assert.ok(d.json.snapshot.answers.every((a) => a.status === "confirmed"));
  assert.ok(d.json.recommendations[0].corpusVersion.startsWith("corpus-"));
  assert.ok(d.json.recommendations[0].matches[0].reasons.length > 0);
  assert.ok(!JSON.stringify(d.json).includes("lastAssistant"), "staff view holds no transcript");
});

test("health and saved recommendations say which code and data produced them", async () => {
  const local = await makeApp();
  const h1 = await call(local, "GET", "/api/health");
  assert.equal(h1.json.commit, "local", "no Vercel commit outside a deployment");

  const app = await makeApp({ VERCEL_GIT_COMMIT_SHA: "abc1234def" });
  const h2 = await call(app, "GET", "/api/health");
  assert.equal(h2.json.commit, "abc1234def");
  assert.ok(h2.json.corpusVersion.startsWith("corpus-"));

  const { s } = await toResults(app, PERSONAS.A_low_vision_phone);
  const rec = app.store.currentRecommendation(s.id);
  assert.equal(rec.result.commit, "abc1234def");
  assert.equal(rec.result.corpusVersion, rec.corpus_version);
  assert.ok(rec.result.policyVersion);
});

test("repeat returns the same assistant turn without changing state", async () => {
  const app = await makeApp();
  const s = await startSession(app);
  const say = talker(app, s);
  const a = await say("just ask me questions");
  const b = await say("can you repeat that");
  assert.equal(b.turn.text, a.turn.text);
  assert.equal(b.state.revision, a.state.revision);
});

test.after(() => {
  try { rmSync((process.env.TMPDIR || "/tmp") + "/v360-outbox", { recursive: true, force: true }); } catch {}
  void readdirSync;
});
