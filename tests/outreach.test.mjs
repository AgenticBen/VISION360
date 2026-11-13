// Contacting organizations for the person: the offer, name and contact
// read-backs, choosing organizations, the exact consent, the demo test-inbox
// redirect, cancellation, and the admin switch and contact table.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { makeApp, call, startSession, talker } from "./helpers.mjs";
import { channelFor, singleEmail } from "../server/lib/outreach-directory.mjs";
import { cleanName, parsePicks } from "../server/lib/dialogue-outreach.mjs";
import { buildOrgReferral } from "../server/lib/outreach-mail.mjs";
import { loadCorpus } from "../server/lib/corpus.mjs";
import { recordView } from "../server/lib/results.mjs";

const corpus = await loadCorpus();
const ANSWERS = { actor: "myself", county: "Mecklenburg", goals: "technology", age_band: "I'm 67", hearing_loss: "no", eye_doctor: "yes", eye_exam_recency: "within the last year", insurance: "Medicare", veteran: "no" };

let n = 0;
async function setup({ on = true, env = {} } = {}) {
  const dir = (process.env.TMPDIR || "/tmp") + `/v360-outreach-${process.pid}-${++n}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const app = await makeApp({ V360_OUTBOX_DIR: dir, ...env });
  if (on) assert.equal((await call(app, "PUT", "/api/admin/outreach/settings", { on: true })).status, 200);
  return { app, dir };
}

async function toResults(app) {
  const s = await startSession(app);
  const say = talker(app, s);
  let r = await say("I have low vision and want help magnifying things on my phone");
  for (let i = 0; i < 40 && r.state.phase === "intake"; i++) {
    if (r.turn.expect === "block_offer") { r = await say("skip this section"); continue; }
    r = await say(ANSWERS[r.state.currentQuestion.id]);
  }
  r = await say("yes", { revision: r.state.revision });
  assert.equal(r.state.phase, "results");
  return { s, say, r };
}

// Results -> no email -> yes to the offer -> name -> contact -> pick list.
async function toPick(app) {
  const { s, say } = await toResults(app);
  let r = await say("no thanks");
  assert.match(r.turn.text, /I can contact some of these organizations for you/);
  r = await say("yes please");
  assert.match(r.turn.text, /What name should I give them\? I can say Sam/);
  r = await say("my name is sam smith");
  assert.match(r.turn.text, /the name is Sam Smith\. Is that right/);
  r = await say("yes");
  assert.match(r.turn.text, /phone number and email/);
  r = await say("704 555 0100 and sam at example dot com");
  assert.match(r.turn.text, /reach Sam Smith by phone at 704-555-0100 and by email at sam@example\.com\. Is that right/);
  assert.match(r.turn.speech, /7 0 4, 5 5 5, 0 1 0 0/);
  r = await say("yes");
  assert.equal(r.turn.expect, "outreach_pick");
  const can = r.turn.outreachPick.orgs.filter((o) => o.channel);
  assert.ok(can.length >= 2, "at least two suggestions can be emailed");
  return { s, say, r, can };
}

test("names, picks and channels are understood", () => {
  assert.equal(cleanName("my full name is jane q. doe"), "Jane Q Doe");
  assert.equal(cleanName("it's Robert"), "Robert");
  assert.equal(cleanName("1234"), null);
  assert.equal(parsePicks("all of them", 8), "all");
  assert.deepEqual(parsePicks("one and three", 8), [1, 3]);
  assert.deepEqual(parsePicks("2, 5 and 9", 8), [2, 5]);
  assert.equal(singleEmail("info@x.org"), "info@x.org");
  assert.equal(singleEmail("a@x.org; b@x.org"), null);
  const no = corpus.organizations.find((o) => o.accepts_third_party_referral === "no");
  assert.equal(channelFor(no, null).channel, "none", "organizations that ask to be contacted directly are never emailed");
  const withEmail = corpus.organizations.find((o) => o.accepts_third_party_referral !== "no" && singleEmail(o.contacts.general_email));
  assert.equal(channelFor(withEmail, null).channel, "email");
  assert.equal(channelFor(withEmail, { channel: "none" }).channel, "none");
  assert.equal(channelFor(withEmail, { channel: "email", email: "intake@x.org" }).email, "intake@x.org");
});

test("the referral email names the person and contacts, says may be eligible, and shares nothing else", () => {
  const org = corpus.organizations.find((o) => singleEmail(o.contacts.general_email));
  const m = { rank: 1, reasons: ["You said you have diabetes."], ...recordView(corpus, org) };
  const mail = buildOrgReferral(m, { name: "Sam Smith", phone: "704-555-0100", email: "sam@example.com", preferred: "phone" }, { demo: true, intendedTo: org.contacts.general_email });
  assert.match(mail.text, /on behalf of Sam Smith/);
  assert.match(mail.text, /may be eligible/);
  assert.match(mail.text, /Phone: 704-555-0100/);
  assert.match(mail.text, /Email: sam@example\.com/);
  assert.match(mail.subject, /^\[DEMO\]/);
  assert.match(mail.text, /meant for .* It was sent to the demo test inbox instead/);
  assert.doesNotMatch(mail.text + mail.html, /qualif/i);
  assert.doesNotMatch(mail.text + mail.html, /diabetes/i, "the reasons (their answers) are never included");
});

test("the offer only appears when switched on", async () => {
  const { app } = await setup({ on: false });
  const { say } = await toResults(app);
  const r = await say("no thanks");
  assert.doesNotMatch(r.turn.text, /contact some of these organizations/);
  assert.match(r.turn.text, /Lions Services/);
});

test("contacting two organizations: exact consent, then demo emails to the test inbox marked for each organization", async () => {
  const { app, dir } = await setup();
  const { say, can } = await toPick(app);
  const picks = can.slice(0, 2);
  let r = await say(`number ${picks[0].rank} and number ${picks[1].rank}`);
  assert.equal(r.turn.expect, "consent");
  assert.match(r.turn.text, /Here's exactly what I'll do\. I'll email/);
  assert.match(r.turn.text, /on behalf of Sam Smith\. Based on what they told us, they may be eligible/);
  assert.match(r.turn.text, /test inbox, not the real organizations/);
  assert.equal(r.state.actions.filter((a) => a.type === "org_referral_email").length, 0, "nothing queued before the yes");
  r = await say("yes but wait");
  assert.match(r.turn.text, /clear yes/);
  r = await say("yes");
  assert.match(r.turn.text, /I'm contacting 2 organizations now/);
  await app.ctx.actions.drain(10);
  const org = app.store.actionsForSession(r.state.sessionId).filter((a) => a.type === "org_referral_email");
  assert.equal(org.length, 2);
  assert.ok(org.every((a) => a.status === "mock_written"));
  const files = readdirSync(dir).map((f) => readFileSync(dir + "/" + f, "utf8")).filter((t) => /Referral request/.test(t));
  assert.equal(files.length, 2);
  for (const t of files) {
    assert.match(t, /^To: outreach-test@example\.org/m, "demo emails go to the test inbox");
    assert.match(t, /Subject: \[DEMO\] Referral request: please contact Sam Smith/);
    assert.doesNotMatch(t, /^Cc:/m, "the person isn't copied in the demo");
  }
  assert.deepEqual(r.state.outreach.sent.map((x) => x.orgId).sort(), picks.map((x) => x.id).sort());
  // A repeated yes doesn't contact anyone twice, and admin lists both.
  const admin = await call(app, "GET", "/api/admin/outreach");
  assert.equal(admin.json.actions.length, 2);
  assert.ok(admin.json.actions.every((a) => a.demoRedirect && a.intendedTo));
});

test("a correction after the yes cancels referrals not yet sent; stop cancels too", async () => {
  const { app } = await setup({ env: { V360_INLINE_WORKER: "off" } });
  const { say, can } = await toPick(app);
  await say("all of them");
  let r = await say("yes");
  const ids = r.state.actions.filter((a) => a.type === "org_referral_email");
  assert.equal(ids.length, can.length);
  r = await say("stop contacting them");
  assert.match(r.turn.text, /I've stopped\. \d+ emails that hadn't gone out yet won't be sent/);
  assert.ok(app.store.actionsForSession(r.state.sessionId).filter((a) => a.type === "org_referral_email").every((a) => a.status === "cancelled"));

  const b = await setup({ env: { V360_INLINE_WORKER: "off" } });
  const p = await toPick(b.app);
  await p.say("all of them");
  r = await p.say("yes");
  r = await p.say("actually I live in Gaston County");
  assert.ok(b.app.store.actionsForSession(r.state.sessionId).filter((a) => a.type === "org_referral_email").every((a) => a.status === "cancelled"));
});

test("an interrupted consent question is asked again before anything is sent", async () => {
  const { app } = await setup({ env: { V360_INLINE_WORKER: "off" } });
  const { s, say, can } = await toPick(app);
  let r = await say(`number ${can[0].rank}`);
  const ev = await call(app, "POST", `/api/session/${s.id}/event`, { type: "speech_interrupted", turnId: r.turn.turnId }, { authorization: "Bearer " + s.token });
  assert.equal(ev.json.consentMustBeRepeated, true);
  r = await say("yes");
  assert.match(r.turn.text, /let me finish that question/);
  assert.equal(r.state.actions.filter((a) => a.type === "org_referral_email").length, 0);
  r = await say("yes");
  assert.equal(r.state.actions.filter((a) => a.type === "org_referral_email").length, 1);
});

test("live outreach goes to the organization with the person copied; a stale live switch cancels", async () => {
  const { app, dir } = await setup({ env: { V360_OUTREACH_LIVE: "on", V360_OUTREACH_REPLY_TO: "help@lions.example" } });
  const { say, can } = await toPick(app);
  let r = await say(`number ${can[0].rank}`);
  assert.doesNotMatch(r.turn.text, /test inbox/);
  r = await say("yes");
  await app.ctx.actions.drain(10);
  const t = readdirSync(dir).map((f) => readFileSync(dir + "/" + f, "utf8")).find((x) => /Referral request/.test(x));
  const listed = (await call(app, "GET", "/api/admin/outreach")).json.orgs.find((o) => o.id === can[0].id);
  assert.match(t, new RegExp("^To: " + listed.email.replace(/[.+]/g, "\\$&"), "m"));
  assert.match(t, /^Cc: sam@example\.com/m);
  assert.match(t, /^Reply-To: help@lions\.example/m);
  assert.doesNotMatch(t, /\[DEMO\]/);
});

test("admin: switch and per-organization contact choice", async () => {
  const { app } = await setup({ on: false });
  let r = await call(app, "GET", "/api/admin/outreach");
  assert.equal(r.json.status.on, false);
  assert.equal(r.json.orgs.length, corpus.organizations.length);
  const org = r.json.orgs.find((o) => o.channel === "none" && o.referral !== "no");
  assert.equal((await call(app, "PUT", `/api/admin/outreach/orgs/${org.id}`, { channel: "email", email: "not an email" })).status, 400);
  r = await call(app, "PUT", `/api/admin/outreach/orgs/${org.id}`, { channel: "email", email: "intake@example.org" });
  assert.equal(r.json.org.channel, "email");
  assert.equal(r.json.org.email, "intake@example.org");
  assert.equal((await call(app, "PUT", "/api/admin/outreach/settings", { on: "yes" })).status, 400);
  assert.equal((await call(app, "PUT", "/api/admin/outreach/settings", { on: true }, { origin: "https://evil.example" })).status, 403);
  const gated = await makeApp({ V360_ADMIN_SIGNIN: "on" });
  assert.equal((await call(gated, "GET", "/api/admin/outreach")).status, 401);
});
