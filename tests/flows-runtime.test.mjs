// The assistant runs any published workflow. The V360 TECH interest form is a
// form-style workflow: free-text answers (name, phone, email, address, date,
// consent), read-back for phone and email, and a submission to staff at the end
// instead of service suggestions.
import test from "node:test";
import assert from "node:assert/strict";
import { makeApp, call, talker } from "./helpers.mjs";

async function startFlow(app, flow) {
  const r = await call(app, "POST", "/api/session", { noticeAccepted: true, mode: "text", flow });
  return { r, s: r.status === 201 ? { id: r.json.sessionId, token: r.json.token } : null };
}
const turnRaw = (app, s, body) => call(app, "POST", `/api/session/${s.id}/turn`, { clientTurnId: "x" + Math.random(), ...body }, { authorization: "Bearer " + s.token });

test("unknown or unpublished workflows are refused; no flow means the main one", async () => {
  const app = await makeApp();
  let { r } = await startFlow(app, "nope");
  assert.equal(r.status, 404);
  assert.equal(r.json.code, "unknown_flow");
  ({ r } = await startFlow(app, "../referral"));
  assert.equal(r.status, 404);
  ({ r } = await startFlow(app));
  assert.equal(r.json.flow.id, "referral");
  assert.equal(app.store.getSession(r.json.sessionId).flow_id, "referral");
  ({ r } = await startFlow(app, "v360-interest"));
  assert.equal(r.json.flow.id, "v360-interest");
  const row = app.store.getSession(r.json.sessionId);
  assert.equal(row.flow_title, "V360 TECH interest form");
  assert.match(row.flow_version, /^v\d+@[0-9a-f]{12}$/);
  const a = await call(app, "GET", "/api/assistant?flow=v360-interest");
  assert.equal(a.json.flow.routing, false);
  assert.equal(a.json.flow.main, false);
  const site = await call(app, "GET", "/api/site");
  assert.equal(site.json.mainFlow, "referral");
  assert.ok(site.json.flows.every((f) => /\/f\/[a-z0-9-]+$/.test(f.url)));
  assert.deepEqual(Object.fromEntries(site.json.flows.map((f) => [f.id, f.group])), { referral: "assistant", "v360-interest": "assistant", "vision-assessment": "assessment" });
});

test("the Vision Assessment conversation is whichever workflow is live in its row", async () => {
  const app = await makeApp();
  const r = await call(app, "POST", "/api/session", { noticeAccepted: true, mode: "text", for: "assessment" });
  assert.equal(r.status, 201);
  assert.equal(r.json.flow.id, "vision-assessment");
  const a = await call(app, "GET", "/api/assistant?for=assessment");
  assert.equal(a.json.flow.id, "vision-assessment");
  let site = await call(app, "GET", "/api/site");
  assert.equal(site.json.assessmentFlow, "vision-assessment");
  assert.deepEqual(site.json.live, { assistant: "referral", assessment: "vision-assessment" });
  // Making the full-screen test live keeps the conversation at /assessment/interview/.
  await call(app, "PUT", "/api/admin/settings", { assessment: "live-test" });
  site = await call(app, "GET", "/api/site");
  assert.equal(site.json.live.assessment, "live-test");
  assert.equal(site.json.features.screenCheck, true);
  const b = await call(app, "GET", "/api/assistant?for=assessment");
  assert.equal(b.json.flow.id, "vision-assessment");
});

test("the interest form runs end to end in chat and goes to staff, with no suggestions", async () => {
  const app = await makeApp();
  const { r, s } = await startFlow(app, "v360-interest");
  assert.equal(r.status, 201);
  assert.match(r.json.turn.text, /V360 TECH interest form/);
  assert.equal(r.json.turn.question.id, "full_name");
  assert.equal(r.json.turn.question.required, true);
  assert.equal(r.json.turn.question.input.autocomplete, "name");
  const say = talker(app, s);

  let t = await say("skip");
  assert.match(t.turn.text, /I need this one for the form/);
  t = await say("My name is Sam Test");
  assert.equal(t.turn.question.id, "phone");
  t = await say("seven oh four five five five one two one two");
  assert.equal(t.turn.expect, "yes_no");
  assert.match(t.turn.text, /704-555-1212/);
  assert.match(t.turn.speech, /7 0 4, 5 5 5, 1 2 1 2/);
  t = await say("yes");
  assert.equal(t.turn.question.id, "email");
  t = await say("sam at example dot org");
  assert.equal(t.turn.expect, "yes_no");
  t = await say("no");
  assert.equal(t.turn.question.id, "email");
  t = await say("sam at example dot com");
  t = await say("yes that's right");
  assert.equal(t.turn.question.id, "home_address");
  t = await say("Main Street");
  assert.match(t.turn.text, /house number/);
  t = await say("123 Main Street, Charlotte 28213");
  assert.equal(t.turn.question.id, "date_of_birth");
  t = await say("March 4th 1950");
  assert.match(t.turn.text, /March 4, 1950 — got it/);
  assert.equal(t.turn.question.id, "contact_method");
  t = await say("", { choice: { questionId: "contact_method", value: "phone_call" } });
  assert.equal(t.turn.question.id, "contact_time");
  t = await say("skip");
  assert.equal(t.turn.question.id, "for_whom");
  t = await say("", { choice: { questionId: "for_whom", value: "myself" } });

  // Answer the rest: choices by button, free text by voice-style replies.
  for (let guard = 0; guard < 30 && t.turn.expect === "answer"; guard++) {
    const qn = t.turn.question;
    if (qn.id === "primary_goal") { t = await say("I'm not sure, maybe learn JAWS and talk to a real person about my phone"); assert.notEqual(t.turn.expect, "contact", "a long answer never starts a staff hand-off"); continue; }
    if (qn.id === "support_other") assert.fail("support_other is only asked when Other is chosen");
    if (qn.type === "consent") { t = await say("yes"); continue; }
    if (qn.type === "long_text") { t = await say("skip"); continue; }
    if (qn.options.length) { t = await say("", { choice: { questionId: qn.id, value: qn.type === "multi" ? [qn.options[0].value] : qn.options[0].value } }); continue; }
    t = await say("skip");
  }
  assert.equal(t.turn.expect, "confirm_recap");
  assert.match(t.turn.text, /Before I send this to the Lions Services team/);
  const items = Object.fromEntries(t.turn.recap.items.map((i) => [i.questionId, i.display]));
  assert.equal(items.full_name, "Sam Test");
  assert.equal(items.phone, "704-555-1212");
  assert.equal(items.email, "sam@example.com");
  assert.equal(items.date_of_birth, "March 4, 1950");
  assert.equal(items.primary_goal, "I'm not sure, maybe learn JAWS and talk to a real person about my phone");
  assert.equal(items.contact_consent, "Yes");
  t = await say("", { action: "confirm_recap", revision: t.state.revision });
  assert.equal(t.turn.expect, "ended");
  assert.equal(t.turn.submitted, true);
  assert.match(t.turn.text, /interest form has been received/);
  assert.equal(app.store.recommendations(s.id).length, 0, "no service suggestions for a form");
  const reviews = app.store.staffReviews(s.id);
  assert.equal(reviews.length, 1);
  assert.match(reviews[0].reason, /^Form submitted: V360 TECH interest form$/);
  // Admin sees the typed answers with their display text.
  const d = await call(app, "GET", `/api/staff/sessions/${s.id}`);
  assert.equal(d.json.flow.id, "v360-interest");
  assert.ok(d.json.snapshot.answers.some((a) => a.questionId === "date_of_birth" && a.display === "March 4, 1950"));
  const list = await call(app, "GET", "/api/staff/sessions?flow=v360-interest");
  assert.deepEqual(list.json.sessions.map((x) => x.id), [s.id]);
});

test("consent no: saved, marked do-not-contact; 'start over' keeps the workflow", async () => {
  const app = await makeApp();
  const { s } = await startFlow(app, "v360-interest");
  const say = talker(app, s);
  let t = await say("start over");
  t = await say("yes");
  assert.equal(t.turn.question.id, "full_name", "still the interest form");
  assert.equal(app.store.getSession(s.id).flow_id, "v360-interest");
  const fill = { full_name: "Pat Test", phone: "704 555 0000", email: "pat at example dot com", home_address: "9 Oak Road Charlotte 28205", date_of_birth: "1/2/1960" };
  for (let guard = 0; guard < 40 && t.turn.expect !== "confirm_recap"; guard++) {
    if (t.turn.expect === "yes_no") { t = await say("yes"); continue; }
    const qn = t.turn.question;
    if (fill[qn.id]) { t = await say(fill[qn.id]); continue; }
    if (qn.type === "consent") { t = await say("", { choice: { questionId: qn.id, value: "no" } }); continue; }
    if (qn.options.length) { t = await say("", { choice: { questionId: qn.id, value: qn.type === "multi" ? [qn.options[0].value] : qn.options[0].value } }); continue; }
    t = await say("skip");
  }
  t = await say("yes");
  assert.equal(t.turn.expect, "ended");
  assert.match(t.turn.text, /nobody from Lions Services will reach out/);
  assert.match(app.store.staffReviews(s.id)[0].reason, /do not contact/);
});

test("the referral conversation still asks for a first name first", async () => {
  const app = await makeApp();
  const { r } = await startFlow(app, "referral");
  assert.equal(r.json.turn.expect, "name");
});
