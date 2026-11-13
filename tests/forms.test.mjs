// Filling organizations' online forms for the person: recipe rules, bot-check
// detection, the practice form in demo mode, and every fallback (email, then
// a staff task with the answers ready). A fake browser stands in for the
// Vercel Sandbox VM.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { createApp } from "../server/lib/api.mjs";
import { openStore } from "../server/lib/store.mjs";
import { call, startSession, talker } from "./helpers.mjs";
import { validateRecipe, testFormRecipe, TEST_FORM_ID, formValues } from "../server/lib/form-recipes.mjs";
import { detectBlocker } from "../runner/detect.mjs";
import { singleEmail } from "../server/lib/outreach-directory.mjs";

const ANSWERS = { actor: "myself", county: "Mecklenburg", goals: "technology", age_band: "I'm 67", hearing_loss: "no", eye_doctor: "yes", eye_exam_recency: "within the last year", insurance: "Medicare", veteran: "no" };

function fakeBrowser(outcome = "submitted") {
  const jobs = [];
  return {
    jobs,
    outcome,
    async run(job, opts) {
      jobs.push({ job, opts });
      if (job.mode === "inspect") return { outcome: "inspected", fieldsHash: "fields-v1", fields: [{ selector: "#name", kind: "text", label: "Name" }] };
      if (job.mode === "dry") return { outcome: "dry_run_ok", screenshot: "" };
      return typeof this.outcome === "function" ? this.outcome(job) : { outcome: this.outcome, detail: this.outcome === "blocked" ? "the page uses reCAPTCHA" : undefined };
    },
  };
}

let n = 0;
async function setup(env = {}) {
  const tmp = process.env.TMPDIR || "/tmp";
  const dir = `${tmp}/v360-forms-${process.pid}-${++n}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir + "/outbox", { recursive: true });
  const browser = fakeBrowser();
  const app = await createApp({ store: openStore(":memory:"), formRunnerClient: browser, env: { V360_OUTBOX_DIR: dir + "/outbox", V360_ADMIN_STORE_DIR: dir + "/admin", V360_ADMIN_SIGNIN: "off", ...env } });
  assert.equal((await call(app, "PUT", "/api/admin/outreach/settings", { on: true })).status, 200);
  return { app, browser, outbox: dir + "/outbox" };
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

// A recipe for the organization, inspected and approved (for testing, or for real).
async function approveRecipe(app, org, { live = false } = {}) {
  const recipe = { url: "https://forms.example.org/refer", allowDomains: ["forms.example.org"], fields: [{ selector: "#name", kind: "text", label: "Name", source: "person.fullName", required: true }, { selector: "#phone", kind: "tel", label: "Phone", source: "person.phone" }], submit: { selector: "#go" }, success: { textIncludes: "Thanks" } };
  let r = await call(app, "PUT", `/api/admin/outreach/recipes/${org.id}`, recipe);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((await call(app, "POST", `/api/admin/outreach/recipes/${org.id}/status`, { status: "test_approved", confirm: "APPROVE" })).status, 400, "needs inspecting first");
  r = await call(app, "POST", `/api/admin/outreach/recipes/${org.id}/inspect`, { url: recipe.url });
  assert.equal(r.json.outcome, "inspected");
  assert.equal((await call(app, "POST", `/api/admin/outreach/recipes/${org.id}/status`, { status: "test_approved" })).status, 400, "approval needs APPROVE typed");
  r = await call(app, "POST", `/api/admin/outreach/recipes/${org.id}/status`, { status: "test_approved", confirm: "APPROVE" });
  assert.equal(r.json.recipe.status, "test_approved");
  if (live) {
    r = await call(app, "POST", `/api/admin/outreach/recipes/${org.id}/status`, { status: "live_approved", confirm: "APPROVE" });
    assert.equal(r.json.recipe.status, "live_approved");
  }
}

// Results -> contact offer -> details -> pick the form organization -> consent.
async function toFormConsent(app, { withEmail = true, live = false } = {}) {
  const { s, say, r: res } = await toResults(app);
  const org = res.state.results.matches.find((m) => m.contacts.intake_form_url && m.thirdPartyReferral !== "no" && (withEmail || !singleEmail(m.contacts.general_email)));
  assert.ok(org, "a suggestion with an online form");
  await call(app, "PUT", `/api/admin/outreach/orgs/${org.id}`, withEmail ? { channel: "email", email: "intake@example.org" } : { channel: "auto" });
  if (!withEmail) assert.ok(!singleEmail(org.contacts.general_email), "this test needs an organization without a plain email");
  await approveRecipe(app, org, { live });
  await say("no thanks");
  await say("yes");
  await say("Sam Smith");
  await say("yes");
  await say("704 555 0100 and sam at example dot com");
  let r = await say("yes");
  const pick = r.turn.outreachPick.orgs.find((o) => o.id === org.id);
  assert.equal(pick.channel, "form");
  assert.match(r.turn.text, new RegExp(`number ${pick.rank}, [^,]+, through their online form`));
  r = await say(`number ${pick.rank}`);
  return { s, say, r, org };
}

const formActions = (app, id) => app.store.actionsForSession(id).filter((a) => a.type === "org_form_submit");
const emailActions = (app, id) => app.store.actionsForSession(id).filter((a) => a.type === "org_referral_email");

test("recipes only fill names, contact details and fixed wording, and never tick consent boxes", () => {
  assert.deepEqual(validateRecipe(testFormRecipe("https://vision360.agenticarc.ai")), []);
  const bad = { url: "http://x.org", allowDomains: [], fields: [{ selector: "#dx", kind: "text", label: "Diagnosis", source: "answers.diagnosis" }, { selector: "#t", kind: "checkbox", label: "I agree to the terms", source: "const:true" }], submit: {}, success: {} };
  const p = validateRecipe(bad).join(" ");
  assert.match(p, /must start with https/);
  assert.match(p, /"answers\.diagnosis" isn't something a recipe may fill in/);
  assert.match(p, /terms or consent boxes is the person's own decision/);
  assert.match(p, /which button submits/);
  assert.match(p, /how to tell the form went through/);
  assert.match(p, /allowDomains/);
  const v = formValues({ name: "Sam Smith", phone: "704-555-0100", email: "s@x.org" }, { name: "Org" });
  assert.equal(v["person.firstName"], "Sam");
  assert.equal(v["person.lastName"], "Smith");
  assert.match(v["note.referral"], /may be eligible/);
  assert.doesNotMatch(Object.values(v).join(" "), /qualif/i);
});

test("bot checks and refusals are spotted; the practice form only shows one when asked", () => {
  assert.match(detectBlocker({ html: '<div class="g-recaptcha" data-sitekey="x"></div>' }), /reCAPTCHA/);
  assert.match(detectBlocker({ html: '<script src="https://hcaptcha.com/1/api.js"></script>' }), /hCaptcha/);
  assert.match(detectBlocker({ html: '<div class="cf-turnstile"></div>' }), /Turnstile/);
  assert.match(detectBlocker({ html: "<title>Just a moment...</title>" }), /Cloudflare/);
  assert.match(detectBlocker({ html: "<p>Please verify you are human</p>" }), /human check/);
  assert.match(detectBlocker({ status: 403 }), /403/);
  assert.match(detectBlocker({ status: 429 }), /429/);
  assert.equal(detectBlocker({ html: "<form><input id=name></form>" }), null);
  assert.equal(detectBlocker({ html: readFileSync(new URL("../site/outreach-test-form/index.html", import.meta.url), "utf8") }), null);
});

test("demo: the person agrees, the practice form is filled (never the real one), and the backup email stays unsent", async () => {
  const { app, browser } = await setup();
  const { say, r: consent, org } = await toFormConsent(app);
  assert.match(consent.turn.text, /I'll fill in the online form for/);
  assert.match(consent.turn.text, /If a form doesn't work, I'll email them instead/);
  assert.match(consent.turn.text, /forms go to a practice form/);
  const r = await say("yes");
  const form = formActions(app, r.state.sessionId);
  assert.equal(form.length, 1);
  assert.equal(form[0].status, "mock_submitted");
  const fill = browser.jobs.find((j) => j.job.mode === "fill");
  assert.match(fill.job.url, /\/outreach-test-form\/$/, "demo runs fill our own practice form");
  assert.equal(fill.job.values["person.fullName"], "Sam Smith");
  assert.equal(fill.job.values["org.name"], org.name);
  assert.deepEqual(emailActions(app, r.state.sessionId).map((a) => a.status), ["prepared"], "the backup email isn't sent when the form works");
  const admin = await call(app, "GET", "/api/admin/outreach");
  assert.ok(admin.json.actions.some((a) => a.channel === "form" && a.status === "mock_submitted" && a.demoRedirect));
});

test("a bot check stops the form and the organization is emailed instead", async () => {
  const { app, browser, outbox } = await setup();
  browser.outcome = "blocked";
  const { say } = await toFormConsent(app);
  const r = await say("yes");
  assert.equal(formActions(app, r.state.sessionId)[0].status, "fell_back");
  await app.ctx.actions.drain(10);
  assert.deepEqual(emailActions(app, r.state.sessionId).map((a) => a.status), ["mock_written"]);
  assert.ok(readdirSync(outbox).some((f) => /Referral request/.test(readFileSync(outbox + "/" + f, "utf8"))));
});

test("with no email to fall back on, a staff member gets a task with the answers ready", async () => {
  const { app, browser } = await setup();
  browser.outcome = "page_changed";
  const ctx = await toFormConsent(app, { withEmail: false });
  assert.match(ctx.r.turn.text, /a Lions Services staff member will fill it in for you/);
  const r = await ctx.say("yes");
  assert.equal(formActions(app, r.state.sessionId)[0].status, "fell_back");
  const review = app.store.staffReviews(r.state.sessionId).find((x) => /couldn't fill/.test(x.reason));
  assert.ok(review, "staff task created");
  assert.equal(review.detail.fields.Name, "Sam Smith");
  assert.equal(review.contact.value, "704-555-0100");
});

test("a website timeout is retried; stop cancels a form not yet filled", async () => {
  const { app, browser } = await setup({ V360_INLINE_WORKER: "off" });
  browser.outcome = "timeout";
  const { say } = await toFormConsent(app);
  let r = await say("yes");
  await app.ctx.actions.drain(10);
  assert.equal(formActions(app, r.state.sessionId)[0].status, "retrying");

  const b = await setup({ V360_INLINE_WORKER: "off" });
  const c = await toFormConsent(b.app);
  r = await c.say("yes");
  r = await c.say("stop contacting them");
  assert.match(r.turn.text, /I've stopped/);
  assert.ok(b.app.store.actionsForSession(r.state.sessionId).filter((a) => a.type.startsWith("org_")).every((a) => a.status === "cancelled"));
});

test("live: the real form is filled from its approved recipe; a recipe changed after the yes isn't used", async () => {
  const { app, browser } = await setup({ V360_OUTREACH_LIVE: "on", V360_INLINE_WORKER: "off" });
  const { say, org } = await toFormConsent(app, { live: true });
  let r = await say("yes");
  const job = formActions(app, r.state.sessionId)[0];
  const payload = JSON.parse(app.store.getAction(job.id).payload_json);
  assert.equal(payload.recipeId, org.id);
  assert.equal(payload.demo, false);
  // Staff re-save the recipe before the job runs: the person agreed to the old one.
  await call(app, "PUT", `/api/admin/outreach/recipes/${org.id}`, { url: "https://forms.example.org/refer2", allowDomains: ["forms.example.org"], fields: [{ selector: "#n", kind: "text", source: "person.fullName" }], submit: { selector: "#go" }, success: { textIncludes: "ok" } });
  await app.ctx.actions.drain(10);
  assert.equal(app.store.getAction(job.id).status, "fell_back");
  assert.ok(!browser.jobs.some((j) => j.job.mode === "fill"), "no form was filled from a changed recipe");
});

test("the practice form records what it receives; the turn's worker never runs form jobs on the hosted site", async () => {
  const { app } = await setup();
  const r = await call(app, "POST", "/api/outreach/test-form", { full_name: "Sam Smith", intended_org: "Example Org" });
  assert.equal(r.json.message, "Referral received");
  const admin = await call(app, "GET", "/api/admin/outreach");
  assert.equal(admin.json.practice[0].detail.fullName, "Sam Smith");
  const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(vercel.functions["api/outreach.mjs"].maxDuration, 120);
  const rw = vercel.rewrites.map((x) => x.source);
  assert.ok(rw.indexOf("/api/session/:id/outreach/run") < rw.indexOf("/api/:path*"), "the form-run route is rewritten to the outreach function before the catch-all");
});

test("TEST_FORM_ID recipe is built in and always approved for testing", () => {
  const r = testFormRecipe("https://vision360.agenticarc.ai");
  assert.equal(r.orgId, TEST_FORM_ID);
  assert.equal(r.status, "test_approved");
  assert.deepEqual(r.allowDomains, ["vision360.agenticarc.ai"]);
});
