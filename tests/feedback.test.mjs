import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, call, startSession } from "./helpers.mjs";
import { createFeedbackStore, cleanFeedback } from "../server/lib/feedback-store.mjs";
import { feedbackMarkdown } from "../server/lib/feedback-md.mjs";
import { voicePhrases } from "../server/lib/phrases.mjs";

const bearer = (s) => ({ authorization: "Bearer " + s.token });

test("feedback needs the conversation's own token and works after it has ended", async () => {
  const app = await makeApp();
  const s = await startSession(app);
  let r = await call(app, "POST", `/api/session/${s.id}/feedback`, { text: "Hello" }, { authorization: "Bearer wrong" });
  assert.equal(r.status, 404);
  await call(app, "POST", `/api/session/${s.id}/end`, {}, bearer(s));
  r = await call(app, "POST", `/api/session/${s.id}/feedback`, { text: "It read everything back, which helped.", mode: "spoken_edited" }, bearer(s));
  assert.equal(r.status, 200);
  r = await call(app, "GET", "/api/admin/feedback");
  assert.equal(r.json.total, 1);
  assert.equal(r.json.items[0].tool, "assistant");
  assert.equal(r.json.items[0].mode, "spoken_edited");
});

test("text then rating update one row; bad ratings and long text are refused", async () => {
  const app = await makeApp();
  const s = await startSession(app);
  const url = `/api/session/${s.id}/feedback`;
  assert.equal((await call(app, "POST", url, { rating: 0 }, bearer(s))).status, 400);
  assert.equal((await call(app, "POST", url, { rating: 6 }, bearer(s))).status, 400);
  assert.equal((await call(app, "POST", url, { text: "x".repeat(4001) }, bearer(s))).status, 400);
  assert.equal((await call(app, "POST", url, {}, bearer(s))).status, 400);
  assert.equal((await call(app, "POST", url, { text: "Bigger buttons please", mode: "typed" }, bearer(s))).status, 200);
  assert.equal((await call(app, "POST", url, { rating: 4 }, bearer(s))).status, 200);
  const r = await call(app, "GET", "/api/admin/feedback");
  assert.equal(r.json.total, 1);
  assert.equal(r.json.items[0].text, "Bigger buttons please");
  assert.equal(r.json.items[0].rating, 4);
  assert.match(r.json.items[0].markdown, /★ 4\/5/);
});

test("skipping saves no feedback but counts toward the response rate", async () => {
  const app = await makeApp();
  const a = await startSession(app), b = await startSession(app);
  await call(app, "POST", `/api/session/${a.id}/feedback/skip`, {}, bearer(a));
  await call(app, "POST", `/api/session/${b.id}/feedback`, { text: "Great", rating: 5 }, bearer(b));
  const r = await call(app, "GET", "/api/admin/feedback");
  assert.equal(r.json.total, 1, "the skip isn't listed");
  assert.equal(r.json.stats.items, 1);
  assert.equal(r.json.stats.skipped, 1);
  assert.equal(r.json.stats.responseRate, 0.5);
  assert.equal(r.json.stats.averageRating, 5);
});

test("admin list: filters, Markdown export, sign-in, DELETE, and feedback outlives its conversation", async () => {
  const app = await makeApp();
  const a = await startSession(app);
  const f = await call(app, "POST", "/api/session", { noticeAccepted: true, mode: "text", flow: "vision-assessment" });
  const b = { id: f.json.sessionId, token: f.json.token };
  await call(app, "POST", `/api/session/${a.id}/feedback`, { text: "Assistant: clear and calm", rating: 5 }, bearer(a));
  await call(app, "POST", `/api/session/${b.id}/feedback`, { text: "Assessment: too many questions", rating: 2 }, bearer(b));

  let r = await call(app, "GET", "/api/admin/feedback?tool=assessment");
  assert.deepEqual(r.json.items.map((x) => x.text), ["Assessment: too many questions"]);
  r = await call(app, "GET", "/api/admin/feedback?rating=5");
  assert.deepEqual(r.json.items.map((x) => x.rating), [5]);
  r = await call(app, "GET", "/api/admin/feedback?q=calm");
  assert.equal(r.json.total, 1);

  r = await call(app, "GET", "/api/admin/feedback?format=md");
  assert.match(String(r.headers["Content-Type"]), /text\/markdown/);
  assert.match(r.raw, /^# Vision 360 feedback — 2 items/);
  assert.match(r.raw, /> Assessment: too many questions/);
  assert.match(r.raw, /Vision Assessment/);

  // Deleting the conversation keeps its feedback.
  await call(app, "POST", "/api/admin/conversations/delete", { ids: [a.id], confirm: "DELETE" });
  r = await call(app, "GET", "/api/admin/feedback?tool=assistant");
  assert.equal(r.json.total, 1);
  assert.equal(r.json.items[0].conversation_exists, false);
  assert.match(r.json.items[0].markdown, /\(deleted\)/);

  // Deleting feedback needs DELETE typed.
  const id = r.json.items[0].id;
  assert.equal((await call(app, "POST", "/api/admin/feedback/delete", { ids: [id] })).status, 400);
  assert.equal((await call(app, "POST", "/api/admin/feedback/delete", { ids: [id], confirm: "DELETE" })).json.deleted, 1);
  r = await call(app, "GET", "/api/admin/feedback");
  assert.equal(r.json.total, 1);

  const gated = await makeApp({ V360_ADMIN_SIGNIN: "on" });
  assert.equal((await call(gated, "GET", "/api/admin/feedback")).status, 401);
});

test("on Supabase, feedback upserts by conversation and deletes by id", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, prefer: init.headers.Prefer || "", body: init.body ? JSON.parse(init.body) : null });
    const isList = init.method === "GET";
    return new Response(JSON.stringify(isList ? [] : [{ id: "11111111-1111-1111-1111-111111111111" }]), { status: 200, headers: { "content-range": "0-0/0" } });
  };
  const fs = createFeedbackStore({ env: { V360_SUPABASE_URL: "https://x.supabase.co", V360_SUPABASE_SERVICE_KEY: "sb_secret_test" }, store: null, fetch });
  assert.equal(fs.kind, "supabase");
  await fs.upsert({ session_id: "abc", tool: "assistant", text: "Hi" });
  assert.match(calls[0].url, /\/rest\/v1\/feedback\?on_conflict=session_id$/);
  assert.match(calls[0].prefer, /resolution=merge-duplicates/);
  assert.equal(calls[0].body.text, "Hi");
  await fs.remove(["11111111-1111-1111-1111-111111111111"]);
  assert.match(calls[1].url, /feedback\?id=in\.\(11111111-1111-1111-1111-111111111111\)$/);
  assert.equal(calls[1].method, "DELETE");
  await fs.list({ tool: "assessment", rating: 3 });
  assert.match(calls[2].url, /skipped=eq\.false.*tool=eq\.assessment.*rating=eq\.3/);
});

test("the connector lists feedback with its Markdown", async () => {
  const app = await makeApp();
  const s = await startSession(app);
  await call(app, "POST", `/api/session/${s.id}/feedback`, { text: "Loved the voice", rating: 5 }, bearer(s));
  const r = await call(app, "POST", "/api/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_feedback", arguments: {} } });
  const data = r.json.result.structuredContent || JSON.parse(r.json.result.content[0].text);
  assert.equal(data.total, 1);
  assert.match(data.markdown, /> Loved the voice/);
});

test("cleanFeedback and the spoken rating parser", () => {
  assert.deepEqual(cleanFeedback({ text: "  hi \r\n there ", rating: "3" }), { text: "hi \n there", rating: 3 });
  const { P } = voicePhrases();
  assert.equal(P.parseRating("four"), 4);
  assert.equal(P.parseRating("4"), 4);
  assert.equal(P.parseRating("five out of five"), 5);
  assert.equal(P.parseRating("I'd give it a three"), 3);
  assert.equal(P.parseRating("skip"), "skip");
  assert.equal(P.parseRating("it was fine"), null);
  assert.match(feedbackMarkdown([]), /0 items/);
});
