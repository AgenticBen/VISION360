// Workflows: checks, drafts, impact preview, publish and revert (offline store).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkFlow } from "../server/lib/flow-check.mjs";
import { makeApp, call } from "./helpers.mjs";

const orgs = JSON.parse(readFileSync(new URL("../site/data/organizations.json", import.meta.url)));
const referral = () => JSON.parse(readFileSync(new URL("../site/data/assessment.json", import.meta.url)));
const interest = () => JSON.parse(readFileSync(new URL("../site/data/flows/v360-interest.json", import.meta.url)));
const msgs = (r) => r.errors.map((e) => e.message).join(" | ");

test("both shipped workflows pass their checks", () => {
  assert.ok(checkFlow(referral(), { organizations: orgs, routing: true }).ok);
  const r = checkFlow(interest(), { organizations: orgs, routing: false });
  assert.ok(r.ok, msgs(r));
  assert.equal(r.stats.questions, 21);
  assert.equal(r.stats.followUps, 1);
});

test("checks catch loops, forward references, bad organizations, duplicate answers and stray effects", () => {
  const a = referral();
  a.questions.find((q) => q.id === "veteran").ask_if = { q: "discharge", in: ["honorable"] };
  assert.match(msgs(checkFlow(a, { organizations: orgs })), /isn't asked earlier/);

  const b = referral();
  b.questions[0].options[0].effects[0].id = "no-such-org";
  assert.match(msgs(checkFlow(b, { organizations: orgs })), /doesn't exist: "no-such-org"/);

  const c = referral();
  c.questions[0].options[1].value = c.questions[0].options[0].value;
  assert.match(msgs(checkFlow(c, { organizations: orgs })), /two answers with the value/);

  const d = referral();
  d.questions[0].options[0].effects[0].evidence = { org_id: "x", branch_condition: "made up" };
  assert.match(msgs(checkFlow(d, { organizations: orgs })), /verified referral condition/);

  const e = interest();
  e.questions.find((q) => q.id === "student").options[0].effects = [{ op: "boost", target: "org", id: orgs[0].id, weight: 10, because: "x" }];
  assert.match(msgs(checkFlow(e, { organizations: orgs, routing: false })), /doesn't rank services/);

  const f = interest();
  f.blocks[0].questions.push("ghost");
  assert.match(msgs(checkFlow(f, { organizations: orgs, routing: false })), /doesn't exist: "ghost"/);
});

test("workflow API: draft with revision guard, impact preview, publish, version log, revert, change log", async () => {
  const app = await makeApp();
  let r = await call(app, "GET", "/api/flows");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.flows.map((f) => f.id), ["referral", "v360-interest"]);
  assert.equal(r.json.flows[0].version, 1);

  r = await call(app, "GET", "/api/flows/referral");
  assert.equal(r.json.draft, null);
  const flow = r.json.published;
  // Change wording and drop the veteran effect weights to zero-ish to move routing.
  flow.questions.find((q) => q.id === "county").prompt_screen = "Which county does the person live in?";
  const vet = flow.questions.find((q) => q.id === "veteran");
  vet.options.find((o) => o.value === "yes").effects = [];

  r = await call(app, "PUT", "/api/flows/referral/draft", { flow, draftRevision: 0, author: "Tester" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.draftRevision, 1);
  assert.ok(r.json.checks.ok);
  r = await call(app, "PUT", "/api/flows/referral/draft", { flow, draftRevision: 0, author: "Someone else" });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "stale");

  r = await call(app, "POST", "/api/flows/referral/check", {});
  assert.ok(r.json.checks.ok);
  assert.ok(r.json.impact.personas >= 1);

  r = await call(app, "POST", "/api/flows/referral/publish", { name: "Tester", note: "Clearer county question" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.version, 2);

  // The commit carried the flow, the lock and the golden expectations together.
  const commits = JSON.parse(readFileSync(app.ctx.gh.root ? app.ctx.gh.root + "/commits.json" : process.env.TMPDIR + "/none", "utf8"));
  const pub = commits.filter((c) => c.branch === "main").pop();
  assert.deepEqual(Object.keys(pub.files).sort(), ["data/corpus.lock.json", "site/data/assessment.json", "tests/fixtures/golden-personas.json"]);
  assert.match(pub.message, /Published by Tester/);
  const lock = JSON.parse(pub.files["data/corpus.lock.json"]);
  assert.equal(lock.counts.questions, 19);

  r = await call(app, "GET", "/api/flows/referral");
  assert.equal(r.json.version, 2);
  assert.equal(r.json.draft, null, "publishing clears the draft");
  assert.equal(r.json.published.questions.find((q) => q.id === "county").prompt_screen, "Which county does the person live in?");
  assert.deepEqual(r.json.versions.map((v) => v.version), [2, 1]);

  r = await call(app, "POST", "/api/flows/referral/revert", { version: 1, name: "Tester" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.version, 3);
  r = await call(app, "GET", "/api/flows/referral");
  assert.notEqual(r.json.published.questions.find((q) => q.id === "county").prompt_screen, "Which county does the person live in?");

  r = await call(app, "GET", "/api/changelog");
  assert.match(r.json.entries[0].title, /reverted to v1/);
  assert.equal(r.json.entries[1].kind, "workflow");
});

test("publishing is refused when checks fail, and when editing is switched off", async () => {
  const app = await makeApp();
  const flow = interest();
  flow.questions[0].type = "nonsense";
  let r = await call(app, "PUT", "/api/flows/v360-interest/draft", { flow, author: "T" });
  assert.equal(r.json.checks.ok, false);
  r = await call(app, "POST", "/api/flows/v360-interest/publish", { name: "T" });
  assert.equal(r.status, 422);
  assert.equal(r.json.code, "checks_failed");
  const off = await makeApp({ V360_FLOW_EDITS: "off" });
  r = await call(off, "PUT", "/api/flows/v360-interest/draft", { flow: interest() });
  assert.equal(r.status, 403);
});

test("a question added only in the data is recapped by its label and corrected by its topic words", async () => {
  const { mentionedTopics } = await import("../server/lib/understand.mjs");
  const { screenLabel, noConcernTopic, sectionIntro } = await import("../server/lib/phrasing.mjs");
  const a = referral();
  const q = { id: "pets", domain: "everyday", type: "yes_no", prompt_screen: "Do you have a guide dog or a pet?", prompt_voice: "Do you have a pet?", recap_label: "Has a pet", topic_words: ["pet", "guide dog"], help: null, sensitive: false, skippable: true, ask_if: null,
    options: [{ value: "yes", label_screen: "Yes", label_voice: "yes", aliases: ["yes"], effects: [] }, { value: "no", label_screen: "No", label_voice: "no", aliases: ["no"], effects: [], no_concern: true }], no_concern_topic: "pets" };
  a.questions.push(q);
  a.blocks.find((b) => b.id === "everyday").questions.push("pets");
  assert.ok(checkFlow(a, { organizations: orgs }).ok, msgs(checkFlow(a, { organizations: orgs })));
  assert.deepEqual(mentionedTopics("actually I do have a guide dog", ["pets", "county"], a), ["pets"]);
  assert.equal(screenLabel(q, { self: true }, q.recap_label), "Has a pet");
  assert.equal(noConcernTopic({ questionId: "pets", kind: "answer", value: "no" }, q), "pets");
  assert.equal(sectionIntro({ id: "x", intro_voice: "" }, {}), "");
  assert.equal(sectionIntro({ id: "x" }, {}), null);
  delete q.recap_label;
  assert.match(msgs(checkFlow(a, { organizations: orgs })), /needs a recap label/);
});
