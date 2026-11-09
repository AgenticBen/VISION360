// New workflows (admin or MCP), their first publish adding them to the
// registry, and deleting (retiring) a workflow.
import test from "node:test";
import assert from "node:assert/strict";
import { makeApp, call } from "./helpers.mjs";

test("create a form workflow, edit its draft, publish: it joins the registry", async () => {
  const app = await makeApp();
  let r = await call(app, "POST", "/api/flows", { id: "Bad Id", title: "x" });
  assert.equal(r.status, 400);
  r = await call(app, "POST", "/api/flows", { id: "referral", title: "x" });
  assert.equal(r.status, 409);
  r = await call(app, "POST", "/api/flows", { id: "spring-workshop", title: "Spring workshop sign-up" });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.status, "draft");
  assert.equal(r.json.checks.ok, true, JSON.stringify(r.json.checks.errors));
  r = await call(app, "GET", "/api/flows");
  const card = r.json.flows.find((f) => f.id === "spring-workshop");
  assert.equal(card.status, "draft");
  assert.equal(card.url, null, "no public link before it's published");
  assert.equal(card.questions, 1);
  // Add a question to the draft and publish.
  const got = await call(app, "GET", "/api/flows/spring-workshop");
  const flow = got.json.draft.flow;
  flow.questions.push({ id: "phone", type: "phone", required: true, prompt_screen: "Best phone number?", prompt_voice: "What's the best phone number?", options: [] });
  flow.blocks[0].questions.push("phone");
  r = await call(app, "PUT", "/api/flows/spring-workshop/draft", { flow, draftRevision: got.json.draft.draftRevision });
  assert.equal(r.status, 200);
  r = await call(app, "POST", "/api/flows/spring-workshop/publish", { name: "Test", note: "first" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.version, 1);
  const reg = JSON.parse((await app.ctx.gh.readText("main", "site/data/flows/index.json")).text);
  const entry = reg.flows.find((f) => f.id === "spring-workshop");
  assert.equal(entry.status, "published");
  assert.equal(entry.routing, false);
  const file = JSON.parse((await app.ctx.gh.readText("main", "site/data/flows/spring-workshop.json")).text);
  assert.equal(file.questions.length, 2);
  assert.equal(file.version, 1);
  r = await call(app, "GET", "/api/flows");
  assert.equal(r.json.flows.find((f) => f.id === "spring-workshop").status, "published");
});

test("new workflows go in a row: Resource Assistant by default, a copy keeps its source's row", async () => {
  const app = await makeApp();
  let r = await call(app, "POST", "/api/flows", { id: "eye-check", title: "Eye check", group: "assessment" });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  r = await call(app, "POST", "/api/flows", { id: "assess-copy", title: "Assessment copy", copyFrom: "vision-assessment" });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  r = await call(app, "POST", "/api/flows", { id: "plain-form", title: "Plain form" });
  r = await call(app, "POST", "/api/flows", { id: "odd-row", title: "x", group: "elsewhere" });
  assert.equal(r.status, 400);
  r = await call(app, "GET", "/api/flows");
  const g = Object.fromEntries(r.json.flows.map((f) => [f.id, f.group]));
  assert.deepEqual(g, { referral: "assistant", "v360-interest": "assistant", "vision-assessment": "assessment", "eye-check": "assessment", "assess-copy": "assessment", "plain-form": "assistant" });
});

test("copy an existing form; the referral finder can't be copied; reserved ids refused", async () => {
  const app = await makeApp();
  let r = await call(app, "POST", "/api/flows", { id: "interest-copy", title: "Interest copy", copyFrom: "v360-interest" });
  assert.equal(r.status, 201);
  const g = await call(app, "GET", "/api/flows/interest-copy");
  assert.equal(g.json.draft.flow.questions.length, 21);
  r = await call(app, "POST", "/api/flows", { id: "ref-copy", title: "x", copyFrom: "referral" });
  assert.equal(r.status, 400);
  const flow = g.json.draft.flow;
  flow.questions[0].id = "county"; flow.blocks[0].questions[0] = "county";
  r = await call(app, "POST", "/api/flows/interest-copy/check", { flow });
  assert.ok(r.json.checks.errors.some((e) => /reserved/.test(e.message)));
});

test("delete: needs DELETE; refuses referral and the workflow live in each row; a published one is retired, a draft removed", async () => {
  const app = await makeApp();
  let r = await call(app, "DELETE", "/api/flows/v360-interest", { confirm: "delete" });
  assert.equal(r.status, 400);
  r = await call(app, "DELETE", "/api/flows/referral", { confirm: "DELETE" });
  assert.equal(r.status, 400);
  // The Vision Assessment conversation stays protected even while the test is live.
  await call(app, "PUT", "/api/admin/settings", { assessment: "live-test" });
  r = await call(app, "DELETE", "/api/flows/vision-assessment", { confirm: "DELETE" });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /live on the public site/);
  r = await call(app, "DELETE", "/api/flows/v360-interest", { confirm: "DELETE", name: "Test" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const reg = JSON.parse((await app.ctx.gh.readText("main", "site/data/flows/index.json")).text);
  assert.equal(reg.flows.find((f) => f.id === "v360-interest").status, "retired");
  assert.ok((await app.ctx.gh.readText("main", "site/data/flows/v360-interest.json")), "file kept for old conversations");
  r = await call(app, "GET", "/api/flows");
  assert.ok(!r.json.flows.some((f) => f.id === "v360-interest"));
  await call(app, "POST", "/api/flows", { id: "temp-form", title: "Temp" });
  r = await call(app, "DELETE", "/api/flows/temp-form", { confirm: "DELETE" });
  assert.equal(r.json.state, "removed");
  r = await call(app, "GET", "/api/flows");
  assert.ok(!r.json.flows.some((f) => f.id === "temp-form"));
});

test("the workflows list shows each row's live one, what can go live, and links and QR codes for published ones", async () => {
  const app = await makeApp();
  let r = await call(app, "GET", "/api/flows");
  assert.deepEqual({ a: r.json.rows.assistant.live, b: r.json.rows.assessment.live, url: r.json.rows.assessment.test.url }, { a: "referral", b: "vision-assessment", url: "/assessment/" });
  const by = Object.fromEntries(r.json.flows.map((f) => [f.id, f]));
  assert.deepEqual([by.referral.onSite, by["v360-interest"].onSite, by["vision-assessment"].onSite], [true, false, true]);
  assert.deepEqual([by.referral.canGoLive, by["v360-interest"].canGoLive, by["vision-assessment"].canGoLive], [true, false, true]);
  await call(app, "PUT", "/api/admin/settings", { assessment: "live-test" });
  r = await call(app, "GET", "/api/flows");
  assert.equal(r.json.rows.assessment.live, "live-test");
  assert.equal(r.json.flows.find((f) => f.id === "vision-assessment").onSite, false);
  const ref = r.json.flows.find((f) => f.id === "referral");
  assert.equal(ref.main, true);
  assert.equal(ref.url, "http://localhost:8360/f/referral");
  assert.equal(ref.qr, "/api/qr/referral.svg");
  assert.equal(r.json.flows.find((f) => f.id === "v360-interest").main, false);
});
