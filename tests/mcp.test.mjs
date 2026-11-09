// The VISION360 MCP connector (Streamable HTTP, JSON responses).
import test from "node:test";
import assert from "node:assert/strict";
import { makeApp, call } from "./helpers.mjs";
import { TOOL_NAMES } from "../server/lib/mcp.mjs";

const rpc = (app, method, params, id = 1, headers) => call(app, "POST", "/api/mcp", { jsonrpc: "2.0", id, method, params }, headers);
const tool = async (app, name, args) => {
  const r = await rpc(app, "tools/call", { name, arguments: args });
  assert.equal(r.status, 200);
  const res = r.json.result;
  return { ...res, data: res.isError ? null : JSON.parse(res.content[0].text) };
};

test("handshake, notifications, tool list and method errors", async () => {
  const app = await makeApp();
  let r = await rpc(app, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(r.json.result.protocolVersion, "2025-06-18");
  assert.equal(r.json.result.serverInfo.name, "vision360");
  assert.match(r.json.result.instructions, /publish_draft/);
  r = await call(app, "POST", "/api/mcp", { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(r.status, 202);
  r = await rpc(app, "tools/list", {});
  assert.deepEqual(r.json.result.tools.map((t) => t.name), TOOL_NAMES);
  for (const t of r.json.result.tools) assert.equal(t.inputSchema.type, "object", t.name);
  r = await rpc(app, "resources/list", {});
  assert.deepEqual(r.json.result.resources, []);
  r = await rpc(app, "prompts/list", {});
  assert.deepEqual(r.json.result.prompts, []);
  r = await rpc(app, "nope", {});
  assert.equal(r.json.error.code, -32601);
  r = await call(app, "GET", "/api/mcp");
  assert.equal(r.status, 405);
});

test("Claude can edit a draft, check it, publish it and close a request into the change log", async () => {
  const app = await makeApp();
  let t = await tool(app, "list_workflows", {});
  assert.equal(t.data.length, 3);
  t = await tool(app, "add_question", { flow: "v360-interest", section: "interest", after: "student", type: "yes_no", prompt_screen: "Do you use a screen magnifier?" });
  assert.equal(t.isError, false, t.content[0].text);
  const id = t.data.id;
  assert.ok(t.data.checks.ok, JSON.stringify(t.data.checks.errors));
  t = await tool(app, "set_follow_up", { flow: "v360-interest", id, parent: "blind_low_vision", answers: ["yes", "not_sure"] });
  assert.deepEqual(t.data.askedIf, { q: "blind_low_vision", in: ["yes", "not_sure"] });
  t = await tool(app, "update_question", { flow: "v360-interest", id, changes: { help: "Built-in or an app both count." } });
  assert.equal(t.isError, false);
  t = await tool(app, "get_workflow", { flow: "v360-interest" });
  assert.equal(t.data.isDraft, true);
  assert.ok(t.data.workflow.questions.some((q) => q.id === id));
  t = await tool(app, "check_draft", { flow: "v360-interest" });
  assert.ok(t.data.checks.ok);
  t = await tool(app, "publish_draft", { flow: "v360-interest", note: "Ask about magnifiers" });
  assert.equal(t.data.version, 2);
  t = await tool(app, "set_effect", { flow: "v360-interest", question: id, answer: "yes", target_type: "org", target: "x", op: "raise", weight: 10, because: "x", evidence_org: "x", evidence_condition: "x" });
  assert.equal(t.data.checks.ok, false, "effects aren't allowed on the interest form");

  const req = await call(app, "POST", "/api/requests", { kind: "content", body: "Add a magnifier question", page_path: "/admin/workflows/" });
  t = await tool(app, "list_requests", {});
  assert.equal(t.data[0].id, req.json.request.id);
  t = await tool(app, "set_request_status", { id: req.json.request.id, status: "done" });
  assert.equal(t.isError, true, "done needs a summary");
  t = await tool(app, "set_request_status", { id: req.json.request.id, status: "done", summary: "Added a magnifier follow-up to the interest form (v2)." });
  assert.equal(t.data.status, "done");
  const log = await call(app, "GET", "/api/changelog");
  assert.ok(log.json.entries.some((e) => /magnifier/.test(e.title)));
  t = await tool(app, "find_organizations", { query: "veterans" });
  assert.ok(t.data.length > 0 && t.data[0].verifiedConditions);
  t = await tool(app, "get_dashboard", {});
  assert.ok("usage" in t.data);
});

test("kill switch and connector key", async () => {
  const off = await makeApp({ V360_FLOW_EDITS: "off" });
  let t = await tool(off, "add_question", { flow: "v360-interest", section: "interest", type: "text", prompt_screen: "x" });
  assert.equal(t.isError, true);
  t = await tool(off, "list_workflows", {});
  assert.equal(t.isError, false, "reading still works");
  const keyed = await makeApp({ V360_MCP_KEY: "secret-123" });
  let r = await rpc(keyed, "tools/list", {});
  // 403, not 401: a 401 makes Claude look for a sign-in flow this connector
  // doesn't have and leaves the connector stuck on "Reconnect".
  assert.equal(r.status, 403);
  r = await rpc(keyed, "tools/list", {}, 1, { "x-v360-key": "wrong" });
  assert.equal(r.status, 403);
  r = await rpc(keyed, "tools/list", {}, 1, { "x-v360-key": "secret-123" });
  assert.equal(r.status, 200);
  r = await rpc(keyed, "tools/list", {}, 1, { authorization: "Bearer secret-123" });
  assert.equal(r.status, 200);
});

test("a stray Authorization header does not hide a correct ?key= in the connector URL", async () => {
  const keyed = await makeApp({ V360_MCP_KEY: "secret-123" });
  const r = await call(keyed, "POST", "/api/mcp?key=secret-123", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { authorization: "Bearer some-other-token" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.result.tools.length > 0);
});

test("build a new workflow over MCP: create, sections, questions, check, publish, links, main, conversations, delete", async () => {
  const app = await makeApp();
  let t = await tool(app, "create_workflow", { id: "spring-workshop", title: "Spring workshop sign-up", description: "RSVPs for the April workshop" });
  assert.equal(t.isError, false, JSON.stringify(t));
  assert.equal(t.data.status, "draft");
  t = await tool(app, "add_section", { flow: "spring-workshop", title: "Your visit", intro_voice: "Now a couple of questions about your visit." });
  const sec = t.data.section;
  t = await tool(app, "add_question", { flow: "spring-workshop", section: sec, type: "date", prompt_screen: "Which day would you like to come?", required: true });
  assert.equal(t.data.checks.ok, true, JSON.stringify(t.data.checks.errors));
  t = await tool(app, "add_question", { flow: "spring-workshop", section: sec, type: "single", prompt_screen: "Morning or afternoon?", options: ["Morning", "Afternoon"] });
  t = await tool(app, "update_section", { flow: "spring-workshop", id: sec, title: "Your visit day" });
  assert.equal(t.isError, false);
  t = await tool(app, "update_section", { flow: "spring-workshop", id: sec, remove: true });
  assert.equal(t.isError, true, "a section with questions can't be removed");
  t = await tool(app, "check_draft", { flow: "spring-workshop" });
  assert.equal(t.data.checks.ok, true);
  t = await tool(app, "get_share_links", { flow: "spring-workshop" });
  assert.equal(t.data.workflows[0].live, false);
  t = await tool(app, "publish_draft", { flow: "spring-workshop", note: "First version" });
  assert.equal(t.isError, false, JSON.stringify(t));
  assert.equal(t.data.version, 1);
  t = await tool(app, "list_workflows", {});
  assert.equal(t.data.find((f) => f.id === "spring-workshop").status, "published");
  // Links for the live workflows, and the main site.
  t = await tool(app, "get_share_links", {});
  assert.equal(t.data.mainFlow, "referral");
  const interest = t.data.workflows.find((f) => f.id === "v360-interest");
  assert.equal(interest.url, "http://localhost:8360/f/v360-interest");
  assert.equal(interest.qr_svg, "http://localhost:8360/api/qr/v360-interest.svg");
  assert.match(interest.flyer, /\/admin\/workflows\/flyer\/\?flow=v360-interest$/);
  t = await tool(app, "set_main_workflow", { flow: "nope" });
  assert.equal(t.isError, true);
  t = await tool(app, "set_main_workflow", { flow: "v360-interest" });
  assert.equal(t.isError, true, "a form keeps its own link; it can't run as the Resource Assistant");
  t = await tool(app, "set_main_workflow", { flow: "live-test" });
  assert.equal(t.isError, true, "only Ben makes the full-screen test live");
  t = await tool(app, "set_main_workflow", { flow: "vision-assessment" });
  assert.equal(t.isError, false, JSON.stringify(t));
  assert.equal(t.data.live, "vision-assessment");
  t = await tool(app, "get_share_links", {});
  assert.deepEqual(t.data.live, { resourceAssistant: "referral", visionAssessment: "vision-assessment" });
  assert.equal(t.data.workflows.find((f) => f.id === "vision-assessment").liveInRow, true);
  // Conversations: none have started on the new workflow yet.
  await call(app, "POST", "/api/session", { noticeAccepted: true, mode: "text", flow: "v360-interest" });
  t = await tool(app, "list_conversations", { flow: "v360-interest" });
  assert.equal(t.data.total, 1);
  assert.equal(t.data.conversations[0].workflow, "V360 TECH interest form");
  // Delete needs the word, and a workflow that's live in its row is protected.
  t = await tool(app, "delete_workflow", { flow: "vision-assessment", confirm: "DELETE" });
  assert.equal(t.isError, true);
  t = await tool(app, "delete_workflow", { flow: "spring-workshop", confirm: "yes" });
  assert.equal(t.isError, true);
  t = await tool(app, "delete_workflow", { flow: "spring-workshop", confirm: "DELETE", reason: "test" });
  assert.equal(t.isError, false, JSON.stringify(t));
});
