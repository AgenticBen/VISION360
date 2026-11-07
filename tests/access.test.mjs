// Access rules: the publish key, the start-up guard and same-site admin writes.
import test from "node:test";
import assert from "node:assert/strict";
import { accessRules } from "../server/lib/api.mjs";
import { makeApp, call } from "./helpers.mjs";

test("GitHub connected without the key: every write and publish is off", () => {
  const a = accessRules({}, { kind: "github" });
  assert.equal(a.publishing, "off");
  assert.equal(a.writesAllowed, false);
  assert.equal(a.publishAllowed, false);
  assert.match(a.note, /V360_MCP_KEY/);
  const b = accessRules({ V360_MCP_KEY: "k" }, { kind: "github" });
  assert.deepEqual([b.publishing, b.writesAllowed, b.publishAllowed, b.keyRequired], ["on", true, true, true]);
});

test("hosted without GitHub: drafts save, publishing is refused", () => {
  const a = accessRules({ V360_SERVERLESS: "1" }, { kind: "local" });
  assert.deepEqual([a.publishing, a.writesAllowed, a.publishAllowed], ["off", true, false]);
});

test("health reports publishing state and store kinds", async () => {
  const app = await makeApp();
  const r = await call(app, "GET", "/api/health");
  assert.equal(r.json.publishing, "local");
  assert.equal(r.json.stores.content, "local");
});

test("admin writes need a same-site Origin; a missing Origin is refused", async () => {
  const app = await makeApp();
  const bad = await call(app, "POST", "/api/requests", { kind: "content", body: "x", page_path: "/admin/" }, { origin: undefined });
  assert.equal(bad.status, 403);
  const other = await call(app, "POST", "/api/requests", { kind: "content", body: "x", page_path: "/admin/" }, { origin: "https://evil.example" });
  assert.equal(other.status, 403);
  const ok = await call(app, "POST", "/api/requests", { kind: "content", body: "Change the welcome", page_path: "/admin/" });
  assert.equal(ok.status, 201);
});

test("with a key set, publish needs the x-v360-key header", async () => {
  const app = await makeApp({ V360_MCP_KEY: "secret-key" });
  const r = await call(app, "GET", "/api/flows/referral");
  const flow = r.json.draft ? r.json.draft.flow : r.json.published;
  flow.questions[0].prompt = flow.questions[0].prompt + " ";
  const saved = await call(app, "PUT", "/api/flows/referral/draft", { flow, draftRevision: r.json.draft ? r.json.draft.draftRevision : 0 });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const no = await call(app, "POST", "/api/flows/referral/publish", { name: "T", note: "n" });
  assert.equal(no.status, 401);
  assert.equal(no.json.code, "publish_key");
  const wrong = await call(app, "POST", "/api/flows/referral/publish", { name: "T", note: "n" }, { "x-v360-key": "nope" });
  assert.equal(wrong.status, 401);
  const yes = await call(app, "POST", "/api/flows/referral/publish", { name: "T", note: "n" }, { "x-v360-key": "secret-key" });
  assert.equal(yes.status, 200, JSON.stringify(yes.json));
});

test("the connector key also works as ?key= in the connector URL", async () => {
  const app = await makeApp({ V360_MCP_KEY: "secret-key" });
  const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  assert.equal((await call(app, "POST", "/api/mcp", body)).status, 401);
  assert.equal((await call(app, "POST", "/api/mcp?key=wrong", body)).status, 401);
  const ok = await call(app, "POST", "/api/mcp?key=secret-key", body);
  assert.equal(ok.status, 200);
  assert.ok(ok.json.result.tools.length > 10);
});

test("a publishable Supabase key is refused and reported, not used", async () => {
  const { supabaseConfigured, supabaseKeyProblem } = await import("../server/lib/supabase-sessions.mjs");
  const env = { V360_SUPABASE_URL: "https://x.supabase.co", V360_SUPABASE_SERVICE_KEY: "sb_publishable_abc" };
  assert.equal(supabaseConfigured(env), false);
  assert.match(supabaseKeyProblem(env), /secret key/);
  const app = await makeApp(env);
  const h = await call(app, "GET", "/api/health");
  assert.equal(h.json.stores.sessions, "local");
  assert.match(h.json.storeProblem, /publishable/);
});
